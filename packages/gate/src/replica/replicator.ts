/**
 * LA RÉPLIQUE de la boîte noire : tout ce que le jeton ouvre, tenu à jour.
 *
 * 1. `GET /api-access/self` : l'accès, ses droits scellés (ouverts et vérifiés à
 *    leur place), ses manifestes, ses limites et son usage ; et, révision 3, la
 *    clé de signature du créateur (authentifiée par `creatorTag`, § 1 bis), la
 *    boîte de dépôt liée (`files`, signée par le créateur) et l'hébergement ;
 * 2. pour chaque magasin : tête → blocs changés → lignes en mémoire (`StoreMirror`) ;
 * 3. les changements arrivent par le flux (`GET /api-access/self/stream`,
 *    WebSocket), reconnecté avec un délai croissant ; sans flux (palier Free,
 *    `403 api_tier_stream`, ou moteur sans WebSocket), par une relève de
 *    `changes` au plus toutes les 300 s ; et, révision 3, par les RÉVEILS
 *    POUSSÉS (`wake`, § 5 bis), qui disent « relis » sans rien porter.
 *
 * Chaque `429` est honoré (`Retry-After`) : plus rien ne part vers Filarr avant
 * l'heure dite, et les lectures locales continuent sur la dernière copie.
 * Révocation (`{ t: "revoked" }` ou `401 api_access_revoked`) : tout s'arrête, les
 * clés et les lignes sont effacées de la mémoire, le cache des blocs aussi.
 *
 * Portable : ni `node:events` ni `ws` ; le flux passe par un `StreamOpener`
 * (Workers, paquet `ws`, ou `WebSocket` standard).
 */

import { bindMessage, fromBase64Std } from '../../../core/src/engine/store/apiAccess';
import { verifyCreatorTag, type NotifyBody } from '../../../core/src/engine/gate/access3';
import { verifyBoxSig } from '../../../core/src/engine/gate/files';
import { openSettings, type GateSettings } from '../../../core/src/engine/gate/settings';
import { curves, storeCrypto } from '../crypto/providers';
import { Emitter } from '../util/emitter';
import { openGrants, openManifests, type ManifestInfo, type RefusedSeal, type Rights, type SelfAccess, type SelfResponse } from './access';
import type { BlockCache } from './blockCache';
import { FilarrClient, FilarrError, RateLimitError, UnreachableError, parseRetryAfter } from './http';
import { StoreMirror, type ChangesResponse, type RowDiff } from './store';
import { defaultStreamOpener, type StreamOpener, type StreamSocket } from './stream';
import { openToken, wipeIdentity, type AccessIdentity } from './token';

export type LinkState =
  | 'no_token'
  | 'connecting'
  | 'live'
  | 'polling'
  | 'offline'
  | 'limited'
  | 'paused'
  | 'not_switched'
  | 'ip_forbidden'
  | 'revoked'
  | 'expired'
  | 'unknown_access'
  | 'upgrade_required'
  /** Révision 3 : identité en attente d'une migration (seuls `self` et `self/import` répondent). */
  | 'pending'
  /** Révision 3 : boîte hébergée en sommeil (fermeture 4308, `403 hosting_asleep`). */
  | 'asleep'
  | 'error';

const TERMINAL: ReadonlySet<LinkState> = new Set(['revoked', 'expired', 'unknown_access']);
/** États où la boucle attend puis relit `self`, sans flux. */
const WAITING: ReadonlySet<LinkState> = new Set(['paused', 'ip_forbidden', 'upgrade_required', 'not_switched', 'pending', 'asleep']);

export interface GateBase {
  storeId: string;
  rights: Rights;
  mirror: StoreMirror;
  manifest: ManifestInfo | null;
  /** Une relève de CE magasin attend cette heure (`api_poll_interval`, `api_quota_sync`, `api_quota_bytes`). */
  waitUntil: number;
}

/** Les refus du compteur qui ne visent qu'un magasin (ou que ses blocs) : les autres continuent. */
const PER_STORE_429: ReadonlySet<string> = new Set(['api_poll_interval', 'api_quota_sync', 'api_quota_bytes']);
/** Requêtes du mois épuisées : une relève par magasin et par 900 s (contrat § 6). */
const SLOW_POLL_MS = 900_000;

// Codes de fermeture du flux (worker, `apiMeter.ts`), et 4308 de la révision 3
const CLOSE_REVOKED = 4301;
const CLOSE_PAUSED = 4302;
const CLOSE_CHANGED = 4303;
const CLOSE_EXPIRED = 4304;
const CLOSE_QUOTA = 4305;
const CLOSE_TOO_MANY = 4306;
const CLOSE_ASLEEP = 4308;

export interface QuotaAlert {
  name: string;
  pct: number;
  at: string;
}

/**
 * La clé de signature du créateur, telle que la boîte la croit (§ 1 bis) :
 *  - `absent` : serveur d'avant la révision 3 (pas de `creator` dans `self`) ;
 *  - `untagged` : accès sans étiquette (créé avant la révision 3) — lecture et
 *    écriture continuent, fichiers, synchros et export demandent de remplacer le jeton ;
 *  - `authenticated` : l'étiquette est juste ; la clé est celle du créateur ;
 *  - `refused` : étiquette fausse, ou `bind_sig` qui ne vérifie pas `A_pub`.
 */
