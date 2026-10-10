/**
 * L'EXÉCUTANT des synchros externes dans la boîte noire — contrat
 * `source-externe-1` § 6.5, § 6.8, § 8.1, § 9.
 *
 * La boîte lit les définitions dans `schema.extra.extSource` des magasins qui lui
 * sont ouverts, retient celles qui la désignent (`runner.accessId`), vérifie leur
 * SIGNATURE par le créateur de l'accès (clé authentifiée par `creatorTag`), son
 * palier et sa clé, puis les planifie. Un passage, dans l'ordre du contrat :
 *  1. bail pris ou renouvelé ; décisions de la boîte aux lettres relevées ;
 *  2. Filarr lu (la réplique est à jour) ; ombre et file ouvertes (sous `K_shadow`) ;
 *  3. la source lue : entière (sans ombre, sans repère, toutes les 24 h ou tous
 *     les 96 passages) ou depuis le repère, PLUS une lecture ciblée de chaque
 *     ligne changée côté Filarr ;
 *  4. `planPass` (pur) ; 5. garde-fous : arrêt avant toute écriture ;
 *  6. écritures dans la source sous condition, relecture, écho ;
 *  7. UNE validation dans Filarr — un registre qui a bougé pendant le passage
 *     n'est jamais écrasé (il sera un cas E au passage suivant) ;
 *  8. ombre, file et journal enregistrés ensemble, puis état et file publiés
 *     (scellés sous `K_xs`), puis décisions acquittées.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import {
  applyClocks,
  applyEcho,
  applySourceResults,
  canonicalKey,
  filarrChangedKeys,
  JOURNAL_DAYS,
  JOURNAL_MAX,
  openJson,
  planPass,
  queueAad,
  resolveAad,
  sealJson,
  shadowAad,
  shadowKey,
  sourceIdentity,
  statusAad,
  statusKey,
  toFilarr,
  validateDef,
  valueHash,
  verifyDefSignature,
  withMintedOptions,
  type Decision,
  type ExtSourceDef,
  type FilarrRow,
  type PassPlan,
  type PropSpec,
  type QueueEntry,
  type SchemaLike,
  type Shadow,
  type SourceRow,
  type SyncJournalEntry,
  type SyncStatus,
} from '../../../core/src/engine/extsrc';
import type { StoreSchema } from '../../../core/src/engine/store/codec';
import { FIELD_CREATED, FIELD_ORDER, type StoreOp } from '../../../core/src/engine/store/registers';
import { positionBetween } from '../../../core/src/engine/store/fracIndex';
import type { StoreKeys } from '../../../core/src/engine/store/crypto';
import { curves, storeCrypto } from '../../../gate/src/crypto/providers';
import { FilarrError, RateLimitError, UnreachableError } from '../../../gate/src/replica/http';
import { randomToken } from '../../../gate/src/util/bytes';
import type { GateBase } from '../../../gate/src/replica/replicator';
import type { GateCore } from '../core';
import { ConnectorError, openConnector, type Connector } from './connectors';
import { SecretStore } from './secrets';
import type { SyncRecord } from '../state';

/** Où l'exécutant range l'ombre chiffrée (fichiers 0600, stockage d'un objet durable, mémoire). */
export interface BlobStore {
  get(name: string): Promise<Uint8Array | null>;
  put(name: string, data: Uint8Array): Promise<void>;
  delete(name: string): Promise<void>;
}

export const memoryBlobs = (): BlobStore & { map: Map<string, Uint8Array> } => {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    get: async (n) => map.get(n) ?? null,
    put: async (n, d) => void map.set(n, d),
    delete: async (n) => void map.delete(n),
  };
};

export interface SyncHostOptions {
  blobs: BlobStore;
  /** PostgreSQL et MySQL (TCP) : Node seulement. */
  tcp: boolean;
  loadDriver?: (name: 'pg' | 'mysql2/promise') => Promise<unknown>;
  fetch?: typeof fetch;
  /** Les clés venues de l'environnement ou de `gate.toml`. */
  externalSecret?: (defId: string) => string | null;
  /** Planifier par des minuteries internes (Node) ; sinon l'hôte appelle `runDue()` (alarmes). */
  timers?: boolean;
  /** Pour les essais : la gigue de ± 10 % des intervalles. */
  jitter?: boolean;
  /** Pour les essais : l'attente entre deux appels d'un service limité. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * L'INSTANCE de cet exécutant (`source-externe-1`, précision P1) : 16 à 64 caractères
   * `[A-Za-z0-9_-]`. Absente : tirée au hasard ici, au démarrage du processus — deux conteneurs
   * lancés avec le même jeton partagent `a:<accessId>`, et c'est elle qui les distingue au bail.
   * Un hôte UNIQUE par construction (l'objet durable de la variante Cloudflare, qui s'endort et
   * se réveille sans cesser d'être le même exécutant) la garde dans son stockage et la passe ici.
   */
  instance?: string;
}

/** L'instance d'un exécutant (P1). */
export const INSTANCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Une instance neuve : 128 bits, en base64url (22 caractères). */
export const newInstance = (): string => randomToken(16);

/** Ce que la boîte sait d'une définition qui la désigne. */
export interface SourceInfo {
  def: ExtSourceDef;
  storeId: string;
  base: string | null;
  /** `null` : exécutable ; sinon le code d'état qui l'empêche (§ 9.3, § 2.2). */
  blocked: string | null;
  detail: string | null;
  keySource: 'env' | 'state' | null;
  record: SyncRecord;
  status: SyncStatus | null;
  running: boolean;
}

