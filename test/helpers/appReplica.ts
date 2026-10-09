// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/store/replica.ts @ e4a34700 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * LA RÉPLIQUE D'UN MAGASIN — le client de `db-store-1`, en cœur pur.
 *
 * Contrat `.filarr-parity/contracts/db-store-1.md`, § 9 et § 10. Ni React, ni
 * réseau, ni plateforme : le transport, le chiffrement, l'horloge et le journal
 * local sont INJECTÉS. Le bureau, le web et le mobile la prennent telle quelle.
 *
 *  · LIRE : la tête (ouverte sous l'époque la plus récente détenue), puis les
 *    seuls blocs dont la version a changé — chacun VÉRIFIÉ contre son `mac`
 *    avant d'être ouvert : un serveur ne peut ni substituer ni rejouer un bloc.
 *  · ÉCRIRE : une écriture locale (`StoreOp`, déjà horodatée) s'applique TOUT DE
 *    SUITE à la vue et attend dans le journal. La vidange regroupe le journal,
 *    réécrit les seuls blocs touchés (division au besoin), scelle une tête neuve
 *    et valide par compare-and-swap. Sur un conflit : relire, puis recommencer —
 *    les registres « dernier écrit gagne » font de la fusion une UNION.
 *  · Une écriture tapée PENDANT une vidange n'est pas perdue : la vidange ne
 *    retire du journal que ce qu'elle a validé.
 *  · LE CACHE LOCAL (§ 9 bis, précision 3.5) garde la dernière tête et ses blocs
 *    tels que le serveur les garde, chiffrés. Rouverts comme s'ils arrivaient du
 *    serveur, jamais adoptés partiels : hors ligne, la base s'affiche et s'édite,
 *    et son `seq` reste un plancher d'une session à l'autre.
 *  · Trois échecs distincts : INJOIGNABLE (`StoreUnreachableError`, levée par le
 *    transport : l'état en cache tient, `offline` le dit), REFUSÉ (toute autre
 *    erreur du transport) et NON VÉRIFIÉ (`StoreIntegrityError`).
 *  · LA GÉNÉRATION (précision 3.9, contrat `api-base-1` § 2) : chaque bloc se lit
 *    sous la clé que dit SON entrée (`e`, `g` absent = 0) ; la tête sous celle que
 *    dit le serveur (`hk`), à défaut sous chaque époque détenue. On écrit sous la
 *    génération COURANTE ; un `409 stale_generation` fait relire, resceller et
 *    rejouer. Un membre dérive toute génération de sa racine (`keyring.derive`).
 *    Rien ne change à `g = 0` : un serveur qui ne dit pas `g` est lu comme avant.
 *
 * Le source passe sous `strict` ET `noUncheckedIndexedAccess`.
 */

import type { DbRow } from '../../packages/core/src/types';
import {
  entryGeneration,
  headKeyBytes,
  isCover,
  layoutSlot,
  mergeSchema,
  merkleRoot,
  openHead,
  openHeadAnyEpoch,
  openSlot,
  placeHash,
  prefixFor,
  sealHead,
  slotJson,
  slotMac,
  splitRows,
  verifySlot,
  type LaidSlot,
  type SlotEntry,
  type StoreHead,
  type StoreSchema,
} from '../../packages/core/src/engine/store/codec';
import { newHeadKeys, type HeadKeys, type StoreCrypto, type StoreKeys } from '../../packages/core/src/engine/store/crypto';
import { evenPositions } from '../../packages/core/src/engine/store/fracIndex';
import { formatHlc, isHlc, type HlcClock } from '../../packages/core/src/engine/store/hlc';
import {
  applyOp,
  FIELD_ORDER,
  materializeRow,
  materializeRows,
  mergeRow,
  ownRegister,
  ownRow,
  rowToRegisters,
  type RowRegisters,
  type StoreOp,
  type StoreRows,
} from '../../packages/core/src/engine/store/registers';
import { headZones, type SlotZone } from '../../packages/core/src/engine/store/zones';

// ==================== Contrats injectés ====================

export interface SlotRef {
  p: string;
  ver: number;
}

/**
 * La clé d'une tête, ou d'un bloc : l'époque et la génération (précision 3.9).
 * `GET /dbstore/:id/head` rend `hk`, et `commit` le porte, sous cette forme.
 */
export interface HeadKeyRef {
  e: number;
  g: number;
}

export interface CommitSlot {
  p: string;
  ver: number;
  e: number;
  /** Génération du bloc (précision 3.9) : toujours la COURANTE, celle de `hk`. */
  g: number;
  body?: Uint8Array;
  stage?: string;
}

export interface CommitRequest {
  baseSeq: number;
  slots: CommitSlot[];
  removed: string[];
  head: Uint8Array;
  /** Sous quelle clé la tête neuve est scellée. */
  hk: HeadKeyRef;
}

export type CommitResponse =
  | { ok: true; seq: number }
  | { ok: false; code: 'seq_conflict'; seq: number }
  /** Un bloc ou la tête d'une autre génération : relire, resceller sous `g`, rejouer. */
  | { ok: false; code: 'stale_generation'; g: number }
  | { ok: false; code: string; detail?: string };

/** La tête telle que le serveur la rend : `hk` et `g` manquent chez un serveur d'avant 3.9. */
export interface RemoteHead {
  seq: number;
  head: Uint8Array | null;
  /** Sous quelle clé la tête est scellée. */
  hk?: HeadKeyRef;
  /** La génération COURANTE du magasin. */
  g?: number;
}

export type GenerationResponse =
  | { ok: true; g: number }
  | { ok: false; code: 'generation_conflict'; g: number };

/** Le serveur, vu du client (routes `/dbstore`, § 8). */
export interface StoreTransport {
  /** La tête courante ; `head` vaut `null` au seq 0. */
  head(): Promise<RemoteHead>;
  /** Des corps de blocs, par `p|ver` ; `null` pour une version introuvable. */
  slots(refs: SlotRef[]): Promise<Map<string, Uint8Array | null>>;
  /** Dépose un corps avant la validation ; rend son jeton. */
  stage(body: Uint8Array): Promise<string>;
  commit(request: CommitRequest): Promise<CommitResponse>;
  /**
   * Monte la génération du magasin de `from` à `from + 1`, en compare-and-swap
   * (précision 3.9). Réservé à une SESSION de membre, jamais à un accès API.
   */
  bumpGeneration?(from: number): Promise<GenerationResponse>;
}

/**
 * Le CACHE LOCAL d'un magasin (§ 9 bis) : la dernière tête et les corps de blocs,
 * CHIFFRÉS, tels que le serveur les garde. Jamais un clair, jamais une clé.
 */
export interface StoreCache {
  /**
   * La dernière tête rangée, le `seq` sous lequel elle est scellée, et sa clé
   * (`hk`, absente dans un cache d'avant 3.9).
   */
  head(): Promise<{ seq: number; head: Uint8Array; hk?: HeadKeyRef } | null>;
  /** Les corps rangés parmi `refs`, par `p|ver` (un corps absent manque à la table). */
  slots(refs: readonly SlotRef[]): Promise<Map<string, Uint8Array>>;
  /** Range une tête et les corps neufs ENSEMBLE, et oublie tout corps que `keep` ne désigne plus. */
  save(entry: {
    seq: number;
    head: Uint8Array;
    hk?: HeadKeyRef;
    bodies: ReadonlyArray<{ p: string; ver: number; body: Uint8Array }>;
    keep: readonly SlotRef[];
  }): Promise<void>;
}

/**
 * Les clés détenues : `current` écrit (l'époque la plus récente), `all` lit. Les
 * deux sont à la génération 0, sauf un trousseau qui ne tient que des `K_db`
 * confiées (un accès API). `derive` rend `K_db(e, g)` depuis la RACINE (FEK, ou
 * K_vault de l'époque `e`) : un membre lit et écrit ainsi toute génération ;
 * absente, ou `null` (racine pas là), la génération n'est pas lisible.
 */
export interface ReplicaKeyring {
  current: StoreKeys;
  all: StoreKeys[];
  derive?: (epoch: number, generation: number) => Promise<StoreKeys | null>;
}

const keyRefOf = (keys: StoreKeys): HeadKeyRef => ({ e: keys.epoch, g: keys.generation ?? 0 });

const isGeneration = (g: unknown): g is number =>
  typeof g === 'number' && Number.isSafeInteger(g) && g >= 0;

/**
 * Les clés d'un couple `(e, g)` : celles du trousseau d'abord, sinon dérivées de
 * la racine (et retenues dans `memo`). `null` : la clé n'est pas là.
 */
export async function keysAt(
  keyring: ReplicaKeyring,
  epoch: number,
  generation: number,
  memo?: Map<string, StoreKeys>
): Promise<StoreKeys | null> {
  const held = keyring.all.find((k) => k.epoch === epoch && (k.generation ?? 0) === generation);
  if (held) return held;
  const key = `${epoch}|${generation}`;
  const kept = memo?.get(key);
  if (kept) return kept;
  if (!keyring.derive) return null;
  const derived = await keyring.derive(epoch, generation);
  if (derived) memo?.set(key, derived);
  return derived;
}

/**
 * Ouvre une tête (précision 3.9) : sous la clé que dit le serveur (`hk`) ; à
 * défaut, ou si elle n'ouvre pas, sous chaque époque détenue, à la génération de
 * `hk` puis à 0 — un serveur d'avant 3.9 ne dit rien, et une tête écrite par un
 * client d'avant 3.9 n'a pas déclaré sa clé. Rend la tête et sa clé ; lève si
 * rien ne l'ouvre.
 */
export async function openStoreHead(
  c: StoreCrypto,
  keyring: ReplicaKeyring,
  seq: number,
  body: Uint8Array,
  hk?: HeadKeyRef,
  memo?: Map<string, StoreKeys>
): Promise<{ head: StoreHead; keys: StoreKeys; hk: HeadKeyRef }> {
  let first: unknown = null;
  if (hk && Number.isSafeInteger(hk.e) && hk.e >= 0 && isGeneration(hk.g)) {
    const keys = await keysAt(keyring, hk.e, hk.g, memo);
    if (keys) {
      try {
        return { head: await openHead(c, keys, seq, body), keys, hk: keyRefOf(keys) };
      } catch (err) {
        first = err;
      }
    } else {
      first = new Error(`clé (e ${hk.e}, g ${hk.g}) absente`);
    }
  }
  const generations = [...new Set([hk && isGeneration(hk.g) ? hk.g : 0, 0])];
  const candidates: StoreKeys[] = [];
  for (const g of generations) {
    for (const held of keyring.all) {
      const keys = (held.generation ?? 0) === g ? held : await keysAt(keyring, held.epoch, g, memo);
      if (keys && !candidates.includes(keys)) candidates.push(keys);
    }
  }
  try {
    const opened = await openHeadAnyEpoch(c, candidates, seq, body);
    return { ...opened, hk: keyRefOf(opened.keys) };
  } catch (err) {
    throw first ?? err;
  }
}

/**
 * Les couples `(e, g)` EN USAGE dans un magasin (contrat `api-base-1` § 3) :
 * ceux des blocs de la tête, celui de la tête, et celui sous lequel le prochain
 * rédacteur écrira (`writing` : l'époque courante, la génération courante) — un
 * droit scellé sans lui deviendrait muet à la première écriture. Triés par
 * époque puis génération, sans doublon.
 */
export function keyPairsInUse(
  head: Pick<StoreHead, 'slots'> | null,
  hk: HeadKeyRef | null,
  writing: HeadKeyRef | null
): HeadKeyRef[] {
  const seen = new Map<string, HeadKeyRef>();
  const add = (ref: HeadKeyRef) => seen.set(`${ref.e}|${ref.g}`, { e: ref.e, g: ref.g });
  for (const entry of Object.values(head?.slots ?? {}))
    add({ e: entry.e, g: entryGeneration(entry) });
  if (hk) add(hk);
  if (writing) add(writing);
  return [...seen.values()].sort((a, b) => a.e - b.e || a.g - b.g);
}

/** Le journal local des écritures pas encore validées (hors ligne compris). */
export interface PendingLog {
  load(): Promise<{ ops: StoreOp[]; schema: StoreSchema | null }>;
  save(ops: StoreOp[], schema: StoreSchema | null): Promise<void>;
}

export interface ReplicaOptions {
  /** Identité du bloc propriétaire (§ 6, § 10 bis). */
  dbId: string;
  /**
   * L'ordre de téléchargement des blocs au PREMIER chargement (phase 4) : d'abord
   * ceux qui peuvent porter la première page de la vue regardée (index de zone,
   * précision 3.8). Absent : l'ordre des préfixes.
   */
  loadOrder?: (head: StoreHead) => readonly string[];
  now?: () => number;
  /** Au-delà, un corps part par un dépôt plutôt que dans le JSON de la validation. */
  inlineMaxBytes?: number;
  /** Budget des corps en ligne d'UNE validation (le JSON est borné à 4 Mio, base64 compris). */
  inlineBudgetBytes?: number;
  maxRetries?: number;
  log?: PendingLog;
  cache?: StoreCache;
}

export const slotRefKey = (p: string, ver: number): string => `${p}|${ver}`;

/** Une validation refusée pour une autre raison qu'un conflit de séquence. */
export class StoreCommitError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string
  ) {
    super(`validation refusée : ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'StoreCommitError';
  }
}

/**
 * Le serveur n'a pas répondu (réseau coupé, hors ligne). Levée par le TRANSPORT ;
 * distincte d'un refus, qui est une réponse (§ 9 bis, point 2).
 */
export class StoreUnreachableError extends Error {
  constructor(message = 'serveur injoignable') {
    super(message);
    this.name = 'StoreUnreachableError';
  }
}

/** Le serveur a rendu une tête ou un bloc qui ne passe pas la vérification. */
export class StoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreIntegrityError';
  }
}

interface CachedSlot {
  ver: number;
  e: number;
  g: number;
  mac: string;
  rows: StoreRows;
}

/** Une tête ouverte et tous ses blocs, prête à être installée. */
interface OpenedState {
  head: StoreHead;
  /** Sous quelle clé la tête est scellée. */
  hk: HeadKeyRef;
  keys: { mac: Uint8Array; place: Uint8Array };
  slots: Map<string, CachedSlot>;
  /** Les corps venus du serveur, à ranger dans le cache local. */
  fetched: Array<{ p: string; ver: number; body: Uint8Array }>;
}

const DEFAULT_INLINE_MAX = 64 * 1024;
const DEFAULT_INLINE_BUDGET = 2 * 1024 * 1024;

/**
 * Au premier chargement, au-delà de ce nombre de blocs à télécharger, ils
 * arrivent PAR LOTS (phase 4) : un premier lot court (de quoi prouver la première
 * page), puis des lots de plus en plus gros. Entre deux lots, `partial()` dit où
 * en est le chargement.
 */
export const PROGRESSIVE_MIN_SLOTS = 8;
const PROGRESSIVE_BATCHES = [4, 8, 16, 32, 64, 128];

/** L'état d'un premier chargement en cours (phase 4) : lu, jamais écrit. */
export interface StorePartial {
  head: StoreHead;
  /** Blocs déjà reçus et vérifiés (cache local compris). */
  loaded: ReadonlySet<string>;
  /** Blocs de la tête. */
  total: number;
  /** Les lignes vivantes des blocs reçus, dans l'ordre manuel. */
  rows(): DbRow[];
  /** La position manuelle (`#o`) d'une ligne reçue (`""` sans position). */
  orderOf(rowId: string): string;
}

/** Les blocs à télécharger, dans l'ordre demandé (ceux qu'il ne cite pas, à la fin, par préfixe). */
function orderedWanted<T extends [string, unknown]>(
  wanted: T[],
  order: readonly string[] | undefined
): T[] {
  if (!order) return wanted;
  const rank = new Map(order.map((p, i) => [p, i] as const));
  return [...wanted].sort((a, b) => {
    const ra = rank.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
    return ra !== rb ? ra - rb : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
}

function cutBatches<T>(items: T[]): T[][] {
  const out: T[][] = [];
  let at = 0;
  let i = 0;
  while (at < items.length) {
    const size = PROGRESSIVE_BATCHES[Math.min(i, PROGRESSIVE_BATCHES.length - 1)]!;
    out.push(items.slice(at, at + size));
    at += size;
    i += 1;
  }
  return out;
}

// ==================== La réplique ====================

export class StoreReplica {
  seq = 0;
  head: StoreHead | null = null;
  /**
   * La génération COURANTE du magasin (précision 3.9), telle que le serveur l'a
   * dite (tête lue, refus `stale_generation`). Elle ne redescend jamais : un
   * serveur qui la baisserait ferait écrire sous une clé qu'un accès révoqué tient.
   */
  generation = 0;
  /** Sous quelle clé la tête installée est scellée (`null` : aucune tête). */
  headKeyRef: HeadKeyRef | null = null;
  /**
   * La plus haute génération de tête déjà ouverte : une tête scellée sous une
   * génération plus basse est un retour en arrière (un accès révoqué, allié au
   * serveur, pourrait la forger sous une clé qu'il tient encore).
   */
  private headGenerationFloor = 0;
  /** Les clés dérivées d'une génération au-delà de 0, par `e|g`. */
  private derivedKeys = new Map<string, StoreKeys>();
  private headKeyCache: { mac: Uint8Array; place: Uint8Array } | null = null;
  private slotCache = new Map<string, CachedSlot>();
  /** L'état validé (fusion de tous les blocs de la tête lue). */
  private committed: StoreRows = {};
  /** La vue : l'état validé, plus le journal appliqué (copie à l'écriture, ligne par ligne). */
  private view: StoreRows = {};
  private pending: StoreOp[] = [];
  private pendingSchema: StoreSchema | null = null;
  private placeCache = new Map<string, Uint8Array>();
  private materialized: DbRow[] | null = null;
  private rowObjects = new Map<string, { regs: RowRegisters; row: DbRow | null }>();
  private listeners = new Set<() => void>();
  private flushing: Promise<{ seq: number } | null> | null = null;
  private unreachable = false;
  private cacheWrites: Promise<void> = Promise.resolve();
  /** Le premier chargement en cours, lot par lot (phase 4). */
  private partialState: StorePartial | null = null;
  /** Zones déjà calculées, par `p|ver|signature du schéma` (précision 3.8) : un bloc inchangé ne se recalcule pas. */
  private zoneCache = new Map<string, SlotZone>();

  constructor(
    private readonly c: StoreCrypto,
    private readonly keyring: ReplicaKeyring,
    private readonly transport: StoreTransport,
    private readonly clock: HlcClock,
    private readonly opts: ReplicaOptions
  ) {}

  // ---------- Lecture ----------

  /**
   * Charge le journal local, puis l'état : le cache local d'abord (s'il est
   * complet et vérifié), le serveur ensuite. Serveur injoignable, un état en
   * cache suffit — la base s'affiche et s'édite, `offline` le dit ; sans cache,
   * ou sur un refus, l'échec remonte.
   */
  async load(): Promise<void> {
    if (this.opts.log) {
      const saved = await this.opts.log.load();
      this.pending = saved.ops.filter((op) => isHlc(op.t));
      this.pendingSchema = saved.schema;
      for (const op of this.pending) this.clock.observe(op.t);
      if (this.pendingSchema) this.clock.observe(this.pendingSchema.t);
    }
    const cached = await this.loadCached();
    try {
      await this.refresh(!cached);
    } catch (err) {
      if (cached && err instanceof StoreUnreachableError) return;
      throw err;
    }
  }

  /** Vrai quand le dernier appel au serveur est resté sans réponse (le bandeau « hors ligne »). */
  get offline(): boolean {
    return this.unreachable;
  }

  /** Le premier chargement en cours (lot par lot), ou `null` hors de lui. */
  partial(): StorePartial | null {
    return this.partialState;
  }

  /** Publie l'avancement d'un premier chargement : les blocs reçus jusqu'ici. */
  private publishPartial(head: StoreHead, fresh: Map<string, CachedSlot>): void {
    const slots = [...fresh.values()];
    let rows: DbRow[] | null = null;
    this.partialState = {
      head,
      loaded: new Set(fresh.keys()),
      total: Object.keys(head.slots).length,
      rows: () => {
        if (rows) return rows;
        const merged: StoreRows = {};
        for (const slot of slots) {
          for (const [id, regs] of Object.entries(slot.rows)) {
            const existing = ownRow(merged, id);
            merged[id] = existing ? mergeRow(existing, regs) : regs;
          }
        }
        rows = materializeRows(merged);
        return rows;
      },
      orderOf: (rowId) => {
        for (const slot of slots) {
          const regs = ownRow(slot.rows, rowId);
          if (regs) {
            const order = ownRegister(regs, FIELD_ORDER)?.v;
            return typeof order === 'string' ? order : '';
          }
        }
        return '';
      },
    };
    for (const fn of this.listeners) fn();
  }

  /** Adopte l'état du cache local s'il est COMPLET et vérifié ; un cache faux ou incomplet est ignoré. */
  private async loadCached(): Promise<boolean> {
    const cache = this.opts.cache;
    if (!cache) return false;
    try {
      const saved = await cache.head();
      if (!saved || saved.seq <= 0) return false;
      return this.install(saved.seq, await this.openState(saved.seq, saved.head, false, saved.hk));
    } catch {
      return false;
    }
  }

  /** Les clés d'un couple `(e, g)`, ou `null` sans la racine qui les dérive. */
  private keysFor(epoch: number, generation: number): Promise<StoreKeys | null> {
    return keysAt(this.keyring, epoch, generation, this.derivedKeys);
  }

  /** La génération sous laquelle on écrit : la courante, jamais sous la tête déjà lue. */
  private writeGeneration(): number {
    return Math.max(this.generation, this.headGenerationFloor);
  }

  /** Retient la génération que dit le serveur, sans jamais la baisser. */
  private noteGeneration(g: unknown): void {
    if (isGeneration(g) && g > this.generation) this.generation = g;
  }

  /**
   * Relit la tête ; ne télécharge que les blocs dont la version a changé et que
   * le cache local n'a pas. Rend vrai si l'état validé a changé. Refuse un
   * serveur qui RECULE sous le `seq` lu, écrit, ou rangé dans le cache.
   */
  async refresh(force = false): Promise<boolean> {
    const floor = this.seq;
    const { seq, head: body, hk, g } = await this.net(() => this.transport.head());
    // Une montée de génération ne change pas le seq : on la retient avant tout retour
    this.noteGeneration(g);
    if (seq < floor)
      throw new StoreIntegrityError(`le serveur est revenu en arrière (${seq} < ${floor})`);
    // Une validation de CETTE réplique a avancé le seq pendant la lecture : la réponse est seulement dépassée
    if (seq < this.seq) return false;
    if (!force && seq === this.seq && (this.head !== null || seq === 0)) return false;
    if (body === null) {
      if (seq !== 0) throw new StoreIntegrityError(`tête absente au seq ${seq}`);
      this.seq = 0;
      this.head = null;
      this.headKeyRef = null;
      this.headKeyCache = null;
      this.slotCache.clear();
      this.rebuild();
      return true;
    }
    const state = await this.openState(seq, body, true, hk);
    if (!this.install(seq, state)) return false;
    this.saveCache(seq, body, state.hk, state.fetched);
    return true;
  }

  /**
   * Ouvre une tête et rassemble TOUS ses blocs : la mémoire, puis le cache local,
   * puis le serveur (si `network`). Chaque corps est vérifié contre le `mac` de la
   * tête avant d'être ouvert, d'où qu'il vienne : un corps faux du cache est
   * redemandé, un corps faux du serveur est une erreur.
   */
  private async openState(
    seq: number,
    body: Uint8Array,
    network: boolean,
    hk?: HeadKeyRef
  ): Promise<OpenedState> {
    let opened: { head: StoreHead; keys: StoreKeys; hk: HeadKeyRef };
    try {
      opened = await openStoreHead(this.c, this.keyring, seq, body, hk, this.derivedKeys);
    } catch (err) {
      throw new StoreIntegrityError(`tête illisible : ${(err as Error).message}`);
    }
    if (opened.hk.g < this.headGenerationFloor) {
      throw new StoreIntegrityError(
        `tête d’une génération dépassée (${opened.hk.g} < ${this.headGenerationFloor})`
      );
    }
    const head = opened.head;
    const keys = headKeyBytes(head);
    const fresh = new Map<string, CachedSlot>();
    /** Vérifie puis ouvre un corps ; faux sur une empreinte fausse. */
    const accept = async (p: string, entry: SlotEntry, slotBody: Uint8Array): Promise<boolean> => {
      if (!(await verifySlot(this.c, keys.mac, entry, slotBody))) return false;
      // La clé que dit l'entrée du bloc : son époque, sa génération (absente = 0)
      const g = entryGeneration(entry);
      const slotKeys = await this.keysFor(entry.e, g);
      if (!slotKeys) {
        throw new StoreIntegrityError(
          g === 0 ? `clé de l'époque ${entry.e} absente` : `clé (e ${entry.e}, g ${g}) absente`
        );
      }
      const plain = await openSlot(this.c, slotKeys, p, entry.ver, slotBody);
      fresh.set(p, { ver: entry.ver, e: entry.e, g, mac: entry.mac, rows: plain.rows });
      return true;
    };
    let wanted = Object.entries(head.slots).filter(([p, entry]) => {
      const cached = this.slotCache.get(p);
      return !cached || cached.ver !== entry.ver || cached.mac !== entry.mac;
    });
    if (wanted.length > 0 && this.opts.cache) {
      let local = new Map<string, Uint8Array>();
      try {
        local = await this.opts.cache.slots(wanted.map(([p, e]) => ({ p, ver: e.ver })));
      } catch {
        /* cache indisponible : tout viendra du serveur */
      }
      const missing: typeof wanted = [];
      for (const [p, entry] of wanted) {
        const localBody = local.get(slotRefKey(p, entry.ver));
        let ok = false;
        if (localBody) {
          try {
            ok = await accept(p, entry, localBody);
          } catch (err) {
            if (err instanceof StoreIntegrityError) throw err;
            /* corps du cache illisible : redemandé */
          }
        }
        if (!ok) missing.push([p, entry]);
      }
      wanted = missing;
    }
    const fetched: Array<{ p: string; ver: number; body: Uint8Array }> = [];
    if (wanted.length > 0) {
      if (!network) throw new StoreIntegrityError('cache local incomplet');
      // Premier chargement d'une grosse base : par lots, la première page d'abord (phase 4)
      const progressive = this.head === null && wanted.length >= PROGRESSIVE_MIN_SLOTS;
      const batches = progressive
        ? cutBatches(orderedWanted(wanted, this.opts.loadOrder?.(head)))
        : [wanted];
      if (progressive) this.publishPartial(head, fresh);
      try {
        for (const batch of batches) {
          await this.fetchBatch(batch, accept, fetched);
          if (progressive) this.publishPartial(head, fresh);
        }
      } finally {
        if (progressive) this.partialState = null;
      }
    }
    const slots = new Map<string, CachedSlot>();
    for (const [p, entry] of Object.entries(head.slots)) {
      const slot = fresh.get(p) ?? this.slotCache.get(p);
      if (!slot || slot.ver !== entry.ver)
        throw new StoreIntegrityError(`bloc ${p || '-'} manquant`);
      slots.set(p, slot);
    }
    return { head, hk: opened.hk, keys, slots, fetched };
  }

  /** Télécharge un lot de blocs, vérifie chaque corps contre la tête et l'ouvre. */
  private async fetchBatch(
    wanted: Array<[string, SlotEntry]>,
    accept: (p: string, entry: SlotEntry, body: Uint8Array) => Promise<boolean>,
    fetched: Array<{ p: string; ver: number; body: Uint8Array }>
  ): Promise<void> {
    const bodies = await this.net(() =>
      this.transport.slots(wanted.map(([p, e]) => ({ p, ver: e.ver })))
    );
    await Promise.all(
      wanted.map(async ([p, entry]) => {
        const slotBody = bodies.get(slotRefKey(p, entry.ver));
        if (!slotBody) throw new StoreIntegrityError(`bloc ${p || '-'} v${entry.ver} introuvable`);
        let ok: boolean;
        try {
          ok = await accept(p, entry, slotBody);
        } catch (err) {
          if (err instanceof StoreIntegrityError) throw err;
          throw new StoreIntegrityError(
            `bloc ${p || '-'} v${entry.ver} illisible : ${(err as Error).message}`
          );
        }
        if (!ok) {
          throw new StoreIntegrityError(
            `bloc ${p || '-'} v${entry.ver} substitué : empreinte fausse`
          );
        }
        fetched.push({ p, ver: entry.ver, body: slotBody });
      })
    );
  }

  /**
   * Installe un état ouvert. Un état PLUS ANCIEN que celui déjà là (une relecture
   * dépassée par une validation arrivée entre-temps) est écarté : rien ne recule.
   */
  private install(seq: number, state: OpenedState): boolean {
    if (seq < this.seq) return false;
    this.slotCache = state.slots;
    this.head = state.head;
    this.headKeyRef = state.hk;
    if (state.hk.g > this.headGenerationFloor) this.headGenerationFloor = state.hk.g;
    this.headKeyCache = state.keys;
    this.seq = seq;
    this.clock.observe(state.head.schema.t);
    this.rebuild();
    return true;
  }

  /**
   * Un appel au serveur. Sans réponse (`StoreUnreachableError`), la réplique passe
   * « hors ligne » ; toute réponse, même un refus, l'en sort.
   */
  private async net<T>(call: () => Promise<T>): Promise<T> {
    try {
      const out = await call();
      this.setUnreachable(false);
      return out;
    } catch (err) {
      this.setUnreachable(err instanceof StoreUnreachableError);
      throw err;
    }
  }

  private setUnreachable(value: boolean): void {
    if (this.unreachable === value) return;
    this.unreachable = value;
    for (const fn of this.listeners) fn();
  }

  /**
   * Range la tête et les corps neufs dans le cache local, dans l'ordre des états,
   * sans jamais bloquer ni faire échouer la lecture ou la validation.
   */
  private saveCache(
    seq: number,
    head: Uint8Array,
    hk: HeadKeyRef,
    bodies: ReadonlyArray<{ p: string; ver: number; body: Uint8Array }>
  ): void {
    const cache = this.opts.cache;
    if (!cache) return;
    const keep = [...this.slotCache].map(([p, slot]) => ({ p, ver: slot.ver }));
    this.cacheWrites = this.cacheWrites
      .then(() => cache.save({ seq, head, hk, bodies, keep }))
      .catch(() => undefined);
  }

  /** Les écritures du cache local en cours, faites (tests, fermeture). */
  cacheSettled(): Promise<void> {
    return this.cacheWrites;
  }

  /** Recalcule l'état validé depuis les blocs, puis la vue (journal réappliqué). */
  private rebuild(): void {
    const committed: StoreRows = {};
    let latest = '';
    for (const slot of this.slotCache.values()) {
      for (const [id, regs] of Object.entries(slot.rows)) {
        const existing = ownRow(committed, id);
        // Un identifiant présent dans deux blocs (rédacteur fautif) : ses registres fusionnent
        committed[id] = existing ? mergeRow(existing, regs) : regs;
        for (const reg of Object.values(regs)) if (reg.t > latest) latest = reg.t;
      }
    }
    if (latest) this.clock.observe(latest);
    this.committed = committed;
    this.view = { ...committed };
    for (const op of this.pending) this.applyToView(op);
    this.invalidate();
  }

  /**
   * Une écriture appliquée à la vue sur une COPIE de la ligne : l'état validé
   * reste intact, et une ligne changée change d'objet — c'est ce qui dit à
   * `rows()` de la matérialiser à nouveau, et à elle seule.
   */
  private applyToView(op: StoreOp): void {
    const current = ownRow(this.view, op.r);
    if (current !== undefined) this.view[op.r] = { ...current };
    applyOp(this.view, op);
  }

  private invalidate(): void {
    this.materialized = null;
    for (const fn of this.listeners) fn();
  }

  /** Les lignes vivantes, dans l'ordre manuel ; une ligne inchangée garde le MÊME objet. */
  rows(): DbRow[] {
    if (this.materialized) return this.materialized;
    const seen = new Set<string>();
    const live: Array<{ row: DbRow; order: string }> = [];
    for (const [id, regs] of Object.entries(this.view)) {
      seen.add(id);
      let cached = this.rowObjects.get(id);
      if (!cached || cached.regs !== regs) {
        cached = { regs, row: materializeRow(id, regs) };
        this.rowObjects.set(id, cached);
      }
      if (!cached.row) continue;
      const order = ownRegister(regs, FIELD_ORDER)?.v;
      live.push({ row: cached.row, order: typeof order === 'string' ? order : '' });
    }
    for (const id of [...this.rowObjects.keys()]) if (!seen.has(id)) this.rowObjects.delete(id);
    // L'ordre manuel (`#o`), puis l'identifiant pour départager deux positions égales
    live.sort((a, b) =>
      a.order < b.order
        ? -1
        : a.order > b.order
          ? 1
          : a.row.id < b.row.id
            ? -1
            : a.row.id > b.row.id
              ? 1
              : 0
    );
    this.materialized = live.map((entry) => entry.row);
    return this.materialized;
  }

  /** Les registres de la vue (pour calculer des écritures, l'ordre manuel, l'annulation). */
  registers(): StoreRows {
    return this.view;
  }

  /** Le schéma courant : celui de la tête, fusionné avec un changement local en attente. */
  schema(): StoreSchema | null {
    const base = this.head?.schema ?? null;
    if (!this.pendingSchema) return base;
    return base ? mergeSchema(base, this.pendingSchema) : this.pendingSchema;
  }

  /** Une heure neuve de l'horloge de la réplique, pour horodater un geste (`StoreOp.t`). */
  tick(): string {
    return this.clock.tick();
  }

  /** L'appareil de cette réplique (départage deux écritures de la même milliseconde). */
  get siteId(): string {
    return this.clock.site;
  }

  get pendingCount(): number {
    return this.pending.length + (this.pendingSchema ? 1 : 0);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------- Écriture ----------

  /** Des écritures locales, déjà horodatées par l'horloge de la réplique. */
  apply(ops: readonly StoreOp[]): void {
    if (ops.length === 0) return;
    for (const op of ops) {
      if (!isHlc(op.t)) continue;
      this.pending.push(op);
      this.applyToView(op);
    }
    void this.persist();
    this.invalidate();
  }

  /** Un changement de schéma (un registre), horodaté maintenant. */
  setSchema(schema: Omit<StoreSchema, 't'>): void {
    this.pendingSchema = { ...schema, t: this.clock.tick() };
    void this.persist();
    this.invalidate();
  }

  /** Le journal local ; un échec d'écriture ne fait jamais tomber le geste (le journal en mémoire tient). */
  private async persist(): Promise<void> {
    if (!this.opts.log) return;
    try {
      await this.opts.log.save(this.pending, this.pendingSchema);
    } catch {
      /* rejoué à la prochaine écriture ou vidange */
    }
  }

  /** Vide le journal : UNE vidange à la fois ; un conflit relit et recommence. */
  flush(): Promise<{ seq: number } | null> {
    if (this.flushing) return this.flushing;
    const run = this.flushNow().finally(() => {
      this.flushing = null;
    });
    this.flushing = run;
    return run;
  }

  private async flushNow(): Promise<{ seq: number } | null> {
    const retries = this.opts.maxRetries ?? 8;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      const ops = this.pending.slice();
      const schema = this.pendingSchema;
      if (ops.length === 0 && !schema) return null;
      const result = await this.tryCommit(ops, schema);
      if (result.ok) {
        this.pending = this.pending.slice(ops.length);
        if (this.pendingSchema === schema) this.pendingSchema = null;
        this.rebuild();
        await this.persist();
        return { seq: result.seq };
      }
      if (result.code === 'seq_conflict') {
        await this.refresh(true);
        continue;
      }
      if (result.code === 'stale_generation') {
        // Le magasin a changé de génération (un accès API retiré) : relire la tête,
        // puis resceller sous la génération courante et rejouer (précision 3.9)
        this.noteGeneration('g' in result ? result.g : undefined);
        await this.refresh(true);
        continue;
      }
      throw new StoreCommitError(result.code, 'detail' in result ? result.detail : undefined);
    }
    throw new StoreCommitError('too_many_conflicts', `${retries} essais`);
  }

  private async placeOf(id: string, placeKey: Uint8Array): Promise<Uint8Array> {
    const cached = this.placeCache.get(id);
    if (cached) return cached;
    const hash = await placeHash(this.c, placeKey, id);
    this.placeCache.set(id, hash);
    return hash;
  }

  private async tryCommit(
    ops: StoreOp[],
    schema: StoreSchema | null
  ): Promise<{ ok: true; seq: number } | { ok: false; code: string; detail?: string; g?: number }> {
    const base = this.head;
    const headKeys: HeadKeys = base?.keys ?? (this.newKeys ??= newHeadKeys(this.c));
    const keyBytes = base ? this.headKeyCache! : headKeyBytes({ keys: headKeys });
    // Après un conflit, la tête de l'appareil gagnant porte SES clés : toute empreinte
    // calculée sous les nôtres serait fausse
    if (this.placeKeyOf !== headKeys.place) this.placeCache.clear();
    this.placeKeyOf = headKeys.place;
    // L'époque la plus récente, sous la génération COURANTE (précision 3.9)
    const gen = this.writeGeneration();
    const current =
      (this.keyring.current.generation ?? 0) === gen
        ? this.keyring.current
        : await this.keysFor(this.keyring.current.epoch, gen);
    if (!current) {
      throw new StoreCommitError(
        'generation_key_missing',
        `(e ${this.keyring.current.epoch}, g ${gen})`
      );
    }
    const hk: HeadKeyRef = { e: current.epoch, g: gen };

    // Les lignes touchées, par bloc de la tête lue (tout part du bloc racine sur un magasin vide)
    const cover = base ? new Set(Object.keys(base.slots)) : new Set(['']);
    const byPrefix = new Map<string, StoreOp[]>();
    for (const op of ops) {
      const p = prefixFor(await this.placeOf(op.r, keyBytes.place), cover);
      const list = byPrefix.get(p);
      if (list) list.push(op);
      else byPrefix.set(p, [op]);
    }
    if (base === null && byPrefix.size === 0) byPrefix.set('', []);

    // Chaque bloc touché est réécrit (et divisé au besoin), sous l'époque et la génération courantes
    const laid: LaidSlot[] = [];
    const removed: string[] = [];
    const index: Record<string, SlotEntry> = { ...(base?.slots ?? {}) };
    for (const [p, slotOps] of byPrefix) {
      const cached = this.slotCache.get(p);
      const rows: StoreRows = { ...(cached?.rows ?? {}) };
      for (const op of slotOps) {
        const row = ownRow(rows, op.r);
        if (row !== undefined && row === ownRow(cached?.rows ?? {}, op.r)) rows[op.r] = { ...row };
        applyOp(rows, op);
      }
      const hashes = new Map<string, Uint8Array>();
      for (const id of Object.keys(rows)) hashes.set(id, await this.placeOf(id, keyBytes.place));
      const out =
        base === null
          ? await layoutRows(this.c, current, p, rows, hashes)
          : await layoutSlot(this.c, current, p, (cached?.ver ?? 0) + 1, rows, hashes);
      delete index[p];
      if (base !== null && !out.some((s) => s.p === p)) removed.push(p);
      for (const slot of out) {
        index[slot.p] = {
          e: current.epoch,
          // `g` n'est écrit qu'au-delà de 0 : une tête de génération 0 reste celle d'avant 3.9
          ...(gen > 0 ? { g: gen } : {}),
          mac: await slotMac(this.c, keyBytes.mac, slot.body),
          ver: slot.ver,
        };
        laid.push(slot);
      }
    }
    if (!isCover(Object.keys(index)))
      throw new StoreIntegrityError('les blocs écrits ne recouvrent plus l’espace');

    // La tête neuve
    const mergedSchema =
      schema && base ? mergeSchema(base.schema, schema) : (schema ?? base?.schema ?? null);
    if (!mergedSchema)
      throw new StoreCommitError('no_schema', 'la première validation porte le schéma');
    const now = this.opts.now?.() ?? Date.now();
    const epochs = [...new Set(Object.values(index).map((e) => e.e))].sort((a, b) => a - b);
    // L'index de zone (précision 3.8) : tous les blocs de la tête neuve, en clair ici
    const laidByPrefix = new Map(laid.map((slot) => [slot.p, slot] as const));
    const zoneInputs: Array<readonly [string, { ver: number; rows: StoreRows }]> = [];
    let zonesComplete = true;
    for (const [p, entry] of Object.entries(index)) {
      const rows = laidByPrefix.get(p)?.rows ?? this.slotCache.get(p)?.rows;
      if (!rows) {
        zonesComplete = false;
        break;
      }
      zoneInputs.push([p, { ver: entry.ver, rows }] as const);
    }
    const zones = zonesComplete
      ? headZones(zoneInputs, mergedSchema.properties, this.zoneCache)
      : undefined;
    const head: StoreHead = {
      v: 1,
      dbId: base?.dbId ?? this.opts.dbId,
      keys: headKeys,
      schema: mergedSchema,
      slots: index,
      root: await merkleRoot(this.c, keyBytes.mac, index),
      epochs,
      updated: new Date(now).toISOString(),
      ...(zones ? { zones } : {}),
    };
    const sealedSeq = this.seq + 1;
    const headBody = await sealHead(this.c, current, sealedSeq, head);

    // Les corps : en ligne tant que le budget tient, sinon par dépôt
    const inlineMax = this.opts.inlineMaxBytes ?? DEFAULT_INLINE_MAX;
    let budget = this.opts.inlineBudgetBytes ?? DEFAULT_INLINE_BUDGET;
    const slots: CommitSlot[] = [];
    for (const slot of laid) {
      const entry = index[slot.p]!;
      if (slot.body.length <= inlineMax && slot.body.length <= budget) {
        budget -= slot.body.length;
        slots.push({ p: slot.p, ver: slot.ver, e: entry.e, g: gen, body: slot.body });
      } else {
        slots.push({
          p: slot.p,
          ver: slot.ver,
          e: entry.e,
          g: gen,
          stage: await this.net(() => this.transport.stage(slot.body)),
        });
      }
    }

    const res = await this.net(() =>
      this.transport.commit({ baseSeq: this.seq, slots, removed, head: headBody, hk })
    );
    if (!res.ok) return res;

    // Validée : le cache suit ce qui a été écrit
    for (const p of byPrefix.keys()) this.slotCache.delete(p);
    for (const slot of laid) {
      const entry = index[slot.p]!;
      this.slotCache.set(slot.p, {
        ver: slot.ver,
        e: entry.e,
        g: gen,
        mac: entry.mac,
        rows: slot.rows,
      });
    }
    this.head = head;
    this.headKeyRef = hk;
    if (gen > this.headGenerationFloor) this.headGenerationFloor = gen;
    this.headKeyCache = keyBytes;
    this.seq = res.seq;
    // Une tête ne se rouvre que sous le seq de son AAD : un serveur qui en rendrait un autre n'est pas rangé
    if (res.seq === sealedSeq) {
      this.saveCache(
        sealedSeq,
        headBody,
        hk,
        laid.map((slot) => ({ p: slot.p, ver: slot.ver, body: slot.body }))
      );
    }
    return { ok: true, seq: res.seq };
  }

  private newKeys: HeadKeys | undefined;
  private placeKeyOf: string | undefined;

  // ---------- Migration (§ 10) ----------

  /**
   * Une base EN LIGNE passe au magasin : chaque champ reçoit l'heure tirée de
   * `updatedAt` (sinon `createdAt`, sinon maintenant), l'ordre manuel des
   * positions régulières, et le schéma un registre neuf. Si un autre appareil a
   * migré la même base le premier, nos lignes se fusionnent aux siennes (union).
   */
  migrate(rows: readonly DbRow[], schema: Omit<StoreSchema, 't'>): Promise<{ seq: number } | null> {
    const now = this.opts.now?.() ?? Date.now();
    const positions = evenPositions(rows.length);
    const ops: StoreOp[] = [];
    rows.forEach((row, i) => {
      const parsed = Date.parse(row.updatedAt ?? row.createdAt ?? '');
      const ms = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : now;
      const t = formatHlc(ms, 0, this.clock.site);
      const regs = rowToRegisters(row, t, positions[i] ?? 'V');
      for (const [f, reg] of Object.entries(regs)) ops.push({ r: row.id, f, v: reg.v, t: reg.t });
    });
    // Le schéma de la base en ligne ne remplace pas celui d'un magasin déjà là : il ne gagne que s'il est
    // plus récent, et une migration n'a pas d'heure de schéma à elle — on la pose donc AVANT tout le reste.
    if (this.head === null) this.pendingSchema = { ...schema, t: formatHlc(0, 0, this.clock.site) };
    for (const op of ops) {
      this.pending.push(op);
      this.applyToView(op);
    }
    this.invalidate();
    void this.persist();
    return this.flush();
  }
}

// ==================== Découpage d'une grosse première écriture ====================

/** Taille compressée visée par bloc au pré-découpage (sous les 32 Kio de la division). */
const BULK_TARGET_BYTES = 20 * 1024;
/** Rapport estimé entre le JSON d'un bloc et son corps compressé (le JSON en colonnes compresse bien). */
const BULK_RATIO = 0.35;

/**
 * Place une GROSSE première écriture : sans pré-découpage, `layoutSlot` scelle
 * tout le magasin, puis chaque moitié, puis chaque quart… (14 Mo rechiffrés une
 * dizaine de fois pour 20 000 lignes). On estime d'abord la profondeur d'après
 * la taille du JSON, on répartit les lignes à cette profondeur, et chaque
 * groupe ne se divise plus que s'il le faut. Le recouvrement reste complet :
 * un préfixe sans ligne reçoit un bloc vide.
 */
export async function layoutRows(
  c: StoreCrypto,
  keys: StoreKeys,
  prefix: string,
  rows: StoreRows,
  hashes: ReadonlyMap<string, Uint8Array>
): Promise<LaidSlot[]> {
  const estimate = slotJson(prefix, rows).length * BULK_RATIO;
  const depth = Math.max(
    0,
    Math.min(16, Math.ceil(Math.log2(Math.max(1, estimate / BULK_TARGET_BYTES))))
  );
  let groups: Array<[string, StoreRows]> = [[prefix, rows]];
  for (let d = 0; d < depth; d += 1) {
    const next: Array<[string, StoreRows]> = [];
    for (const [p, group] of groups) {
      const [zero, one] = splitRows(p, group, hashes);
      next.push([`${p}0`, zero], [`${p}1`, one]);
    }
    groups = next;
  }
  const out: LaidSlot[] = [];
  for (const [p, group] of groups) out.push(...(await layoutSlot(c, keys, p, 1, group, hashes)));
  return out;
}