export type CreatorStatus = 'absent' | 'untagged' | 'authenticated' | 'refused';

export interface CreatorInfo {
  status: CreatorStatus;
  userId: string | null;
  /** Clé publique Ed25519 de signature (base64 standard), seulement si `authenticated`. */
  signingPublicKey: string | null;
  /** `bind_sig` vérifiée sur notre `A_pub` (`null` : le serveur ne la donne pas). */
  bindSigOk: boolean | null;
  reason: string | null;
}

/** La boîte de dépôt liée à l'accès (`gate-fichiers-1` § 1), vue de `self`. */
export interface FilesLink {
  requestId: string;
  /** Clé publique X25519 de la boîte (base64url). */
  publicKey: string;
  boxSig: string;
  /** La signature de la boîte vérifiée par la clé authentifiée du créateur. */
  signed: boolean;
  pending: { n: number; bytes: number };
  limits: { maxFileBytes: number; filesPerMonth: number; fileBytesPerMonth: number; pendingMax: number };
  usage: { files: number; fileBytes: number };
}

export interface ExportRequest {
  encPublicKey: string;
  bindSig: string;
}

export interface ReplicatorOptions {
  apiUrl: string;
  version: string;
  cache: BlockCache;
  site: string;
  /** Où noter ce qui arrive (le journal de la boîte) ; rien d'office. */
  journal?: { add(entry: { kind: 'filarr'; who: string; what: string; code: string; note?: string; ms?: number }): unknown };
  fetchImpl?: typeof fetch;
  /** Le flux : d'office le meilleur moyen du moteur ; `null` pour ne jamais l'ouvrir (relève et réveils). */
  streamOpener?: StreamOpener | null;
  /** Intervalle de relève sans flux ; le contrat impose au moins 300 s en Free. */
  pollIntervalMs?: number;
  /** Relecture de `self` sans flux (droits, manifestes). */
  selfIntervalMs?: number;
  /** Délai de reconnexion du flux : du minimum au maximum, doublé à chaque échec. */
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Nouvel essai quand l'accès est en pause, refusé pour son adresse, en attente ou endormi. */
  pausedRetryMs?: number;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

const isNat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export class Replicator extends Emitter {
  link: LinkState = 'no_token';
  linkDetail: string | null = null;
  identity: AccessIdentity | null = null;
  client: FilarrClient | null = null;
  access: SelfAccess | null = null;
  limits: Record<string, unknown> | null = null;
  usage: Record<string, unknown> | null = null;
  /** Révision 3 : la clé du créateur, authentifiée ou non. */
  creator: CreatorInfo = { status: 'absent', userId: null, signingPublicKey: null, bindSigOk: null, reason: null };
  /** Révision 3 : la boîte de dépôt liée, ou `null`. */
  files: FilesLink | null = null;
  /** Révision 3 : `hosting` de `self` (`null` : boîte chez soi). */
  hosting: { hostName: string } | null = null;
  /** Le dernier `self` brut (champs que la boîte ne connaît pas compris). */
  rawSelf: Record<string, unknown> | null = null;
  readonly bases = new Map<string, GateBase>();
  refused: RefusedSeal[] = [];
  quotaAlerts: QuotaAlert[] = [];
  /** Plus rien ne part vers Filarr avant cette heure (un `429`). */
  notBefore = 0;
  limitedCode: string | null = null;
  /** Le flux a été refusé (palier, ou requêtes du mois épuisées) : on relève jusqu'à cette heure. */
  streamRefusedUntil = 0;
  lastSelfAt: string | null = null;
  lastChangeAt: string | null = null;
  startedAt: string | null = null;
  /** Le dernier réveil poussé accepté. */
  lastWakeAt: string | null = null;

  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private socket: StreamSocket | null = null;
  private backoff: number;
  private selfDirty = false;
  private wakeLoop: (() => void) | null = null;
  private readonly opener: StreamOpener | null;

  constructor(private readonly opts: ReplicatorOptions) {
    super();
    this.backoff = opts.backoffMinMs ?? 1000;
    this.opener = opts.streamOpener === undefined ? defaultStreamOpener(opts.fetchImpl ?? fetch) : opts.streamOpener;
  }

  /** Le flux est-il refusé en ce moment (on relève) ? */
  get streamRefused(): boolean {
    return this.opener === null || Date.now() < this.streamRefusedUntil;
  }

  /** Intervalle de relève : le réglage, jamais sous l'écart que Filarr impose au palier, ni sous 900 s une fois le mois épuisé. */
  get pollIntervalMs(): number {
    const tier = typeof this.limits?.pollIntervalS === 'number' ? this.limits.pollIntervalS * 1000 : 0;
    const slow = this.streamRefusedUntil !== Infinity && Date.now() < this.streamRefusedUntil ? SLOW_POLL_MS : 0;
    return Math.max(this.opts.pollIntervalMs ?? 300_000, tier, slow);
  }

  /** Une base par son slug (manifeste). */
  bySlug(slug: string): GateBase | undefined {
    for (const b of this.bases.values()) if (b.manifest?.slug === slug) return b;
    return undefined;
  }

  /** Une base par l'identité du bloc propriétaire (`head.dbId`) : la cible d'une relation. */
  byDbId(dbId: string): GateBase | undefined {
    for (const b of this.bases.values()) if (b.mirror.head?.dbId === dbId) return b;
    return undefined;
  }

  private setLink(state: LinkState, detail: string | null = null): void {
    const changed = state !== this.link || detail !== this.linkDetail;
    this.link = state;
    this.linkDetail = detail;
    if (changed) this.emit('link', state, detail);
  }

  private journal(what: string, code: string, note?: string, ms?: number): void {
    this.opts.journal?.add({ kind: 'filarr', who: 'Filarr', what, code, ...(note ? { note } : {}), ...(ms !== undefined ? { ms } : {}) });
  }

  // ==================== Démarrage et arrêt ====================

  /**
   * Ouvre le jeton, lit `self`, ouvre les droits et rattrape chaque magasin.
   * Rend quand la première copie est prête (ou que l'échec est définitif), puis,
   * avec `live` (d'office), la boucle continue en arrière-plan (flux ou relève).
   * Sans `live`, rien ne tourne : l'hôte appelle `pollOnce` ou `wake` (objet
   * durable qui s'endort entre deux alarmes).
   */
  async start(token: string, opts: { live?: boolean } = {}): Promise<void> {
    await this.stop();
    const identity = await openToken(token);
    // Un autre jeton : les miroirs de l'ancien (et leur client) s'effacent ; le cache chiffré reste utilisable
    for (const base of this.bases.values()) base.mirror.wipe();
    this.bases.clear();
    if (this.identity) wipeIdentity(this.identity);
    this.identity = identity;
    this.client = new FilarrClient({
      baseUrl: this.opts.apiUrl,
      authorization: this.identity.authorization,
      version: this.opts.version,
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      onExchange: (info) => this.emit('exchange', info),
    });
    this.abort = new AbortController();
    this.startedAt = new Date().toISOString();
    this.selfDirty = true;
    this.streamRefusedUntil = 0;
    this.notBefore = 0;
    this.setLink('connecting');
    const signal = this.abort.signal;
    try {
      await this.refreshSelf();
      if (!WAITING.has(this.link)) await this.syncAll();
    } catch (err) {
      await this.handleError(err);
    }
    if (opts.live === false) {
      if (!TERMINAL.has(this.link) && !WAITING.has(this.link) && this.link !== 'offline' && this.link !== 'limited' && this.link !== 'error') {
        this.setLink('polling', 'Relève à la demande (réveils et alarmes)');
      }
      return;
    }
    if (!TERMINAL.has(this.link)) this.loop = this.run(signal);
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    this.wakeLoop?.();
    this.socket?.terminate();
    this.socket = null;
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }

  /** Oublie tout ce que la boîte noire tient de cet accès : clés, lignes, cache. */
  async forget(): Promise<void> {
    await this.stop();
    this.wipeAll();
    await this.opts.cache.clear().catch(() => undefined);
    this.access = null;
    this.limits = null;
    this.usage = null;
    this.files = null;
    this.creator = { status: 'absent', userId: null, signingPublicKey: null, bindSigOk: null, reason: null };
    this.setLink('no_token');
  }

  private wipeAll(): void {
    for (const base of this.bases.values()) base.mirror.wipe();
    this.bases.clear();
    if (this.identity) wipeIdentity(this.identity);
    this.identity = null;
  }

  /** Relit tout depuis Filarr (droits, manifestes, têtes). */
  async resync(): Promise<void> {
    if (!this.client) return;
    try {
      await this.refreshSelf();
      if (!WAITING.has(this.link)) await this.syncAll(true);
    } catch (err) {
      await this.handleError(err);
    }
  }

  // ==================== self, droits, manifestes, créateur ====================

  private checkLimited(): void {
    if (Date.now() < this.notBefore) {
      throw new RateLimitError(this.limitedCode ?? 'api_rate', this.notBefore - Date.now());
    }
  }

  /** Révision 3 : la clé du créateur, authentifiée par l'étiquette, et `bind_sig` sur notre `A_pub`. */
  private async readCreator(self: Record<string, unknown>, identity: AccessIdentity): Promise<CreatorInfo> {
    const raw = self.creator;
    if (!isObj(raw)) return { status: 'absent', userId: null, signingPublicKey: null, bindSigOk: null, reason: null };
    const userId = typeof raw.userId === 'string' ? raw.userId : null;
    const key = typeof raw.signingPublicKey === 'string' ? raw.signingPublicKey : null;
    if (raw.tag === null || raw.tag === undefined) return { status: 'untagged', userId, signingPublicKey: null, bindSigOk: null, reason: 'accès sans étiquette du créateur' };
    if (!key || typeof raw.tag !== 'string') return { status: 'refused', userId, signingPublicKey: null, bindSigOk: null, reason: 'clé du créateur illisible' };
    const tagOk = await verifyCreatorTag(storeCrypto, identity.aMac, identity.accessId, key, raw.tag);
    if (!tagOk) return { status: 'refused', userId, signingPublicKey: null, bindSigOk: null, reason: 'clé du créateur non authentifiée (étiquette fausse)' };
    // `bind_sig` : là où le serveur la donne (dans `access`, à défaut dans `creator`)
    const access = isObj(self.access) ? self.access : {};
    const bindSig = typeof access.bindSig === 'string' ? access.bindSig : typeof raw.bindSig === 'string' ? raw.bindSig : null;
    let bindSigOk: boolean | null = null;
    if (bindSig) {
      try {
        bindSigOk = curves.ed25519Verify(fromBase64Std(bindSig), bindMessage(identity.accessId, identity.aPub), fromBase64Std(key));
      } catch {
        bindSigOk = false;
      }
      if (!bindSigOk) return { status: 'refused', userId, signingPublicKey: null, bindSigOk, reason: 'bind_sig ne lie pas la clé de cet accès au créateur' };
    }
    return { status: 'authenticated', userId, signingPublicKey: key, bindSigOk, reason: null };
  }

  /** Révision 3 : la boîte de dépôt liée, et sa signature vérifiée par la clé authentifiée du créateur. */
  private readFiles(self: Record<string, unknown>, identity: AccessIdentity): FilesLink | null {
    const f = self.files;
    if (!isObj(f) || typeof f.requestId !== 'string' || typeof f.publicKey !== 'string' || typeof f.boxSig !== 'string') return null;
    const pending = isObj(f.pending) ? f.pending : {};
    const limits = isObj(f.limits) ? f.limits : {};
    const usage = isObj(f.usage) ? f.usage : {};
    const signed =
      this.creator.status === 'authenticated' &&
      this.creator.signingPublicKey !== null &&
      verifyBoxSig(curves, this.creator.signingPublicKey, identity.accessId, f.requestId, f.publicKey, f.boxSig);
    return {
      requestId: f.requestId,
      publicKey: f.publicKey,
      boxSig: f.boxSig,
      signed,
      pending: { n: num(pending.n), bytes: num(pending.bytes) },
      limits: {
        maxFileBytes: num(limits.maxFileBytes, 104_857_600),
        filesPerMonth: num(limits.filesPerMonth),
        fileBytesPerMonth: num(limits.fileBytesPerMonth),
        pendingMax: num(limits.pendingMax, 200),
      },
      usage: { files: num(usage.files), fileBytes: num(usage.fileBytes) },
    };
  }

  async refreshSelf(): Promise<void> {
    const client = this.client;
    const identity = this.identity;
    if (!client || !identity) return;
    this.checkLimited();
    const self = await client.json<SelfResponse & Record<string, unknown>>('GET', 'api-access/self');
    this.rawSelf = self;
    this.lastSelfAt = new Date().toISOString();
    this.selfDirty = false;
    this.access = self.access ?? null;
    this.limits = self.limits ?? null;
    this.usage = self.usage ?? null;
    const before = this.creator;
    this.creator = await this.readCreator(self, identity);
    if (before.status !== this.creator.status || before.signingPublicKey !== this.creator.signingPublicKey) {
      this.journal(
        `clé du créateur : ${this.creator.status === 'authenticated' ? 'authentifiée' : this.creator.status === 'untagged' ? 'accès sans étiquette' : this.creator.status === 'refused' ? 'REFUSÉE' : 'non fournie par Filarr'}`,
        'créateur',
        this.creator.reason ?? undefined
      );
      this.emit('creator', this.creator);
    }
    this.files = this.readFiles(self, identity);
    this.hosting = isObj(self.hosting) && typeof self.hosting.hostName === 'string' ? { hostName: self.hosting.hostName } : null;
    const { grants, refused: refusedGrants } = await openGrants(identity, self.grants);
    const { manifests, refused: refusedManifests } = await openManifests(identity, self.manifests);
    this.refused = [...refusedGrants, ...refusedManifests];
    for (const r of this.refused) {
      this.journal(
        `scellé refusé · ${r.what === 'grant' ? 'droit' : 'manifeste'} ${r.storeId}${r.e !== undefined ? ` (${r.e}, ${r.g})` : ''}`,
        'refusé',
        r.reason
      );
    }
    // Un droit retiré : la base disparaît, ses lignes et ses clés sont effacées
    for (const [storeId, base] of this.bases) {
      if (!grants.has(storeId)) {
        base.mirror.wipe();
        this.bases.delete(storeId);
        await this.opts.cache.drop(storeId).catch(() => undefined);
        this.journal(`base retirée de l’accès · ${base.manifest?.title ?? storeId}`, 'droits');
        this.emit('bases');
      }
    }
    for (const [storeId, grant] of grants) {
      const existing = this.bases.get(storeId);
      if (existing) {
        const beforeKeys = [...existing.mirror.keys.keys()].sort().join(',');
        existing.rights = grant.rights;
        existing.mirror.rights = grant.rights;
        existing.mirror.keys = grant.keys;
        existing.manifest = manifests.get(storeId) ?? existing.manifest;
        // Une clé neuve (rescellement) rouvre une base qui l'attendait
        if (beforeKeys !== [...grant.keys.keys()].sort().join(',') && existing.mirror.status === 'missing_key') {
          existing.mirror.status = 'loading';
        }
      } else {
        const mirror = new StoreMirror(storeId, grant.rights, grant.keys, {
          client,
          cache: this.opts.cache,
          site: this.opts.site,
        });
        this.bases.set(storeId, { storeId, rights: grant.rights, mirror, manifest: manifests.get(storeId) ?? null, waitUntil: 0 });
        this.emit('bases');
      }
    }
    // Le palier dit si le flux est offert (`access.stream`) : sans lui, on relève sans même essayer
    if (this.access?.stream === false) this.streamRefusedUntil = Infinity;
    else if (this.streamRefusedUntil === Infinity) this.streamRefusedUntil = 0;
    const pendingFlag = (isObj(self.access) && self.access.pending === true) || self.pending === true;
    if (pendingFlag) this.setLink('pending', 'Identité en attente d’une migration : seuls l’accès et le paquet de réglages répondent');
    else if (this.access?.paused === true) this.setLink('paused', 'Accès mis en pause dans Filarr');
    else if (WAITING.has(this.link)) this.setLink('connecting');
    this.emit('self', self);
  }

  /** Rattrape chaque magasin (un à un : le débit vers Filarr reste sage). */
  async syncAll(force = false): Promise<void> {
    for (const base of this.bases.values()) await this.syncBase(base, force);
  }

  private async syncBase(base: GateBase, force = false): Promise<void> {
    this.checkLimited();
    if (Date.now() < base.waitUntil) return;
    const started = Date.now();
    const before = base.mirror.status;
    try {
      const diff = await base.mirror.sync(force || base.mirror.status !== 'ready');
      if (diff) this.onDiff(base, diff, Date.now() - started);
    } catch (err) {
      if (err instanceof FilarrError && err.status === 403 && err.code === 'store_not_granted') {
        base.mirror.markUnavailable('refused', { code: err.code, message: 'Filarr refuse cette base à l’accès' });
        this.selfDirty = true;
        return;
      }
      if (err instanceof RateLimitError && PER_STORE_429.has(err.code)) {
        // Ce magasin attend ; les autres, et les lectures locales, continuent
        this.storeLimited(base, err);
        return;
      }
      if (err instanceof RateLimitError) base.mirror.markUnavailable('waiting', { code: err.code, message: err.message });
      else if (err instanceof UnreachableError) base.mirror.markUnavailable('offline', { code: 'unreachable', message: err.message });
      throw err;
    }
    const after = base.mirror.status;
    if (after !== before && after !== 'ready') {
      this.journal(`base ${base.manifest?.title ?? base.storeId}`, after === 'missing_key' ? 'clés' : 'vérification', base.mirror.problem?.message);
      if (after === 'missing_key') this.selfDirty = true;
    }
    if (after !== before) this.emit('bases');
  }

  private storeLimited(base: GateBase, err: RateLimitError): void {
    base.waitUntil = Date.now() + err.retryAfterMs;
    if (base.mirror.loaded) base.mirror.markUnavailable('waiting', { code: err.code, message: err.message });
    this.journal(`limite de Filarr · ${err.code} · ${base.manifest?.title ?? base.storeId}`, '429', `nouvel essai dans ${Math.ceil(err.retryAfterMs / 1000)} s`);
    this.emit('bases');
  }

  private onDiff(base: GateBase, diff: RowDiff, ms: number): void {
    const n = diff.created.length + diff.updated.length + diff.deleted.length;
    this.lastChangeAt = new Date().toISOString();
    if (n > 0 || diff.seq > 0) {
      this.journal(
        `${base.manifest?.title ?? base.storeId} v${diff.seq} reçue`,
        'synchro',
        n === 0 ? 'copie à jour' : `${n} ligne${n > 1 ? 's' : ''} changée${n > 1 ? 's' : ''}`,
        ms
      );
    }
    this.emit('change', base, diff);
  }

  /** Une validation de cette boîte noire : les webhooks suivent comme pour un changement venu de Filarr. */
  publishLocalDiff(base: GateBase, diff: RowDiff): void {
    this.lastChangeAt = new Date().toISOString();
    this.emit('change', base, diff);
  }

  // ==================== Révision 3 : import d'un paquet de réglages ====================

  /**
   * L'identité en attente d'une migration lit le paquet de réglages qui lui est
   * destiné (`GET /api-access/self/import`, `gate-heberge-1` § 8.4) et l'ouvre.
   * `null` : aucun paquet déposé (pas encore, ou l'ancienne boîte était hors ligne).
   */
  async fetchImport(): Promise<GateSettings | null> {
    const client = this.client;
    const identity = this.identity;
    if (!client || !identity) throw new Error('aucun jeton en service');
    let res: { sealed?: unknown } | null;
    try {
      res = await client.json<{ sealed?: unknown } | null>('GET', 'api-access/self/import');
    } catch (err) {
      if (err instanceof FilarrError && (err.status === 404 || err.code === 'export_not_ready' || err.code === 'migration_not_ready')) return null;
      throw err;
    }
    if (!res || typeof res.sealed !== 'string') return null;
    return openSettings(storeCrypto, curves, identity.aEnc, res.sealed, identity.accessId);
  }

  // ==================== Boucle ====================

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !TERMINAL.has(this.link)) {
      try {
        const wait = this.notBefore - Date.now();
        if (wait > 0) {
          this.setLink('limited', `Filarr limite cet accès (${this.limitedCode}) : reprise à ${new Date(this.notBefore).toISOString()}`);
          await sleep(wait, signal);
          continue;
        }
        if (WAITING.has(this.link)) {
          await this.sleepInterruptible(this.opts.pausedRetryMs ?? 300_000, signal);
          if (signal.aborted) break;
          await this.refreshSelf();
          if (!WAITING.has(this.link)) {
            await this.syncAll();
            this.setLink('connecting');
          }
          continue;
        }
        if (this.selfDirty) {
          await this.refreshSelf();
          await this.syncAll();
        }
        if (!this.streamRefused) {
          const outcome = await this.runStream(signal);
          if (outcome === 'tier') {
            this.streamRefusedUntil = Infinity;
            this.journal('flux des changements refusé pour le palier', 'relève', `relève toutes les ${Math.round(this.pollIntervalMs / 1000)} s`);
            continue;
          }
          if (outcome === 'quota') continue;
          if (signal.aborted || TERMINAL.has(this.link)) break;
          if (WAITING.has(this.link)) continue;
          // Fermé ou injoignable : délai croissant, puis reconnexion
          if (this.link !== 'limited') this.setLink('offline', 'Flux des changements interrompu : reconnexion…');
          await sleep(this.nextBackoff(), signal);
          continue;
        }
        // Relève (sans flux)
        this.setLink('polling', `Relève toutes les ${Math.round(this.pollIntervalMs / 1000)} s`);
        await this.pollOnce();
        this.backoff = this.opts.backoffMinMs ?? 1000;
        await this.sleepInterruptible(this.pollIntervalMs, signal);
      } catch (err) {
        await this.handleError(err);
        if (TERMINAL.has(this.link)) break;
        // Un 429 attend son heure en tête de boucle ; toute autre erreur, un délai croissant
        if (!(err instanceof RateLimitError)) await sleep(this.nextBackoff(), signal);
      }
    }
  }

  private nextBackoff(): number {
    const current = this.backoff;
    this.backoff = Math.min(this.opts.backoffMaxMs ?? 60_000, this.backoff * 2);
    // Un peu de hasard : plusieurs boîtes noires ne reviennent pas toutes à la même seconde
    return Math.round(current * (0.8 + Math.random() * 0.4));
  }

  private sleepInterruptible(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      const onAbort = () => done();
      const self = this;
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (self.wakeLoop === done) self.wakeLoop = null;
        resolve();
      }
      this.wakeLoop = done;
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Une relève : `changes` de chaque magasin, puis la tête de ceux qui ont bougé. */
  async pollOnce(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const selfEvery = [...this.bases.values()].some((b) => b.mirror.status === 'missing_key')
      ? (this.opts.selfIntervalMs ?? 1_800_000)
      : Math.max(this.opts.selfIntervalMs ?? 1_800_000, 6 * 3_600_000);
    if (this.selfDirty || !this.lastSelfAt || Date.now() - Date.parse(this.lastSelfAt) >= selfEvery) {
      await this.refreshSelf();
    }
    if (WAITING.has(this.link)) return;
    for (const base of this.bases.values()) {
      this.checkLimited();
      if (Date.now() < base.waitUntil) continue;
      if (base.mirror.status !== 'ready' || base.mirror.seq === 0) {
        await this.syncBase(base, true);
        continue;
      }
      try {
        const changes = await client.json<ChangesResponse>('GET', `dbstore/${base.storeId}/changes?since=${base.mirror.seq}`);
        if (isNat(changes.seq) && changes.seq > base.mirror.seq) await this.syncBase(base);
      } catch (err) {
        if (err instanceof FilarrError && err.status === 410) {
          await this.syncBase(base, true);
          continue;
        }
        if (err instanceof RateLimitError && PER_STORE_429.has(err.code)) {
          this.storeLimited(base, err);
          continue;
        }
        throw err;
      }
    }
  }

  /** Le flux des changements ; rend quand il se ferme. */
  private async runStream(signal: AbortSignal): Promise<'closed' | 'tier' | 'quota' | 'refused'> {
    const client = this.client!;
    const opener = this.opener;
    if (signal.aborted || !opener) return 'closed';
    const url = client.url('api-access/self/stream');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let resolveClosed!: (o: 'closed' | 'tier' | 'quota' | 'refused') => void;
    const closed = new Promise<'closed' | 'tier' | 'quota' | 'refused'>((r) => (resolveClosed = r));
    let settled = false;
    let alive = true;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const finish = (outcome: 'closed' | 'tier' | 'quota' | 'refused') => {
      if (settled) return;
      settled = true;
      if (heartbeat) clearInterval(heartbeat);
      signal.removeEventListener('abort', onAbort);
      this.socket = null;
      resolveClosed(outcome);
    };
    const onAbort = () => {
      this.socket?.terminate();
      finish('closed');
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const outcome = await opener(url, client.headers(), {
      onOpen: () => {
        // Arrêtée entre-temps : la montée réussie n'ouvre plus rien
        if (signal.aborted || settled) return;
        this.backoff = this.opts.backoffMinMs ?? 1000;
        this.setLink('live', 'Flux des changements ouvert');
        heartbeat = setInterval(() => {
          if (!alive) {
            this.socket?.terminate();
            return;
          }
          alive = false;
          // Le relais n'accepte qu'un ping applicatif (il rend un pong) : tout autre envoi ferme le flux
          try {
            this.socket?.send(JSON.stringify({ t: 'ping' }));
          } catch {
            this.socket?.terminate();
          }
        }, 30_000);
        // Ce qui a pu se passer pendant la coupure
        void this.catchUp();
      },
      onMessage: (text) => {
        if (signal.aborted || settled) return;
        alive = true;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return;
        }
        void this.onMessage(msg);
      },
      onClose: (code, why) => {
        switch (code) {
          case CLOSE_REVOKED:
            void this.revoked(
              why === 'api_access_token_rotated' ? 'Jeton remplacé dans Filarr : collez le nouveau jeton' : 'Accès révoqué dans Filarr'
            ).then(() => finish('refused'));
            return;
          case CLOSE_EXPIRED:
            void this.revoked('Accès expiré', 'expired').then(() => finish('refused'));
            return;
          case CLOSE_PAUSED:
            this.setLink('paused', 'Accès mis en pause dans Filarr');
            return finish('refused');
          case CLOSE_CHANGED:
            // Échéance ou adresses changées : on relit self avant de rouvrir
            this.selfDirty = true;
            return finish('closed');
          case CLOSE_QUOTA:
            this.streamRefusedUntil = Date.now() + SLOW_POLL_MS;
            this.journal('flux fermé : requêtes du mois épuisées', 'quota', 'relève toutes les 900 s');
            return finish('quota');
          case CLOSE_TOO_MANY:
            this.journal('flux refusé : trop de flux ouverts pour cet accès (8 au plus)', 'flux');
            this.backoff = Math.max(this.backoff, 30_000);
            return finish('closed');
          case CLOSE_ASLEEP:
            this.setLink('asleep', 'Boîte hébergée en sommeil');
            return finish('refused');
          default:
            return finish('closed');
        }
      },
    });
    if ('refused' in outcome) {
      const { status, code, retryAfter } = outcome.refused;
      if (status === 403 && code === 'api_tier_stream') finish('tier');
      else if (status === 429 && code === 'api_quota_sync') {
        // Requêtes du mois épuisées : pas de flux avant le mois suivant, relève lente (900 s)
        this.streamRefusedUntil = Date.now() + parseRetryAfter(retryAfter, SLOW_POLL_MS);
        this.journal('flux des changements refusé : requêtes du mois épuisées', '429', 'relève toutes les 900 s');
        finish('quota');
      } else if (status === 429) {
        this.limit(code, parseRetryAfter(retryAfter));
        finish('refused');
      } else if (status >= 500 || status === 0) finish('closed');
      else {
        await this.handleError(new FilarrError(status, code, {}));
        finish('refused');
      }
      return closed;
    }
    if (signal.aborted) {
      outcome.socket.terminate();
      finish('closed');
      return closed;
    }
    this.socket = outcome.socket;
    return closed;
  }

  private async catchUp(): Promise<void> {
    try {
      if (this.selfDirty) await this.refreshSelf();
      for (const base of this.bases.values()) await this.syncBase(base);
    } catch (err) {
      await this.handleError(err);
    }
  }

  private async onMessage(msg: Record<string, unknown>): Promise<void> {
    try {
      switch (msg.t) {
        case 'commit': {
          const base = typeof msg.storeId === 'string' ? this.bases.get(msg.storeId) : undefined;
          if (base && (!isNat(msg.seq) || msg.seq > base.mirror.seq)) await this.syncBase(base);
          if (typeof msg.storeId === 'string') this.emit('commit', msg.storeId, isNat(msg.seq) ? msg.seq : null);
          break;
        }
        case 'grant':
          this.journal('droits rescellés pour cet accès', 'clés');
          await this.refreshSelf();
          await this.syncAll();
          break;
        case 'manifest':
          this.journal(`manifeste republié${typeof msg.storeId === 'string' ? ` · ${this.bases.get(msg.storeId)?.manifest?.title ?? msg.storeId}` : ''}`, 'manifeste');
          await this.refreshSelf();
          this.emit('bases');
          break;
        case 'quota': {
          const alert: QuotaAlert = {
            name: typeof msg.name === 'string' ? msg.name : 'quota',
            pct: typeof msg.pct === 'number' ? msg.pct : 0,
            at: new Date().toISOString(),
          };
          this.quotaAlerts = [alert, ...this.quotaAlerts].slice(0, 20);
          this.journal(`quota ${alert.name} à ${alert.pct} %`, 'quota');
          this.emit('quota', alert);
          break;
        }
        case 'revoked':
          await this.revoked('Accès révoqué dans Filarr');
          break;
        // ---- Révision 3 ----
        case 'files':
          if (typeof msg.depositId === 'string' && typeof msg.status === 'string') {
            this.emit('files', { depositId: msg.depositId, status: msg.status });
          }
          break;
        case 'ext-run':
          if (typeof msg.storeId === 'string' && typeof msg.defId === 'string') {
            this.emit('ext-run', { storeId: msg.storeId, defId: msg.defId, ack: isObj(msg.ack) ? msg.ack : null });
          }
          break;
        case 'export':
          if (typeof msg.encPublicKey === 'string' && typeof msg.bindSig === 'string') {
            this.journal('export des réglages demandé (migration)', 'export');
            this.emit('export', { encPublicKey: msg.encPublicKey, bindSig: msg.bindSig } satisfies ExportRequest);
          }
          break;
        case 'hosting':
          if (msg.state === 'asleep') this.setLink('asleep', 'Boîte hébergée en sommeil');
          this.emit('hosting', typeof msg.state === 'string' ? msg.state : null);
          break;
        case 'pong':
          break;
        default:
          break;
      }
    } catch (err) {
      await this.handleError(err);
    }
  }

  /**
   * Un RÉVEIL POUSSÉ (révision 3, § 5 bis), déjà vérifié par l'hôte (signature et
   * horodatage) : il ne porte aucun contenu, la boîte relit par ses routes.
   */
  async wake(body: NotifyBody): Promise<void> {
    if (!this.client || TERMINAL.has(this.link)) return;
    this.lastWakeAt = new Date().toISOString();
    this.emit('wake', body);
    try {
      switch (body.t) {
        case 'commit': {
          const base = body.storeId ? this.bases.get(body.storeId) : undefined;
          if (base) await this.syncBase(base);
          else await this.pollOnce();
          if (body.storeId) this.emit('commit', body.storeId, body.seq ?? null);
          break;
        }
        case 'grant':
        case 'manifest':
          await this.refreshSelf();
          await this.syncAll();
          if (body.t === 'manifest') this.emit('bases');
          break;
        case 'revoked':
          // Le réveil ne prouve rien à lui seul : on relit, et c'est le refus de Filarr qui révoque
          await this.refreshSelf();
          break;
        case 'quota':
          await this.refreshSelf();
          break;
        case 'files':
          await this.refreshSelf();
          this.emit('files', null);
          break;
        case 'ext-run':
          if (body.storeId) this.emit('ext-run', { storeId: body.storeId, defId: null, ack: null });
          break;
        case 'export': {
          // Sans flux, l'identité en attente se lit dans `self` si le serveur l'y met
          await this.refreshSelf();
          const self = this.rawSelf ?? {};
          const pending = isObj(self.export) ? self.export : isObj(self.pendingExport) ? self.pendingExport : null;
          if (pending && typeof pending.encPublicKey === 'string' && typeof pending.bindSig === 'string') {
            this.emit('export', { encPublicKey: pending.encPublicKey, bindSig: pending.bindSig } satisfies ExportRequest);
          } else {
            this.journal('export demandé par un réveil, mais l’identité en attente n’est lisible que sur le flux', 'export');
          }
          break;
        }
        case 'hosting':
          if (body.state === 'asleep') this.setLink('asleep', 'Boîte hébergée en sommeil');
          else await this.refreshSelf();
          this.emit('hosting', body.state ?? null);
          break;
        default:
          await this.pollOnce();
      }
    } catch (err) {
      await this.handleError(err);
    }
    this.wakeLoop?.();
  }

  private limit(code: string, retryAfterMs: number): void {
    this.notBefore = Math.max(this.notBefore, Date.now() + retryAfterMs);
    this.limitedCode = code;
    this.journal(`limite de Filarr · ${code}`, '429', `nouvel essai dans ${Math.ceil(retryAfterMs / 1000)} s`);
    this.setLink('limited', `Filarr limite cet accès (${code})`);
  }

  private async revoked(detail: string, state: LinkState = 'revoked'): Promise<void> {
    if (TERMINAL.has(this.link)) return;
    this.journal(detail, state === 'revoked' ? 'révoqué' : state);
    this.abort?.abort();
    this.socket?.terminate();
    this.wipeAll();
    await this.opts.cache.clear().catch(() => undefined);
    this.setLink(state, detail);
    this.emit('bases');
  }

  private async handleError(err: unknown): Promise<void> {
    if (err instanceof RateLimitError) {
      this.limit(err.code, err.retryAfterMs);
      return;
    }
    if (err instanceof UnreachableError) {
      this.setLink('offline', err.message);
      return;
    }
    if (err instanceof FilarrError) {
      switch (err.code) {
        case 'api_access_revoked':
          return this.revoked('Accès révoqué dans Filarr');
        case 'api_access_expired':
          return this.revoked('Accès expiré', 'expired');
        case 'api_access_unknown':
          return this.revoked('Filarr ne connaît pas ce jeton', 'unknown_access');
        case 'api_access_paused':
          this.setLink('paused', 'Accès mis en pause dans Filarr');
          return;
        case 'api_base_not_switched':
          this.setLink('not_switched', 'Les accès API ne sont pas encore ouverts pour ce compte Filarr');
          return;
        case 'api_ip_forbidden':
          this.setLink('ip_forbidden', 'Filarr refuse l’adresse IP de cette machine pour cet accès');
          return;
        case 'api_access_pending':
          this.setLink('pending', 'Identité en attente d’une migration : seuls l’accès et le paquet de réglages répondent');
          return;
        case 'hosting_asleep':
          this.setLink('asleep', 'Boîte hébergée en sommeil');
          return;
        case 'store_not_granted':
          this.selfDirty = true;
          return;
        default:
          // 426 client_upgrade_required : cette version ne parle plus le protocole ; websocket_required n'en est pas un
          if (err.status === 426 && err.code !== 'websocket_required') {
            this.setLink('upgrade_required', 'Cette version de Filarr Gate est trop ancienne pour l’API Filarr');
            return;
          }
          this.journal('erreur de Filarr', String(err.status), err.code);
          this.setLink('error', `Filarr a refusé (${err.status} ${err.code})`);
          return;
      }
    }
    this.journal('erreur interne de la réplique', 'erreur', (err as Error)?.message);
    this.setLink('error', (err as Error)?.message ?? String(err));
  }
}