interface Persisted {
  shadow: Shadow | null;
  queue: QueueEntry[];
  journal: SyncJournalEntry[];
  identity: string;
}

const EVERY_MS: Record<string, number> = { '15m': 15 * 60_000, '1h': 3_600_000, '1d': 86_400_000 };
const FULL_EVERY_MS = 86_400_000;
const FULL_EVERY_PASSES = 96;
const MAX_CONCURRENT = 2;
const ROW_LIMIT = 100_000;
const PAID = new Set(['solo', 'pro', 'teams', 'enterprise']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Le journal d'une synchro tel qu'il est gardé (§ 6.10) : 30 jours, 200 entrées au plus, les plus anciennes partent d'abord. */
function trimJournal(journal: readonly SyncJournalEntry[], now = Date.now()): SyncJournalEntry[] {
  const cutoff = new Date(now - JOURNAL_DAYS * 86_400_000).toISOString();
  return journal.filter((j) => j.at >= cutoff).slice(-JOURNAL_MAX);
}

/**
 * La ligne du journal local pour un passage arrêté par un garde-fou (§ 6.9) : la cause, ce qui était
 * PRÉVU (lu dans la question, jamais dans des écritures) et ce qui a été fait, rien.
 */
function stopNote(def: ExtSourceDef, stop: NonNullable<PassPlan['stop']>): string {
  const q = stop.question;
  if (stop.code === 'extdb_guard') {
    const g = def.guard ?? { pct: 20, min: 10 };
    return `garde-fou : ${Number(q.gone ?? 0)} lignes sur ${Number(q.total ?? 0)} seraient marquées ou supprimées d’un coup (seuil ${g.pct} %, au moins ${g.min}) ; arrêt avant toute écriture, rien n’a été écrit`;
  }
  return `trop de conflits d’un coup : ${Number(q.n ?? 0)} conflits nouveaux${q.initial === true ? ' au premier passage' : ''} ; arrêt avant toute écriture, rien n’a été écrit`;
}

/** La prochaine heure `HH:MM` dans un fuseau (planification `1d`). */
export function nextDaily(at: string, tz: string, now = Date.now()): number {
  const m = /^(\d{2}):(\d{2})$/.exec(at);
  const [hh, mm] = m ? [Number(m[1]), Number(m[2])] : [6, 0];
  const offsetAt = (ms: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(ms / 1000) * 1000;
  };
  for (let day = 0; day < 3; day += 1) {
    const local = new Date(now + offsetAt(now));
    const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, hh, mm) - offsetAt(now);
    if (target > now) return target;
  }
  return now + 86_400_000;
}

export class SyncRunner {
  readonly secrets: SecretStore;
  private readonly sources = new Map<string, SourceInfo>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = 0;
  private readonly queued = new Map<string, { ack: Record<string, unknown> | null }>();
  private readonly onChangeAt = new Map<string, number>();
  private readonly ownSeq = new Map<string, number>();
  private stopped = false;
  /** L'instance de ce processus, envoyée avec chaque bail (P1). */
  readonly instance: string;
  /** Les baux que CETTE instance tient (définition → magasin), rendus à l'arrêt. */
  private readonly held = new Map<string, string>();

  constructor(
    private readonly core: GateCore,
    private readonly host: SyncHostOptions
  ) {
    this.instance = host.instance && INSTANCE_RE.test(host.instance) ? host.instance : newInstance();
    this.secrets = new SecretStore(core, host.externalSecret ?? (() => null));
    const r = core.replicator;
    r.on('bases', () => void this.scan());
    r.on('self', () => void this.scan());
    r.on('change', (base: GateBase) => {
      void this.scan();
      this.onCommit(base.storeId, base.mirror.seq);
    });
    r.on('ext-run', (msg: { storeId: string; defId: string | null; ack: Record<string, unknown> | null }) => {
      for (const s of this.sources.values()) {
        if (s.storeId === msg.storeId && (msg.defId === null || s.def.id === msg.defId)) this.request(s.def.id, msg.ack);
      }
    });
    // Les ombres voyagent dans le paquet de réglages d'une migration (gate-heberge-1 § 8.6)
    core.syncShadows = () => this.exportShadows();
    core.restoreSyncShadows = (list) => void this.importShadows(list);
  }

  // ==================== Découverte et état ====================

  /** Les définitions qui désignent cette boîte, avec ce qui les empêche de tourner. */
  list(): SourceInfo[] {
    return [...this.sources.values()].sort((a, b) => a.def.name.localeCompare(b.def.name));
  }

  get(defId: string): SourceInfo | undefined {
    return this.sources.get(defId);
  }

  private record(defId: string, storeId: string): SyncRecord {
    const d = this.core.state.data;
    return (d.sync[defId] ??= { defId, storeId, paused: false, lastRunAt: null, lastOkAt: null, nextRunAt: null, failures: 0, statusRev: 0, queueRev: 0, resolvedUpTo: 0 });
  }

  /** Relit les définitions des magasins ouverts (à chaque changement de droits, de manifeste ou de schéma). */
  async scan(): Promise<void> {
    const r = this.core.replicator;
    const identity = r.identity;
    if (!identity) return;
    const seen = new Set<string>();
    for (const base of r.bases.values()) {
      const raw = (base.mirror.head?.schema.extra as Record<string, unknown> | undefined)?.extSource;
      if (!isObj(raw)) continue;
      const def = raw as unknown as ExtSourceDef;
      const runner = def.runner as { kind?: string; accessId?: string } | undefined;
      if (!runner || (runner.kind !== 'gate' && runner.kind !== 'hosted') || runner.accessId !== identity.accessId) continue;
      if (typeof def.id !== 'string') continue;
      seen.add(def.id);
      const record = this.record(def.id, base.storeId);
      const [blocked, detail] = await this.blockReason(def, base);
      const prev = this.sources.get(def.id);
      this.sources.set(def.id, {
        def,
        storeId: base.storeId,
        base: base.manifest?.slug ?? null,
        blocked,
        detail,
        keySource: this.secrets.source(def.id),
        record,
        status: prev?.status ?? null,
        running: prev?.running ?? false,
      });
      if (!prev || prev.def.rev !== def.rev) {
        if (!record.nextRunAt || prev) record.nextRunAt = this.nextRunAfter(def, Date.now(), true);
        this.core.journal.add({ kind: 'sync', who: 'synchro', what: `définition ${prev ? 'modifiée' : 'trouvée'} · ${def.name}`, code: blocked ?? 'prête', ...(detail ? { note: detail } : {}) });
      }
    }
    for (const [defId, s] of this.sources) {
      if (!seen.has(defId)) {
        this.sources.delete(defId);
        void this.releaseLease(s).catch(() => undefined);
        this.core.journal.add({ kind: 'sync', who: 'synchro', what: `définition retirée · ${s.def.name}`, code: 'arrêtée' });
      }
    }
  }

  private async blockReason(def: ExtSourceDef, base: GateBase): Promise<[string | null, string | null]> {
    const r = this.core.replicator;
    if (typeof def.v === 'number' && def.v > 1) return ['extdb_def_newer', 'définition d’une version plus récente : rien n’est exécuté'];
    if (def.mode === 'once') return ['extdb_not_runner', 'import ponctuel : il se fait depuis l’appli'];
    const propTypes = Object.fromEntries((base.mirror.head?.schema.properties ?? []).map((p) => [p.id, p.type]));
    const codes = validateDef(def, { propTypes });
    if (codes.includes('conflict_policy_missing') || codes.includes('row_conflict_missing')) return ['extdb_policy_missing', codes.join(', ')];
    if (codes.length > 0) return ['extdb_def_invalid', codes.join(', ')];
    // § 8.3 : signée par le CRÉATEUR de l'accès, clé authentifiée par son étiquette
    if (r.creator.status !== 'authenticated' || !r.creator.signingPublicKey) return ['extdb_unsigned', `clé du créateur ${r.creator.status === 'untagged' ? 'sans étiquette (remplacer le jeton)' : 'non authentifiée'}`];
    if (def.signer !== r.creator.userId || !verifyDefSignature(curves, def, r.creator.signingPublicKey)) return ['extdb_unsigned', `en attente de la signature du créateur de l’accès`];
    const tier = String(r.access?.tier ?? 'free');
    if (!PAID.has(tier)) return ['extdb_tier', `synchro planifiée à partir de Solo (palier ${tier})`];
    if (!this.host.tcp && (def.connector === 'postgres' || def.connector === 'mysql')) return ['extdb_unreachable', 'connecteur TCP indisponible ici (https seulement)'];
    if (!(await this.secrets.get(def.id))) return ['extdb_key_missing', `clé manquante pour ${def.host}`];
    if (this.core.state.data.sync[def.id]?.paused) return ['paused', 'mise en pause dans la boîte'];
    return [null, null];
  }

  // ==================== Planification ====================

  /** La prochaine heure d'un passage (`manual` : jamais d'office). */
  nextRunAfter(def: ExtSourceDef, now: number, soon = false): string | null {
    const every = def.schedule?.every;
    if (every === 'manual') return null;
    if (soon) return new Date(now + 1000).toISOString();
    if (every === '1d' && def.schedule.at) return new Date(nextDaily(def.schedule.at, def.schedule.tz ?? 'UTC', now)).toISOString();
    const base = EVERY_MS[every ?? '1h'] ?? 3_600_000;
    const jitter = this.host.jitter === false ? 1 : 0.9 + Math.random() * 0.2;
    return new Date(now + Math.round(base * jitter)).toISOString();
  }

  /** Un passage demandé (« Lancer », `ext-run`, réveil) : au plus tôt. */
  request(defId: string, ack: Record<string, unknown> | null = null): void {
    this.queued.set(defId, { ack });
    void this.runDue();
  }

  private onCommit(storeId: string, seq: number): void {
    for (const s of this.sources.values()) {
      if (s.storeId !== storeId || !s.def.schedule?.onChange || (s.def.mode !== 'publish' && s.def.mode !== 'both')) continue;
      if (this.ownSeq.get(s.def.id) === seq) continue; // notre propre validation
      const last = this.onChangeAt.get(s.def.id) ?? 0;
      const at = Math.max(Date.now() + 10_000, last + 30_000);
      this.onChangeAt.set(s.def.id, at);
      s.record.nextRunAt = new Date(Math.min(at, Date.parse(s.record.nextRunAt ?? new Date(at).toISOString()))).toISOString();
    }
  }

  start(): void {
    this.stopped = false;
    void this.scan();
    if (this.host.timers !== false && !this.timer) {
      this.timer = setInterval(() => void this.runDue(), 5000);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /**
   * Arrête la planification et REND les baux de cette instance (P1) : un processus arrêté
   * proprement ne laisse pas ses synchros bloquées jusqu'à l'échéance du bail (le processus
   * suivant, ou `filarr-gate sources run`, est une AUTRE instance). Un passage en cours garde le
   * sien : le rendre laisserait une autre instance écrire pendant ses dernières écritures ; il
   * échoira. Cinq secondes au plus : Filarr injoignable ne retient pas l'arrêt.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const leases = [...this.held].filter(([defId]) => !this.sources.get(defId)?.running);
    if (leases.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(leases.map(([defId, storeId]) => this.releaseLease({ storeId, def: { id: defId } }))),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }

  /** Un passage tourne ou attend son tour. */
  get busy(): boolean {
    return this.running > 0 || this.queued.size > 0;
  }

  /** La prochaine heure où un passage est dû (pour une alarme d'objet durable). */
  nextWake(): number | null {
    let min: number | null = null;
    for (const s of this.sources.values()) {
      if (s.blocked) continue;
      const t = s.record.nextRunAt ? Date.parse(s.record.nextRunAt) : null;
      if (t !== null && (min === null || t < min)) min = t;
    }
    return this.queued.size > 0 ? Date.now() : min;
  }

  /** Lance les passages dus (2 au plus en même temps). */
  async runDue(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const due = this.list().filter((s) => !s.running && (this.queued.has(s.def.id) || (!s.blocked && s.record.nextRunAt !== null && Date.parse(s.record.nextRunAt) <= now)));
    const work: Array<Promise<unknown>> = [];
    for (const s of due) {
      if (this.running >= MAX_CONCURRENT) break;
      const req = this.queued.get(s.def.id);
      this.queued.delete(s.def.id);
      work.push(this.runPass(s.def.id, { ack: req?.ack ?? null }).catch(() => undefined));
    }
    await Promise.all(work);
  }

  // ==================== Un passage ====================

  private runnerId(): string {
    return `a:${this.core.replicator.identity?.accessId ?? ''}`;
  }

  private base(storeId: string): GateBase | undefined {
    return this.core.replicator.bases.get(storeId);
  }

  /**
   * Prendre ou renouveler le bail (§ 6.8), au nom de CETTE instance (P1). Tenu ailleurs — un autre
   * exécutant, ou un autre processus lancé avec le même jeton — : `{ ok: false }`, avec l'échéance
   * que Filarr donne.
   */
  private async lease(s: SourceInfo): Promise<{ ok: true } | { ok: false; until: string | null }> {
    const client = this.core.replicator.client!;
    const every = EVERY_MS[s.def.schedule?.every ?? '1h'] ?? 3_600_000;
    const ttlS = Math.min(3600, Math.max(120, Math.round((2 * every) / 1000)));
    try {
      await client.json('POST', `dbstore/${s.storeId}/ext-lease`, { defId: s.def.id, runnerId: this.runnerId(), instance: this.instance, ttlS });
      this.held.set(s.def.id, s.storeId);
      return { ok: true };
    } catch (err) {
      if (err instanceof FilarrError && err.code === 'extdb_lease_held') {
        this.held.delete(s.def.id);
        return { ok: false, until: typeof err.body.until === 'string' ? err.body.until : null };
      }
      throw err;
    }
  }

  /** Rendre le bail de CETTE instance (Filarr ignore la demande d'une autre). */
  private async releaseLease(s: { storeId: string; def: { id: string } }): Promise<void> {
    this.held.delete(s.def.id);
    const path = `dbstore/${s.storeId}/ext-lease/${encodeURIComponent(s.def.id)}?instance=${encodeURIComponent(this.instance)}`;
    await this.core.replicator.client?.json('DELETE', path).catch(() => undefined);
  }

  /** Les clés d'un magasin que la boîte tient, la courante d'abord. */
  private keysOf(base: GateBase): StoreKeys[] {
    const current = (() => {
      try {
        return base.mirror.writeKeys();
      } catch {
        return null;
      }
    })();
    const all = [...base.mirror.keys.values()].sort((a, b) => b.generation - a.generation || b.epoch - a.epoch);
    return current ? [current, ...all.filter((k) => k !== current)] : all;
  }

  private blobName(s: { storeId: string; def: ExtSourceDef }): string {
    return `shadow-${s.storeId}-${s.def.id}`;
  }

  private async loadPersisted(s: SourceInfo, base: GateBase, identity: string): Promise<Persisted> {
    const empty: Persisted = { shadow: null, queue: [], journal: [], identity };
    const bytes = await this.host.blobs.get(this.blobName(s)).catch(() => null);
    if (!bytes) return empty;
    try {
      const env = JSON.parse(new TextDecoder().decode(bytes)) as { v: number; e: number; g: number; sealed: string };
      const k = this.keysOf(base).find((x) => x.epoch === env.e && x.generation === env.g);
      if (!k) return empty;
      const key = await shadowKey(storeCrypto, k.kDb, s.storeId, s.def.id);
      const p = await openJson<Persisted>(storeCrypto, key, env.sealed, shadowAad(s.storeId, s.def.id));
      // Une autre source (connecteur, table) : l'ombre ne vaut plus rien
      if (p.identity !== identity) return { ...empty, journal: p.journal ?? [] };
      return { shadow: p.shadow, queue: p.queue ?? [], journal: p.journal ?? [], identity };
    } catch {
      return empty;
    }
  }

  private async savePersisted(s: SourceInfo, base: GateBase, p: Persisted): Promise<void> {
    // Coupé AVANT l'écriture (passage réussi comme arrêté) : coupé seulement à la publication, le journal
    // relu au passage suivant serait l'entier et l'ombre chiffrée grossirait sans fin
    p.journal = trimJournal(p.journal);
    const k = this.keysOf(base)[0];
    if (!k) return;
    const key = await shadowKey(storeCrypto, k.kDb, s.storeId, s.def.id);
    const sealed = await sealJson(storeCrypto, key, p, shadowAad(s.storeId, s.def.id));
    await this.host.blobs.put(this.blobName(s), new TextEncoder().encode(JSON.stringify({ v: 1, e: k.epoch, g: k.generation, sealed })));
  }

  /**
   * La boîte aux lettres des décisions (§ 6.12), dans l'ordre du serveur : `{ decisions, next }`
   * (précision P6 — la forme du worker fait foi ; `next` : où reprendre, `null` à la dernière page).
   * Dix pages de 500 au plus par passage, le reste au suivant.
   */
  private async fetchDecisions(s: SourceInfo, base: GateBase): Promise<Decision[]> {
    const client = this.core.replicator.client!;
    const out: Decision[] = [];
    let after = s.record.resolvedUpTo;
    for (let page = 0; page < 10; page += 1) {
      const res = await client.json<{ decisions?: Array<{ seq: number; sealed: string }>; next?: number | null }>(
        'GET',
        `dbstore/${s.storeId}/ext-resolve/${encodeURIComponent(this.runnerId())}?after=${after}`
      );
      const items = Array.isArray(res.decisions) ? res.decisions : [];
      const from = after;
      for (const it of items) {
        after = Math.max(after, it.seq);
        for (const k of this.keysOf(base)) {
          try {
            const kxs = await statusKey(storeCrypto, k.kDb, s.storeId);
            const d = await openJson<Omit<Decision, 'seq'>>(storeCrypto, kxs, it.sealed, resolveAad(s.storeId, this.runnerId()));
            out.push({ ...d, seq: it.seq });
            break;
          } catch {
            /* une autre clé */
          }
        }
      }
      // La dernière page (`next: null`), ou un curseur qui n'avance pas : on s'arrête
      if (typeof res.next !== 'number' || res.next <= from) break;
      after = Math.max(after, res.next);
    }
    return out;
  }

  private filarrRows(base: GateBase): FilarrRow[] {
    const out: FilarrRow[] = [];
    for (const [id, regs] of Object.entries(base.mirror.allRegisters())) {
      const r: FilarrRow = { id, deleted: regs['#d']?.v === true, regs: {} };
      for (const [f, reg] of Object.entries(regs)) r.regs[f] = { v: reg.v, t: reg.t };
      out.push(r);
    }
    return out;
  }

  private props(base: GateBase): Record<string, PropSpec> {
    return Object.fromEntries((base.mirror.head?.schema.properties ?? []).map((p) => [p.id, { id: p.id, type: p.type, ...(p.options ? { options: p.options as unknown as PropSpec["options"] } : {}) }]));
  }

  /**
   * Un passage. `ack` : l'accord d'un membre pour CE passage (`guard`, ou `initial`
   * au premier passage, § 6.9).
   */
  async runPass(defId: string, opts: { ack?: Record<string, unknown> | null } = {}): Promise<SyncStatus | null> {
    const s = this.sources.get(defId);
    if (!s || s.running) return s?.status ?? null;
    const base = this.base(s.storeId);
    if (!base) return null;
    s.running = true;
    this.running += 1;
    const started = new Date().toISOString();
    const passId = `x${Date.now().toString(36)}`;
    let connector: Connector | null = null;
    let persisted: Persisted | null = null;
    const identity = sourceIdentity(s.def, sha256);
    try {
      [s.blocked, s.detail] = await this.blockReason(s.def, base);
      s.keySource = this.secrets.source(defId);
      if (s.blocked) return await this.finish(s, base, null, { state: s.blocked === 'paused' ? 'paused' : 'waiting', code: s.blocked === 'paused' ? null : s.blocked, detail: s.detail }, passId);
      // Le bail : tenu par une autre instance (un second processus lancé avec ce jeton), on attend
      // sans rien lire ni écrire, et le journal le dit (§ 6.8, P1)
      const lease = await this.lease(s);
      if (!lease.ok) {
        const detail = `une autre instance de cette boîte noire exécute déjà cette synchro${lease.until ? ` (bail tenu jusqu’à ${lease.until})` : ''} ; cette instance : ${this.instance.slice(0, 6)}…`;
        return await this.finish(s, base, null, { state: 'waiting', code: 'extdb_lease_held', detail }, passId);
      }
      const decisions = await this.fetchDecisions(s, base);
      await base.mirror.sync();
      const filarr = this.filarrRows(base);
      persisted = await this.loadPersisted(s, base, identity);
      const shadow = persisted.shadow;
      const props = this.props(base);
      // La source : entière, ou depuis le repère plus les lignes changées côté Filarr
      const secret = (await this.secrets.get(defId))!;
      const fetchImpl = this.host.fetch ?? fetch;
      connector = await openConnector(
        {
          def: s.def,
          secret,
          // Appelée comme méthode d'un objet : enveloppée (sous Workers, `fetch` détachée lève)
          fetch: (input, init) => fetchImpl(input, init),
          loadDriver: this.host.loadDriver ?? (async (n) => import(/* @vite-ignore */ n)),
          props,
          ...(this.host.sleep ? { sleep: this.host.sleep } : {}),
        },
        { tcp: this.host.tcp }
      );
      const full =
        !shadow ||
        !s.def.marker ||
        shadow.passes >= FULL_EVERY_PASSES ||
        !shadow.fullAt ||
        Date.now() - Date.parse(shadow.fullAt) >= FULL_EVERY_MS ||
        shadow.marker === null;
      let rows: SourceRow[];
      if (full) rows = await connector.readAll();
      else {
        rows = await connector.readSince(shadow!.marker!);
        const have = new Set(rows.map((r) => canonicalKey(s.def.key.cols.map((c) => r.raw[c]))));
        const targeted = filarrChangedKeys(s.def, shadow, filarr).filter((k) => !have.has(k));
        if (targeted.length > 0) {
          const kv = targeted.map((k) => Object.fromEntries(s.def.key.cols.map((c, i) => [c, k.split('\u001f')[i]])));
          rows = [...rows, ...(await connector.readKeys(kv))];
        }
      }
      if (rows.length > ROW_LIMIT) return await this.finish(s, base, persisted, { state: 'error', code: 'extdb_too_large', detail: `${rows.length} lignes (100 000 au plus)` }, passId);
      let plan = planPass({
        def: s.def,
        identity,
        props,
        shadow,
        queue: persisted.queue,
        decisions,
        source: { rows, full },
        filarr,
        now: started,
        passId,
        ack: opts.ack ? { ...(typeof opts.ack.initial === 'string' ? { initial: opts.ack.initial as 'source' | 'filarr' } : {}), ...(typeof opts.ack.guard === 'string' ? { guard: opts.ack.guard } : {}) } : null,
        sha256,
      });
      if (plan.stop) {
        // 5. Garde-fou : rien n'est écrit, l'ombre et la file restent celles d'avant. Le journal du plan ne
        // porte que l'arrêt (et les lignes laissées de côté à la lecture) ; il est enregistré pour que
        // l'arrêt reste au journal de la synchro après le passage suivant, accordé ou non
        persisted.journal = [...persisted.journal, ...plan.journal];
        await this.savePersisted(s, base, persisted);
        return await this.finish(s, base, persisted, { state: 'question', code: plan.stop.code, question: plan.stop.question, plan, detail: stopNote(s.def, plan.stop) }, passId);
      }
      // 6. La source : sous condition, relecture, écho
      if (plan.toSource.length > 0) {
        const res = await connector.write(plan.toSource);
        plan = applySourceResults(plan, res.failed);
        const byId = new Map(filarr.map((r) => [r.id, r]));
        const echoes: Array<{ key: string; col: string; rowId: string; prop: string; value: unknown }> = [];
        for (const op of plan.toSource) {
          if (op.kind !== 'update') continue;
          const raw = res.reread.get(op.key);
          if (!raw) continue;
          const prop = props[op.prop];
          if (!prop) continue;
          const relu = toFilarr(raw[op.col], prop, { createOptions: false, sha256 });
          const vF = byId.get(op.rowId)?.regs[op.prop]?.v ?? null;
          if (valueHash(sha256, relu) !== valueHash(sha256, vF)) echoes.push({ key: op.key, col: op.col, rowId: op.rowId, prop: op.prop, value: relu });
        }
        if (echoes.length > 0) plan = applyEcho(plan, echoes, sha256);
        // Lignes insérées dans la source : la clé relue (ou tirée par l'exécutant) revient dans Filarr
        const keyMap = s.def.map.filter((m) => s.def.key.cols.includes(m.col));
        for (const ins of res.inserted) {
          if (!ins.keyValues) continue;
          const key = canonicalKey(s.def.key.cols.map((c) => ins.keyValues![c]));
          if (key === null) continue;
          const f = byId.get(ins.rowId);
          const cells: Record<string, { h: string; t: string | null }> = {};
          for (const m of s.def.map) {
            const prop = props[m.prop];
            if (!prop) continue;
            if (s.def.key.cols.includes(m.col)) {
              const v = toFilarr(ins.keyValues[m.col], prop, { createOptions: false, sha256 });
              plan.pendingClocks[`${key}|${m.col}`] = plan.toFilarr.length;
              plan.toFilarr.push({ r: ins.rowId, f: m.prop, v });
              cells[m.col] = { h: valueHash(sha256, v), t: null };
            } else {
              const reg = f?.regs[m.prop];
              cells[m.col] = { h: valueHash(sha256, reg?.v ?? null), t: reg?.t ?? null };
            }
          }
          void keyMap;
          plan.shadow.rows[key] = { id: ins.rowId, cells };
        }
      }
      // 7. Filarr : une validation ; un registre qui a bougé pendant le passage n'est pas écrasé
      const ticks = await this.commitFilarr(s, base, plan, filarr, started);
      const nextShadow = applyClocks(plan, ticks);
      // 8. Ombre, file et journal ensemble ; puis état, file, acquittement
      persisted = { shadow: nextShadow, queue: plan.queue, journal: [...persisted.journal, ...plan.journal], identity };
      await this.savePersisted(s, base, persisted);
      const status = await this.finish(s, base, persisted, { state: 'ok', code: plan.queue.length > 0 ? (plan.overflow > 0 ? 'extdb_queue_full' : 'extdb_conflicts_pending') : null, plan }, passId);
      const upTo = plan.handledDecisions.length > 0 ? Math.max(...plan.handledDecisions) : 0;
      if (upTo > s.record.resolvedUpTo) {
        await this.core.replicator.client!.json('DELETE', `dbstore/${s.storeId}/ext-resolve/${encodeURIComponent(this.runnerId())}?upTo=${upTo}`).catch(() => undefined);
        s.record.resolvedUpTo = upTo;
        this.core.state.save();
      }
      return status;
    } catch (err) {
      const code =
        err instanceof ConnectorError
          ? err.code
          : err instanceof RateLimitError && err.code === 'api_quota_writes'
            ? 'extdb_quota_writes'
            : err instanceof UnreachableError
              ? 'filarr_unreachable'
              : err instanceof FilarrError
                ? err.code
                : 'error';
      return await this.finish(s, base, persisted, { state: 'error', code, detail: (err as Error)?.message ?? String(err) }, passId);
    } finally {
      await connector?.close().catch(() => undefined);
      s.running = false;
      // Une relecture des définitions pendant le passage (`scan`, à chaque changement d'un magasin,
      // notre propre validation comprise) a remplacé la fiche en recopiant `running: true` : sans
      // ceci, la synchro resterait « en cours » et ne repasserait plus jamais
      const current = this.sources.get(defId);
      if (current && current !== s) {
        current.running = false;
        current.status = s.status;
      }
      this.running -= 1;
    }
  }

  /** La validation dans Filarr : les registres, la création des lignes, les options neuves. */
  private async commitFilarr(s: SourceInfo, base: GateBase, plan: PassPlan, filarr: readonly FilarrRow[], now: string): Promise<string[]> {
    if (plan.toFilarr.length === 0 && plan.minted.length === 0) return [];
    const seen = new Map(filarr.map((r) => [r.id, r]));
    const mirror = base.mirror;
    let ticks: string[] = [];
    const { seq } = await mirror.commit((attempt) => {
      ticks = [];
      const ops: StoreOp[] = [];
      // Sur un nouvel essai, l'état est relu : on retire ce qui a bougé depuis la lecture (§ 6.5, étape 7)
      const current = attempt > 0 ? mirror.allRegisters() : null;
      let order = mirror.lastOrder();
      const createdSet = new Set(plan.created);
      for (const id of plan.created) {
        if (current && current[id]) continue;
        order = positionBetween(order, null);
        ops.push({ r: id, f: FIELD_CREATED, v: now, t: mirror.tick() }, { r: id, f: FIELD_ORDER, v: order, t: mirror.tick() });
      }
      plan.toFilarr.forEach((op, i) => {
        if (current && !createdSet.has(op.r)) {
          const before = seen.get(op.r)?.regs[op.f]?.t ?? null;
          const now2 = current[op.r]?.[op.f]?.t ?? null;
          if (before !== now2) return;
        }
        const t = mirror.tick();
        ticks[i] = t;
        ops.push({ r: op.r, f: op.f, v: op.v, t });
      });
      const minted = plan.minted;
      return {
        ops,
        ...(minted.length > 0
          ? {
              schema: (schema: StoreSchema): StoreSchema | null => withMintedOptions(schema as StoreSchema & SchemaLike, minted, () => mirror.tick()),
            }
          : {}),
      };
    });
    this.ownSeq.set(s.def.id, seq);
    return ticks;
  }

  /** L'état publié (scellé sous `K_xs`, § 9.2), le journal local, la prochaine heure, les webhooks. */
  private async finish(
    s: SourceInfo,
    base: GateBase,
    persisted: Persisted | null,
    out: { state: SyncStatus['state']; code: string | null; detail?: string | null; question?: Record<string, unknown>; plan?: PassPlan },
    passId: string
  ): Promise<SyncStatus> {
    const now = new Date().toISOString();
    const rec = s.record;
    rec.lastRunAt = now;
    if (out.state === 'ok') {
      rec.lastOkAt = now;
      rec.failures = 0;
      rec.nextRunAt = this.nextRunAfter(s.def, Date.now());
    } else if (out.state === 'error' || out.code === 'extdb_lease_held') {
      rec.failures += 1;
      // 1, 2, 4… minutes jusqu'à 60, puis toutes les 60 minutes (§ 8.1)
      const delay = Math.min(60, 2 ** Math.min(rec.failures - 1, 6)) * 60_000;
      rec.nextRunAt = new Date(Date.now() + delay).toISOString();
    } else rec.nextRunAt = this.nextRunAfter(s.def, Date.now());
    this.core.state.save();
    const prev = s.status;
    const journal = trimJournal(persisted?.journal ?? prev?.journal ?? []);
    if (persisted) persisted.journal = journal;
    const plan = out.plan;
    const status: SyncStatus = {
      v: 1,
      def: s.def.id,
      defRev: s.def.rev,
      rev: rec.statusRev + 1,
      runner: this.runnerId(),
      runnerName: (s.def.runner as { name?: string }).name ?? this.core.replicator.access?.name?.toString() ?? 'Filarr Gate',
      where: this.core.replicator.hosting ? 'hosted' : 'self',
      state: out.state === 'ok' && (plan?.queue.length ?? 0) > 0 ? 'ok' : out.state,
      code: out.code,
      lastRunAt: rec.lastRunAt,
      lastOkAt: rec.lastOkAt,
      nextRunAt: rec.nextRunAt,
      counts: plan?.counts ?? prev?.counts ?? { rows: 0, in: { changed: 0, created: 0, gone: 0 }, out: { changed: 0, inserted: 0, deleted: 0 }, conflicts: 0 },
      queue: { n: plan?.queue.length ?? persisted?.queue.length ?? prev?.queue.n ?? 0, overflow: plan?.overflow ?? 0, rev: rec.queueRev },
      question: out.question ?? null,
      columns: Object.keys(persisted?.shadow?.unstable ?? {}).map((col) => ({ col, status: 'unstable' as const })),
      journal,
    };
    s.status = status;
    await this.publish(s, base, status, plan?.queue ?? null).catch((err) => {
      this.core.journal.add({ kind: 'error', who: 'synchro', what: `état non publié · ${s.def.name}`, code: (err as FilarrError)?.code ?? 'erreur' });
    });
    const label = `${s.def.name} · ${out.state}${out.code ? ` (${out.code})` : ''}`;
    this.core.journal.add({
      kind: out.state === 'error' ? 'error' : 'sync',
      who: 'synchro',
      what: `passage ${passId} · ${label}`,
      code: out.code ?? out.state,
      // Un passage arrêté dit sa cause et ce qui était prévu, jamais des écritures qui n'ont pas eu lieu
      ...(plan && !plan.stop ? { note: `Filarr ${plan.counts.in.changed + plan.counts.in.created} · source ${plan.counts.out.changed + plan.counts.out.inserted + plan.counts.out.deleted} · file ${plan.queue.length}` } : out.detail ? { note: out.detail } : {}),
    });
    this.core.webhooks.onSync(out.state === 'ok' ? 'sync.done' : 'sync.failed', { defId: s.def.id, name: s.def.name, base: s.base, state: status.state, code: status.code, counts: status.counts, queue: status.queue, at: now });
    return status;
  }

  /** `PUT ext-status` (et `ext-queue` quand elle a changé), en compare-and-swap sur `rev`. */
  private async publish(s: SourceInfo, base: GateBase, status: SyncStatus, queue: QueueEntry[] | null): Promise<void> {
    const client = this.core.replicator.client;
    const k = this.keysOf(base)[0];
    if (!client || !k) return;
    const kxs = await statusKey(storeCrypto, k.kDb, s.storeId);
    const runnerId = this.runnerId();
    const put = async (kind: 'ext-status' | 'ext-queue', rev: number, value: unknown, aad: string): Promise<number> => {
      const body = { rev, e: k.epoch, g: k.generation, sealed: await sealJson(storeCrypto, kxs, value, aad) };
      try {
        await client.json('PUT', `dbstore/${s.storeId}/${kind}/${encodeURIComponent(runnerId)}`, body);
        return rev;
      } catch (err) {
        if (err instanceof FilarrError && (err.code === 'ext_status_conflict' || err.code === 'ext_queue_conflict') && typeof err.body.rev === 'number') {
          const next = err.body.rev + 1;
          const again = { ...body, rev: next, sealed: await sealJson(storeCrypto, kxs, kind === 'ext-status' ? { ...(value as object), rev: next } : value, kind === 'ext-status' ? statusAad(s.storeId, runnerId, next) : queueAad(s.storeId, runnerId, next)) };
          await client.json('PUT', `dbstore/${s.storeId}/${kind}/${encodeURIComponent(runnerId)}`, again);
          return next;
        }
        throw err;
      }
    };
    if (queue) {
      const prevN = s.status?.queue.n ?? -1;
      const changed = queue.length !== prevN || queue.length > 0;
      if (changed) {
        s.record.queueRev = await put('ext-queue', s.record.queueRev + 1, { v: 1, def: s.def.id, entries: queue }, queueAad(s.storeId, runnerId, s.record.queueRev + 1));
        status.queue.rev = s.record.queueRev;
      }
    }
    s.record.statusRev = await put('ext-status', status.rev, status, statusAad(s.storeId, runnerId, status.rev));
    status.rev = s.record.statusRev;
    this.core.state.save();
  }

  // ==================== Gestes de l'administration ====================

  async setKey(defId: string, secret: string | null): Promise<void> {
    await this.secrets.set(defId, secret);
    await this.scan();
  }

  pause(defId: string, paused: boolean): void {
    const s = this.sources.get(defId);
    const rec = s ? s.record : this.core.state.data.sync[defId];
    if (!rec) throw new Error('synchro inconnue');
    rec.paused = paused;
    this.core.state.saveNow();
    void this.scan();
  }

  // ==================== Migration : les ombres voyagent (gate-settings-1) ====================

  exportShadows(): Array<{ def: string; rev: number; shadow: string }> {
    const out: Array<{ def: string; rev: number; shadow: string }> = [];
    for (const s of this.sources.values()) {
      const cached = this.lastBlobs.get(this.blobName(s));
      if (cached) out.push({ def: s.def.id, rev: s.def.rev, shadow: cached });
    }
    return out;
  }

  private readonly lastBlobs = new Map<string, string>();

  /** Garde une copie base64 des ombres (déjà chiffrées sous `K_shadow`) pour le paquet de réglages. */
  async cacheShadows(): Promise<void> {
    for (const s of this.sources.values()) {
      const b = await this.host.blobs.get(this.blobName(s)).catch(() => null);
      if (b) this.lastBlobs.set(this.blobName(s), btoa(String.fromCharCode(...b)));
    }
  }

  async importShadows(list: ReadonlyArray<{ def: string; rev: number; shadow: string; [k: string]: unknown }>): Promise<void> {
    for (const item of list) {
      const storeId = this.core.state.data.sync[item.def]?.storeId ?? [...this.core.replicator.bases.values()].find((b) => ((b.mirror.head?.schema.extra as Record<string, unknown> | undefined)?.extSource as { id?: string } | undefined)?.id === item.def)?.storeId;
      if (!storeId) continue;
      const bin = atob(item.shadow);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      await this.host.blobs.put(`shadow-${storeId}-${item.def}`, bytes).catch(() => undefined);
    }
  }
}
