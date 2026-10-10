/**
 * UN FILARR EN MÉMOIRE, pour les essais et le banc local (`npm run mock-filarr`).
 *
 * Deux moitiés :
 *  - le SERVEUR : ce que le worker de Filarr ouvre à une boîte noire (contrat
 *    `api-base-1` § 5 et § 6, et le code du worker qui l'implémente :
 *    `apiGate.ts`, `apiAccess.ts`, `apiMeter.ts`, `dbStore.ts`) — l'ordre des
 *    refus, la génération du § 2, le compare-and-swap de `db-store-1` § 8, le
 *    compteur (débit, relève par magasin et par nature, quotas), les en-têtes,
 *    le flux (8 au plus par accès, `ping`/`pong`, fermetures 4301 à 4307) et
 *    `/public/api-limits` ;
 *  - l'APPLICATION du créateur : elle tient la racine (FEK), écrit les magasins
 *    avec la VRAIE réplique de Filarr (`test/helpers/appReplica.ts`), scelle les
 *    droits vers `A_pub`, publie les manifestes, monte une génération, révoque,
 *    remplace le jeton.
 *
 * Ce n'est pas le worker : c'est sa lecture, pour éprouver la boîte noire sans réseau.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  accessAuthHash,
  assignSlugs,
  bindMessage,
  deriveAccessKeys,
  formatAccessToken,
  grantPlaintext,
  nextSlug,
  sealToKey,
  toBase64Std,
} from '../../packages/core/src/engine/store/apiAccess';
import { computeCreatorTag, deriveAccessKeys3, notifyHeader } from '../../packages/core/src/engine/gate/access3';
import { openJson, queueAad, resolveAad, sealJson, signDef, statusAad, statusKey, type ExtSourceDef, type QueueEntry, type SyncStatus } from '../../packages/core/src/engine/extsrc';
import { boxSigMessage } from '../../packages/core/src/engine/gate/files';
import { isCover } from '../../packages/core/src/engine/store/codec';
import { fromBase64Url, personalStoreId, storeKeys, toBase64Url, utf8Encode, type StoreKeys } from '../../packages/core/src/engine/store/crypto';
import { HlcClock } from '../../packages/core/src/engine/store/hlc';
import type { StoreOp } from '../../packages/core/src/engine/store/registers';
import type { DbProperty, DbRow, DbView } from '../../packages/core/src/types';
import { curves, storeCrypto as c } from '../../packages/gate/src/crypto/providers';
import {
  StoreReplica,
  slotRefKey,
  type CommitRequest,
  type CommitResponse,
  type SlotRef,
  type StoreTransport,
} from '../helpers/appReplica';

// ==================== Le barème (worker `apiLimits.ts`, contrat § 6) ====================

export type Tier = 'free' | 'solo' | 'pro' | 'teams' | 'enterprise';

export interface ApiLimits {
  accesses: number;
  storesPerAccess: number;
  write: boolean;
  writesPerDay: number;
  syncPerMonth: number;
  bytesPerMonth: number;
  ratePerMinute: number;
  stream: boolean;
  pollIntervalS: number;
  eventsRetentionDays: number;
  ipAllowlist: boolean;
}

const GIB = 1024 ** 3;

export const API_LIMITS: Record<Tier, ApiLimits> = {
  free: { accesses: 1, storesPerAccess: 1, write: false, writesPerDay: 0, syncPerMonth: 10_000, bytesPerMonth: GIB, ratePerMinute: 30, stream: false, pollIntervalS: 300, eventsRetentionDays: 7, ipAllowlist: false },
  solo: { accesses: 3, storesPerAccess: 3, write: true, writesPerDay: 1_000, syncPerMonth: 100_000, bytesPerMonth: 10 * GIB, ratePerMinute: 120, stream: true, pollIntervalS: 0, eventsRetentionDays: 30, ipAllowlist: false },
  pro: { accesses: 20, storesPerAccess: 20, write: true, writesPerDay: 20_000, syncPerMonth: 1_000_000, bytesPerMonth: 100 * GIB, ratePerMinute: 600, stream: true, pollIntervalS: 0, eventsRetentionDays: 90, ipAllowlist: true },
  teams: { accesses: 100, storesPerAccess: 100, write: true, writesPerDay: 100_000, syncPerMonth: 5_000_000, bytesPerMonth: 500 * GIB, ratePerMinute: 1_200, stream: true, pollIntervalS: 0, eventsRetentionDays: 365, ipAllowlist: true },
  enterprise: { accesses: 100, storesPerAccess: 100, write: true, writesPerDay: 100_000, syncPerMonth: 5_000_000, bytesPerMonth: 500 * GIB, ratePerMinute: 1_200, stream: true, pollIntervalS: 0, eventsRetentionDays: 365, ipAllowlist: true },
};

/** Flux simultanés d'un même accès (worker `API_STREAMS_PER_ACCESS`). */
export const STREAMS_PER_ACCESS = 8;
export const CLOSE = { revoked: 4301, paused: 4302, changed: 4303, expired: 4304, quota: 4305, tooMany: 4306, unexpected: 4307 } as const;

// ==================== État ====================

interface MockSlot {
  ver: number;
  e: number;
  g: number;
}

interface MockStore {
  storeId: string;
  dbId: string;
  title: string;
  epoch: number;
  g: number;
  seq: number;
  headToken: string | null;
  hk: { e: number; g: number } | null;
  slots: Map<string, MockSlot>;
  log: Array<{ seq: number; slots: Array<{ p: string; ver: number; e: number; g?: number }>; removed: string[] }>;
  views: Array<DbView & { slug?: string }>;
  replica: StoreReplica | null;
}

interface MockAccess {
  id: string;
  name: string;
  authHash: string;
  aPub: string;
  tier: Tier;
  revoked: boolean;
  paused: boolean;
  expiresAt: string | null;
  createdAt: string;
  grants: Map<string, { rights: 'r' | 'rw'; keys: Array<{ e: number; g: number; sealed: string }> }>;
  manifests: Map<string, { sealed: string; rev: number }>;
  usage: { sync: number; bytes: number; writes: number };
  minute: number;
  minuteCount: number;
  /** Dernière relève, par `<nature>:<magasin>` (worker : `polls`). */
  polls: Map<string, number>;
  sockets: Set<WebSocket>;
  baseSlugs: Map<string, string>;
  // ---- Révision 3 ----
  /** `creatorTag` (null : accès d'avant la révision 3, ou créé sans étiquette). */
  creatorTag: string | null;
  /** `bind_sig` (base64 standard), signé par la clé du créateur sur `A_pub`. */
  bindSig: string;
  /** `A_notify` (le serveur en garde la copie pour signer les réveils). */
  notifyKey: Uint8Array | null;
  notifyUrl: string | null;
  files: { requestId: string; publicKey: string; boxSig: string } | null;
  /** Identité en attente d'une migration (gate-heberge-1 § 8.4). */
  pending: { authHash: string; aPub: string; bindSig: string; exportSealed: string | null; seenAt: string | null; expiresAt: string } | null;
  /** Boîte hébergée (marque `hosting` dans `self`). */
  hosted: boolean;
}

export interface MockDeposit {
  depositId: string;
  accessId: string;
  seq: number;
  sealedFileKey: string;
  encryptedManifest: string;
  encryptedManifestIv: string;
  totalChunks: number;
  sizeBytes: number;
  chunks: Map<number, Uint8Array>;
  status: 'uploading' | 'deposited' | 'filed' | 'rejected' | 'expired';
  depositedAt: string | null;
  filedAt: string | null;
  createdAt: string;
}

export interface AccessOptions {
  /** L'étiquette du créateur : juste (d'office), absente, ou faite avec une autre clé. */
  tag?: 'good' | 'none' | 'other-key';
  /** `bind_sig` : juste (d'office), ou signée par une autre clé. */
  bindSig?: 'good' | 'other-key';
  notifyUrl?: string;
}

interface Injection {
  match: (method: string, path: string) => boolean;
  status: number;
  code: string;
  retryAfter?: number;
  times: number;
}

export interface MockOptions {
  /** `API_BASE_SWITCH` pour le compte du créateur. */
  baseSwitch?: boolean;
  /** `API_BASE_WRITE` pour le compte du créateur. */
  writeSwitch?: boolean;
  /** Écart minimal entre deux relèves d'un magasin en Free, en millisecondes (300 s au contrat). */
  freePollMs?: number;
  /** Serveur de la révision 3 (`creator`, fichiers, réveils, migration) ; `false` : un serveur rév. 2. */
  rev3?: boolean;
}

export interface NewStore {
  dbId: string;
  title: string;
  properties: DbProperty[];
  rows: DbRow[];
  views?: DbView[];
}

type MeterKind = 'self' | 'stream' | 'head' | 'changes' | 'slots' | 'stage' | 'commit' | 'files' | 'export' | 'import' | 'ext';

/** L'état des synchros externes d'un magasin, dans l'objet `DbStore` (`source-externe-1` § 12.1). */
interface MockExt {
  statuses: Map<string, { rev: number; e: number; g: number; sealed: string; updatedAt: string }>;
  queues: Map<string, { rev: number; e: number; g: number; sealed: string; updatedAt: string }>;
  /** Le bail : exécutant ET instance (précision P1 ; `""` sans instance). */
  leases: Map<string, { runnerId: string; instance: string; until: number }>;
  mailbox: Map<string, Array<{ seq: number; sealed: string; defId: string }>>;
  seq: number;
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const fail = (res: ServerResponse, status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  json(res, status, { success: false, error: code, code, ...extra }, headers);

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const newToken = (): string => toBase64Url(randomBytes(16));

/** L'entrée d'un bloc à la forme du contrat : `g` omis quand il vaut 0. */
const slotRef = (p: string, ver: number, e: number, g = 0) => (g > 0 ? { p, ver, e, g } : { p, ver, e });

/** Ce que la porte décide d'une requête : un refus, ou l'accès qui passe. */
type GateOutcome = { refusal: { status: number; code: string; extra?: Record<string, unknown>; headers?: Record<string, string> } } | { access: MockAccess; pending?: boolean };

export class MockFilarr {
  readonly fek = randomBytes(32);
  readonly site = randomBytes(4).toString('hex');
  // ---- Révision 3 : le compte du créateur et sa boîte de dépôt ----
  /** Clé d'identité (signature Ed25519) du compte du créateur. */
  readonly creatorSigningKey = new Uint8Array(randomBytes(32));
  readonly creatorSigningPublicKey = toBase64Std(curves.ed25519PublicKey(this.creatorSigningKey));
  readonly creatorUserId = 'u_createur_essai';
  /** La boîte de dépôt permanente du créateur (clé X25519 ; la privée reste à l'appli). */
  readonly boxPrivateKey = new Uint8Array(randomBytes(32));
  readonly boxPublicKey = toBase64Url(curves.x25519PublicKey(this.boxPrivateKey));
  readonly boxRequestId = 'req_entrees_api';
  readonly deposits = new Map<string, MockDeposit>();
  filesSwitch = true;
  /** Dépôts non rangés de la boîte (tous canaux) : 200 au plus. */
  pendingMax = 200;
  rev3: boolean;
  /** Les réveils envoyés (adresse, statut rendu). */
  readonly notifications: Array<{ url: string; status: number; body: string }> = [];
  readonly stores = new Map<string, MockStore>();
  readonly accesses = new Map<string, MockAccess>();
  /** Corps chiffrés, par `storeId|p|ver` ou `storeId|head|seq` (le R2 du worker). */
  readonly bodies = new Map<string, Uint8Array>();
  readonly staged = new Map<string, Uint8Array>();
  /** Les requêtes reçues (méthode et chemin), pour les essais. */
  readonly requests: Array<{ method: string; path: string; status: number; access?: string; code?: string }> = [];
  baseSwitch: boolean;
  writeSwitch: boolean;
  freePollMs: number;
  private injections: Injection[] = [];
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  url = '';

  constructor(opts: MockOptions = {}) {
    this.baseSwitch = opts.baseSwitch ?? true;
    this.writeSwitch = opts.writeSwitch ?? true;
    this.freePollMs = opts.freePollMs ?? 300_000;
    this.rev3 = opts.rev3 ?? true;
  }

  /** Le barème d'un palier, tel que le mock l'applique (relève Free réglable pour les essais). */
  limitsOf(tier: Tier): ApiLimits {
    const l = { ...API_LIMITS[tier] };
    if (l.pollIntervalS > 0) l.pollIntervalS = this.freePollMs / 1000;
    return l;
  }

  // ==================== Le côté de l'application (créateur) ====================

  /** Les clés d'un magasin à (e, g), dérivées de la racine — ce que seul un membre peut faire. */
  rootKeys(storeId: string, e: number, g: number): Promise<StoreKeys> {
    return storeKeys(c, this.fek, storeId, e, g);
  }

  /** Le transport en mémoire de la réplique de l'application (qui ignore la génération : g = 0, sans `hk`). */
  private appTransport(store: MockStore): StoreTransport {
    return {
      head: async () => ({ seq: store.seq, head: store.headToken ? (this.bodies.get(store.headToken) ?? null) : null }),
      slots: async (refs: SlotRef[]) => {
        const out = new Map<string, Uint8Array | null>();
        for (const r of refs) out.set(slotRefKey(r.p, r.ver), this.bodyOf(store, r.p, r.ver));
        return out;
      },
      stage: async (body: Uint8Array) => {
        const token = newToken();
        this.staged.set(token, body);
        return token;
      },
      commit: async (req: CommitRequest): Promise<CommitResponse> => {
        const outcome = this.applyCommit(store, {
          baseSeq: req.baseSeq,
          slots: req.slots.map((s) => ({ p: s.p, ver: s.ver, e: s.e, ...(s.body ? { body: s.body } : { stage: s.stage }) })),
          removed: req.removed,
          head: req.head,
          hk: null,
        });
        if (outcome.ok) return { ok: true, seq: outcome.seq };
        if (outcome.code === 'seq_conflict') return { ok: false, code: 'seq_conflict', seq: store.seq };
        return { ok: false, code: outcome.code };
      },
    };
  }

  /** Une base passe au magasin, écrite par la réplique de l'application (g = 0). */
  async createStore(spec: NewStore): Promise<string> {
    const storeId = await personalStoreId(c, this.fek, spec.dbId);
    const store: MockStore = {
      storeId,
      dbId: spec.dbId,
      title: spec.title,
      epoch: 0,
      g: 0,
      seq: 0,
      headToken: null,
      hk: null,
      slots: new Map(),
      log: [],
      views: spec.views ?? [{ id: 'v-main', name: 'Tableau', type: 'table', filters: [], sorts: [] }],
      replica: null,
    };
    this.stores.set(storeId, store);
    const keys = await this.rootKeys(storeId, 0, 0);
    store.replica = new StoreReplica(c, { current: keys, all: [keys] }, this.appTransport(store), new HlcClock(this.site), { dbId: spec.dbId });
    await store.replica.load();
    await store.replica.migrate(spec.rows, { properties: spec.properties, collation: 'fr' });
    return storeId;
  }

  /** Un geste dans l'application (g = 0 seulement : la réplique de Filarr ignore la génération). */
  async appEdit(storeId: string, edits: Array<{ r: string; f: string; v?: unknown }>): Promise<number> {
    const store = this.mustStore(storeId);
    const replica = store.replica!;
    await replica.refresh();
    const ops: StoreOp[] = edits.map((e) => ({ ...e, t: replica.tick() }));
    replica.apply(ops);
    const res = await replica.flush();
    return res?.seq ?? store.seq;
  }

  /** Les lignes que voit l'application. */
  async appRows(storeId: string): Promise<DbRow[]> {
    const replica = this.mustStore(storeId).replica!;
    await replica.refresh();
    return replica.rows();
  }

  mustStore(storeId: string): MockStore {
    const s = this.stores.get(storeId);
    if (!s) throw new Error(`magasin inconnu ${storeId}`);
    return s;
  }

  /**
   * Ce que l'appareil du créateur calcule pendant que le jeton existe en mémoire :
   * la preuve, la clé publique, et (révision 3) l'étiquette du créateur, `A_notify`
   * et `bind_sig`. Le serveur n'en garde que ce que le contrat lui laisse.
   */
  private async newProof(
    idBytes: Uint8Array = new Uint8Array(randomBytes(16)),
    opts: AccessOptions = {}
  ): Promise<{ token: string; id: string; authHash: string; aPub: string; idBytes: Uint8Array; creatorTag: string | null; notifyKey: Uint8Array; bindSig: string }> {
    const secret = new Uint8Array(randomBytes(32));
    const id = toBase64Url(idBytes);
    const keys = await deriveAccessKeys(c, curves, idBytes, secret);
    const keys3 = await deriveAccessKeys3(c, idBytes, secret);
    const other = new Uint8Array(randomBytes(32));
    const tagKey = opts.tag === 'other-key' ? toBase64Std(curves.ed25519PublicKey(other)) : this.creatorSigningPublicKey;
    const creatorTag = opts.tag === 'none' ? null : await computeCreatorTag(c, keys3.aMac, id, tagKey);
    const bindSig = toBase64Std(curves.ed25519Sign(opts.bindSig === 'other-key' ? other : this.creatorSigningKey, bindMessage(id, keys.aPub)));
    return {
      token: formatAccessToken(idBytes, secret),
      id,
      authHash: await accessAuthHash(c, keys.aAuth),
      aPub: keys.aPub,
      idBytes,
      creatorTag,
      notifyKey: keys3.aNotify,
      bindSig,
    };
  }

  /** Crée un accès et rend son jeton (montré une fois, jamais gardé par le serveur). */
  async createAccess(name: string, tier: Tier = 'pro', opts: AccessOptions = {}): Promise<{ token: string; accessId: string }> {
    const proof = await this.newProof(undefined, opts);
    this.accesses.set(proof.id, {
      creatorTag: proof.creatorTag,
      bindSig: proof.bindSig,
      notifyKey: proof.notifyKey,
      notifyUrl: opts.notifyUrl ?? null,
      files: null,
      pending: null,
      hosted: false,
      id: proof.id,
      name,
      authHash: proof.authHash,
      aPub: proof.aPub,
      tier,
      revoked: false,
      paused: false,
      expiresAt: null,
      createdAt: new Date().toISOString(),
      grants: new Map(),
      manifests: new Map(),
      usage: { sync: 0, bytes: 0, writes: 0 },
      minute: 0,
      minuteCount: 0,
      polls: new Map(),
      sockets: new Set(),
      baseSlugs: new Map(),
    });
    return { token: proof.token, accessId: proof.id };
  }

  /**
   * Remplace le jeton (`POST /api-access/:id/rotate-token`) : nouvelle paire, tout est rescellé
   * vers elle ; les flux de l'ancien jeton reçoivent `revoked` et ferment en 4301.
   */
  async rotateToken(accessId: string, opts: AccessOptions = {}): Promise<string> {
    const access = this.accesses.get(accessId)!;
    // L'identifiant de l'accès reste ; la preuve et la paire changent (l'étiquette aussi, révision 3)
    const proof = await this.newProof(fromBase64Url(accessId), opts);
    this.signal(access, { t: 'revoked' }, { code: CLOSE.revoked, reason: 'api_access_token_rotated' });
    access.authHash = proof.authHash;
    access.aPub = proof.aPub;
    access.creatorTag = proof.creatorTag;
    access.bindSig = proof.bindSig;
    access.notifyKey = proof.notifyKey;
    for (const [storeId, grant] of access.grants) await this.grant(accessId, storeId, grant.rights);
    return proof.token;
  }

  // ==================== Révision 3 : fichiers, réveils, migration ====================

  /** Lie la boîte de dépôt du créateur à l'accès (`PUT /api-access/:id/files`), signée par sa clé d'identité. */
  linkFiles(accessId: string, opts: { signedBy?: 'creator' | 'other'; publicKey?: string } = {}): void {
    const access = this.accesses.get(accessId)!;
    const publicKey = opts.publicKey ?? this.boxPublicKey;
    const key = opts.signedBy === 'other' ? new Uint8Array(randomBytes(32)) : this.creatorSigningKey;
    const boxSig = toBase64Url(curves.ed25519Sign(key, boxSigMessage(accessId, this.boxRequestId, publicKey)));
    access.files = { requestId: this.boxRequestId, publicKey, boxSig };
  }

  /** L'appli range (ou refuse) un dépôt : la boîte noire l'apprend par le flux, jamais où ni sous quel nom. */
  fileDeposit(depositId: string, result: 'filed' | 'rejected' = 'filed'): void {
    const d = this.deposits.get(depositId)!;
    d.status = result;
    d.filedAt = new Date().toISOString();
    const access = this.accesses.get(d.accessId);
    if (access) this.signal(access, { t: 'files', depositId, status: result });
  }

  /** Les dépôts non rangés de la boîte (tous canaux). */
  private pendingDeposits(): { n: number; bytes: number } {
    let n = 0;
    let bytes = 0;
    for (const d of this.deposits.values()) {
      if (d.status !== 'deposited') continue;
      n += 1;
      bytes += d.sizeBytes;
    }
    return { n, bytes };
  }

  /**
   * Démarre une migration (`POST /api-access/:id/hosting/migrate`) : une identité
   * NEUVE en attente ; l'ancienne reste en service et reçoit `export` sur son flux.
   */
  async migrateStart(accessId: string, opts: AccessOptions = {}): Promise<string> {
    const access = this.accesses.get(accessId)!;
    const proof = await this.newProof(fromBase64Url(accessId), opts);
    access.pending = { authHash: proof.authHash, aPub: proof.aPub, bindSig: proof.bindSig, exportSealed: null, seenAt: null, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() };
    this.signal(access, { t: 'export', encPublicKey: proof.aPub, bindSig: proof.bindSig });
    return proof.token;
  }

  /** Bascule (`POST …/hosting/migrate/commit`) : l'identité en attente devient celle de l'accès ; l'ancien jeton est refusé. */
  async migrateCommit(accessId: string): Promise<void> {
    const access = this.accesses.get(accessId)!;
    const p = access.pending!;
    this.signal(access, { t: 'revoked' }, { code: CLOSE.revoked, reason: 'api_access_token_rotated' });
    access.authHash = p.authHash;
    access.aPub = p.aPub;
    access.bindSig = p.bindSig;
    access.pending = null;
    for (const [storeId, grant] of access.grants) await this.grant(accessId, storeId, grant.rights);
  }

  /** Boîte hébergée qui s'endort : son flux ferme en 4308. */
  sleepHosted(accessId: string): void {
    const access = this.accesses.get(accessId)!;
    access.hosted = true;
    this.signal(access, { t: 'hosting', state: 'asleep' }, { code: 4308, reason: 'hosting_asleep' });
  }

  /** Un réveil poussé, signé sous `A_notify` (api-base-1 rév. 3 § 5 bis). */
  private async pushNotify(access: MockAccess, msg: Record<string, unknown>): Promise<void> {
    if (!access.notifyUrl || !access.notifyKey || !this.rev3) return;
    const body = JSON.stringify({ a: access.id, t: msg.t, ...(msg.storeId ? { storeId: msg.storeId } : {}), ...(typeof msg.seq === 'number' ? { seq: msg.seq } : {}), ...(msg.state ? { state: msg.state } : {}), at: new Date().toISOString() });
    const header = await notifyHeader(c, access.notifyKey, body, Math.floor(Date.now() / 1000));
    try {
      const res = await fetch(access.notifyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Filarr-Notify': header }, body, redirect: 'manual' });
      await res.arrayBuffer().catch(() => undefined);
      this.notifications.push({ url: access.notifyUrl, status: res.status, body });
    } catch {
      this.notifications.push({ url: access.notifyUrl, status: 0, body });
    }
  }

  /** Les couples (e, g) en usage dans un magasin, plus le courant. */
  private keysInUse(store: MockStore): Array<{ e: number; g: number }> {
    const set = new Map<string, { e: number; g: number }>();
    for (const s of store.slots.values()) set.set(`${s.e}|${s.g}`, { e: s.e, g: s.g });
    if (store.hk) set.set(`${store.hk.e}|${store.hk.g}`, store.hk);
    set.set(`${store.epoch}|${store.g}`, { e: store.epoch, g: store.g });
    return [...set.values()];
  }

  /** Scelle les clés d'un magasin vers l'accès (devoir de rescellement, § 3). */
  async grant(accessId: string, storeId: string, rights: 'r' | 'rw', opts: { skip?: Array<{ e: number; g: number }> } = {}): Promise<void> {
    const access = this.accesses.get(accessId)!;
    const store = this.mustStore(storeId);
    const keys: Array<{ e: number; g: number; sealed: string }> = [];
    for (const { e, g } of this.keysInUse(store)) {
      if (opts.skip?.some((k) => k.e === e && k.g === g)) continue;
      const k = await this.rootKeys(storeId, e, g);
      const text = grantPlaintext({ a: accessId, s: storeId, e, g }, k.kDb);
      keys.push({ e, g, sealed: await sealToKey(c, curves, access.aPub, utf8Encode(text)) });
    }
    access.grants.set(storeId, { rights, keys });
    await this.publishManifest(accessId, storeId);
    this.signal(access, { t: 'grant' });
  }

  /** Un droit scellé glissé à la mauvaise place (un autre magasin) : la boîte noire doit le refuser. */
  async plantForeignGrant(accessId: string, storeId: string, fromStoreId: string): Promise<void> {
    const access = this.accesses.get(accessId)!;
    const k = await this.rootKeys(fromStoreId, 0, 0);
    const text = grantPlaintext({ a: accessId, s: fromStoreId, e: 0, g: 0 }, k.kDb);
    const sealed = await sealToKey(c, curves, access.aPub, utf8Encode(text));
    access.grants.set(storeId, { rights: 'r', keys: [{ e: 0, g: 0, sealed }] });
  }

  /** Le manifeste d'un AUTRE magasin recopié sous celui-ci : la boîte noire doit le refuser. */
  plantForeignManifest(accessId: string, storeId: string, fromStoreId: string): void {
    const access = this.accesses.get(accessId)!;
    const foreign = access.manifests.get(fromStoreId)!;
    access.manifests.set(storeId, { sealed: foreign.sealed, rev: foreign.rev });
  }

  /** Le manifeste d'un magasin, scellé vers l'accès (§ 4), slugs gardés d'une publication à l'autre. */
  async publishManifest(accessId: string, storeId: string): Promise<void> {
    const access = this.accesses.get(accessId)!;
    const store = this.mustStore(storeId);
    let slug = access.baseSlugs.get(storeId);
    if (!slug) {
      slug = nextSlug(store.title, 'base', new Set(access.baseSlugs.values()));
      access.baseSlugs.set(storeId, slug);
    }
    const viewSlugs = assignSlugs(store.views.map((v) => v.name), 'vue');
    const views = store.views.map((v, i) => ({ ...v, slug: v.slug ?? viewSlugs[i] }));
    const plain = JSON.stringify({
      v: 1,
      a: accessId,
      s: storeId,
      slug,
      title: store.title,
      rights: access.grants.get(storeId)?.rights ?? 'r',
      views,
      updated: new Date().toISOString(),
    });
    const previous = access.manifests.get(storeId);
    const rev = (previous?.rev ?? 0) + 1;
    access.manifests.set(storeId, { sealed: await sealToKey(c, curves, access.aPub, utf8Encode(plain)), rev });
    if (previous) this.signal(access, { t: 'manifest', storeId, rev });
  }

  /** Monte la génération d'un magasin (§ 2) ; rescelle pour les accès restants, sauf demande contraire. */
  async bumpGeneration(storeId: string, opts: { reseal?: boolean } = {}): Promise<number> {
    const store = this.mustStore(storeId);
    store.g += 1;
    if (opts.reseal !== false) {
      for (const access of this.accesses.values()) {
        const grant = access.grants.get(storeId);
        if (grant && !access.revoked) await this.grant(access.id, storeId, grant.rights);
      }
    }
    return store.g;
  }

  /** Révoque : refus immédiat, `revoked` et fermeture 4301 des flux, montée de génération de ses magasins. */
  async revoke(accessId: string): Promise<void> {
    const access = this.accesses.get(accessId)!;
    access.revoked = true;
    this.signal(access, { t: 'revoked' }, { code: CLOSE.revoked, reason: 'api_access_revoked' });
    for (const storeId of access.grants.keys()) await this.bumpGeneration(storeId);
  }

  /** Met en pause (`PATCH { paused: true }`) : flux fermés en 4302. */
  pause(accessId: string, paused = true): void {
    const access = this.accesses.get(accessId)!;
    access.paused = paused;
    if (paused) this.signal(access, null, { code: CLOSE.paused, reason: 'api_access_paused' });
  }

  quota(accessId: string, name: 'sync' | 'bytes' | 'writes', pct: number): void {
    this.signal(this.accesses.get(accessId)!, { t: 'quota', name, pct });
  }

  /** Les prochaines requêtes qui correspondent reçoivent ce refus. */
  failNext(match: (method: string, path: string) => boolean, status: number, code: string, opts: { retryAfter?: number; times?: number } = {}): void {
    this.injections.push({ match, status, code, ...(opts.retryAfter !== undefined ? { retryAfter: opts.retryAfter } : {}), times: opts.times ?? 1 });
  }

  private signal(access: MockAccess, msg: unknown, close?: { code: number; reason: string }): void {
    for (const s of access.sockets) {
      if (msg !== null) s.send(JSON.stringify(msg));
      if (close) s.close(close.code, close.reason);
    }
    // Révision 3 : le même événement en réveil poussé, SANS contenu (`export` ne porte que `{a, t}` :
    // la cible se lit dans `self.pendingExport`, précision « export sans flux »)
    const m = msg as Record<string, unknown> | null;
    if (m && typeof m.t === 'string') void this.pushNotify(access, m);
  }

  // ==================== L'automate du magasin (`dbStoreObject.ts`) ====================

  private bodyOf(store: MockStore, p: string, ver: number): Uint8Array | null {
    return this.bodies.get(`${store.storeId}|${p}|${ver}`) ?? null;
  }

  applyCommit(
    store: MockStore,
    body: {
      baseSeq: number;
      slots: Array<{ p: string; ver: number; e: number; g?: number; body?: Uint8Array | string; stage?: string | undefined }>;
      removed: string[];
      head: Uint8Array | string;
      hk: { e: number; g: number } | null;
    }
  ): { ok: true; seq: number } | { ok: false; code: string; status: number; extra?: Record<string, unknown> } {
    if (body.baseSeq !== store.seq) return { ok: false, code: 'seq_conflict', status: 409, extra: { seq: store.seq } };
    // La tête ET chaque bloc sous la génération COURANTE ; une tête sans `hk` vient d'un rédacteur d'avant 3.9 : g = 0
    const g = store.g;
    if ((body.hk ? body.hk.g : 0) !== g || body.slots.some((s) => (s.g ?? 0) !== g)) {
      return { ok: false, code: 'stale_generation', status: 409, extra: { g } };
    }
    for (const s of body.slots) {
      const old = store.slots.get(s.p);
      const expected = old ? old.ver + 1 : 1;
      if (s.ver !== expected) return { ok: false, code: 'slot_version', status: 409, extra: { p: s.p, expected } };
    }
    const prefixes = new Set(store.slots.keys());
    for (const p of body.removed) prefixes.delete(p);
    for (const s of body.slots) prefixes.add(s.p);
    if (!isCover([...prefixes])) return { ok: false, code: 'bad_cover', status: 422 };
    for (const s of body.slots) if (s.stage !== undefined && !this.staged.has(s.stage)) return { ok: false, code: 'stage_unknown', status: 409 };

    for (const p of body.removed) store.slots.delete(p);
    for (const s of body.slots) {
      const bytes = s.stage !== undefined ? this.staged.get(s.stage)! : typeof s.body === 'string' ? fromBase64Url(s.body) : s.body!;
      if (s.stage !== undefined) this.staged.delete(s.stage);
      this.bodies.set(`${store.storeId}|${s.p}|${s.ver}`, bytes);
      store.slots.set(s.p, { ver: s.ver, e: s.e, g });
    }
    const headToken = `${store.storeId}|head|${store.seq + 1}`;
    this.bodies.set(headToken, typeof body.head === 'string' ? fromBase64Url(body.head) : body.head);
    store.headToken = headToken;
    store.hk = body.hk ? { e: body.hk.e, g: body.hk.g } : null;
    store.seq += 1;
    store.log.push({ seq: store.seq, slots: body.slots.map((s) => slotRef(s.p, s.ver, s.e, g)), removed: body.removed });
    for (const access of this.accesses.values()) {
      if (access.grants.has(store.storeId) && !access.revoked && !access.paused) this.signal(access, { t: 'commit', storeId: store.storeId, seq: store.seq });
    }
    return { ok: true, seq: store.seq };
  }

  // ==================== La fente à fichiers (`gate-fichiers-1` § 2.1) ====================

  private async handleFiles(
    req: IncomingMessage,
    res: ServerResponse,
    access: MockAccess,
    path: string,
    method: string,
    headers: Record<string, string>,
    log: (status: number, code?: string) => void,
    refuse: (status: number, code: string, extra?: Record<string, unknown>, headers?: Record<string, string>) => void
  ): Promise<void> {
    const rest = path.slice('/api-access/self/files'.length);
    if (!this.filesSwitch) return refuse(409, 'files_not_switched', {}, headers);
    if (access.tier === 'free' || access.tier === 'solo') return refuse(403, 'api_tier_files', { remedy: ['upgrade'] }, headers);
    if (!access.files) return refuse(409, 'files_not_linked', {}, headers);
    if (rest === '/init' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8')) as Record<string, unknown>;
      const size = Number(body.sizeBytes);
      if (!(typeof body.sealedFileKey === 'string' && typeof body.encryptedManifest === 'string' && typeof body.encryptedManifestIv === 'string' && Number.isInteger(body.totalChunks))) {
        return refuse(400, 'bad_request', {}, headers);
      }
      if (size > 104_857_600) return refuse(413, 'file_too_large', { limit: 104_857_600 }, headers);
      if (this.pendingDeposits().n >= this.pendingMax) return refuse(409, 'box_full', {}, headers);
      const seq = [...this.deposits.values()].filter((d) => d.accessId === access.id).length + 1;
      const depositId = newToken();
      this.deposits.set(depositId, {
        depositId,
        accessId: access.id,
        seq,
        sealedFileKey: body.sealedFileKey as string,
        encryptedManifest: body.encryptedManifest as string,
        encryptedManifestIv: body.encryptedManifestIv as string,
        totalChunks: body.totalChunks as number,
        sizeBytes: size,
        chunks: new Map(),
        status: 'uploading',
        depositedAt: null,
        filedAt: null,
        createdAt: new Date().toISOString(),
      });
      log(201);
      return json(res, 201, { success: true, data: { depositId, seq } }, headers);
    }
    const chunk = /^\/([A-Za-z0-9_-]+)\/chunk\/(\d+)$/.exec(rest);
    if (chunk && method === 'PUT') {
      const d = this.deposits.get(chunk[1]!);
      if (!d || d.accessId !== access.id) return refuse(404, 'deposit_not_found', {}, headers);
      const bytes = new Uint8Array(await readBody(req));
      if (bytes.length > 16 * 1024 * 1024 + 28) return refuse(413, 'chunk_too_large', {}, headers);
      d.chunks.set(Number(chunk[2]), bytes);
      log(200);
      return json(res, 200, { success: true, data: { chunkIndex: Number(chunk[2]), sizeBytes: bytes.length } }, headers);
    }
    const fin = /^\/([A-Za-z0-9_-]+)\/finalize$/.exec(rest);
    if (fin && method === 'POST') {
      const d = this.deposits.get(fin[1]!);
      if (!d || d.accessId !== access.id) return refuse(404, 'deposit_not_found', {}, headers);
      for (let i = 0; i < d.totalChunks; i += 1) if (!d.chunks.has(i)) return refuse(409, 'chunks_missing', {}, headers);
      d.status = 'deposited';
      d.depositedAt = new Date().toISOString();
      log(200);
      return json(res, 200, { success: true, data: { status: 'deposited', depositedAt: d.depositedAt } }, headers);
    }
    const one = /^\/([A-Za-z0-9_-]+)$/.exec(rest);
    if (one && method === 'GET') {
      const d = this.deposits.get(one[1]!);
      if (!d || d.accessId !== access.id) return refuse(404, 'deposit_not_found', {}, headers);
      log(200);
      return json(res, 200, { success: true, data: { status: d.status === 'uploading' ? 'deposited' : d.status, depositedAt: d.depositedAt, filedAt: d.filedAt } }, headers);
    }
    if (rest === '' && method === 'GET') {
      const since = new URL(req.url ?? '/', 'http://x').searchParams.get('since') ?? '';
      const list = [...this.deposits.values()].filter((d) => d.accessId === access.id && d.status !== 'uploading' && (d.depositedAt ?? '') >= since);
      log(200);
      return json(res, 200, { success: true, data: { deposits: list.map((d) => ({ depositId: d.depositId, status: d.status, depositedAt: d.depositedAt, filedAt: d.filedAt })), next: null } }, headers);
    }
    return refuse(404, 'not_found', {}, headers);
  }

  // ==================== Les synchros externes (`source-externe-1` § 12.1) ====================

  readonly ext = new Map<string, MockExt>();
  /** Simule un serveur d'avant la précision « export sans flux » : `pendingExport` toujours `null`. */
  hidePendingExport = false;
  /** Chaque demande de bail reçue (magasin, définition, instance), pour les essais. */
  readonly leaseRequests: Array<{ storeId: string; defId: string; instance: string }> = [];

  extOf(storeId: string): MockExt {
    let e = this.ext.get(storeId);
    if (!e) this.ext.set(storeId, (e = { statuses: new Map(), queues: new Map(), leases: new Map(), mailbox: new Map(), seq: 0 }));
    return e;
  }

  private async handleExt(
    req: IncomingMessage,
    res: ServerResponse,
    access: MockAccess,
    path: string,
    method: string,
    headers: Record<string, string>,
    log: (status: number, code?: string) => void,
    refuse: (status: number, code: string, extra?: Record<string, unknown>, headers?: Record<string, string>) => void
  ): Promise<void> {
    const [, , storeId, action, rest] = path.split('/') as [string, string, string, string, string | undefined];
    if (!access.grants.has(storeId)) return refuse(403, 'store_not_granted', {}, headers);
    const ext = this.extOf(storeId);
    const own = `a:${access.id}`;
    const body = method === 'GET' || method === 'DELETE' ? {} : (JSON.parse((await readBody(req)).toString('utf8') || '{}') as Record<string, unknown>);
    const ok = (data: unknown) => {
      log(200);
      json(res, 200, { success: true, data }, headers);
    };
    const runnerId = rest ? decodeURIComponent(rest) : undefined;
    if (action === 'ext-status' && method === 'GET' && !runnerId) return ok({ statuses: [...ext.statuses].map(([r, s]) => ({ runnerId: r, ...s })) });
    if ((action === 'ext-status' || action === 'ext-queue') && method === 'PUT' && runnerId) {
      if (runnerId !== own) return refuse(403, 'runner_forbidden', {}, headers);
      const map = action === 'ext-status' ? ext.statuses : ext.queues;
      const cur = map.get(runnerId);
      const rev = Number(body.rev);
      if (rev !== (cur?.rev ?? 0) + 1) return refuse(409, action === 'ext-status' ? 'ext_status_conflict' : 'ext_queue_conflict', { rev: cur?.rev ?? 0 }, headers);
      if (typeof body.sealed !== 'string' || body.sealed.length > (action === 'ext-status' ? 64 * 1024 * 1.4 : 1024 * 1024 * 1.4)) return refuse(413, 'too_large', {}, headers);
      map.set(runnerId, { rev, e: Number(body.e), g: Number(body.g), sealed: body.sealed, updatedAt: new Date().toISOString() });
      return ok({ rev });
    }
    if (action === 'ext-queue' && method === 'GET' && runnerId) {
      const q = ext.queues.get(runnerId);
      return q ? ok(q) : refuse(404, 'not_found', {}, headers);
    }
    if (action === 'ext-lease' && method === 'POST') {
      const defId = String(body.defId);
      if (body.runnerId !== own) return refuse(403, 'runner_forbidden', {}, headers);
      // Précision P1 : l'instance du processus ; absente (client d'avant) = ""
      const instance = body.instance ?? '';
      if (body.instance != null && (typeof body.instance !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(body.instance))) return refuse(400, 'bad_request', {}, headers);
      this.leaseRequests.push({ storeId, defId, instance: String(instance) });
      const cur = ext.leases.get(defId);
      if (cur && (cur.runnerId !== own || cur.instance !== instance) && cur.until > Date.now()) {
        return refuse(409, 'extdb_lease_held', { runnerId: cur.runnerId, until: new Date(cur.until).toISOString(), remedy: ['wait'] }, headers);
      }
      const until = Date.now() + Math.min(3600, Math.max(120, Number(body.ttlS) || 120)) * 1000;
      ext.leases.set(defId, { runnerId: own, instance: String(instance), until });
      return ok({ until: new Date(until).toISOString() });
    }
    if (action === 'ext-lease' && method === 'DELETE' && runnerId) {
      // `runnerId` est ici la définition (`…/ext-lease/:defId?instance=`)
      const instance = new URL(req.url ?? '/', 'http://x').searchParams.get('instance') ?? '';
      const cur = ext.leases.get(runnerId);
      const released = cur?.runnerId === own && cur.instance === instance;
      if (released) ext.leases.delete(runnerId);
      return ok({ released });
    }
    if (action === 'ext-resolve' && runnerId && runnerId === own) {
      const box = ext.mailbox.get(runnerId) ?? [];
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      if (method === 'GET') return ok({ items: box.filter((d) => d.seq > Number(q.get('after') ?? 0)).slice(0, 500).map(({ seq, sealed }) => ({ seq, sealed })) });
      if (method === 'DELETE') {
        const upTo = Number(q.get('upTo') ?? 0);
        ext.mailbox.set(runnerId, box.filter((d) => d.seq > upTo));
        return ok({ ok: true });
      }
    }
    return refuse(404, 'not_found', {}, headers);
  }

  /** L'appli écrit une définition (signée par la clé du créateur, ou d'un autre compte) dans le schéma du magasin. */
  async appSetExtSource(storeId: string, def: Record<string, unknown> | null, opts: { signer?: 'creator' | 'other'; managedBy?: boolean } = {}): Promise<Record<string, unknown> | null> {
    const store = this.mustStore(storeId);
    const replica = store.replica!;
    await replica.refresh();
    const schema = replica.schema()!;
    let signed: Record<string, unknown> | null = null;
    if (def) {
      const key = opts.signer === 'other' ? new Uint8Array(randomBytes(32)) : this.creatorSigningKey;
      signed = signDef(curves, { ...def, signer: (def.signer as string | undefined) ?? this.creatorUserId } as unknown as ExtSourceDef, key) as unknown as Record<string, unknown>;
    }
    const extra = { ...(schema.extra ?? {}) } as Record<string, unknown>;
    if (signed) extra.extSource = signed;
    else delete extra.extSource;
    const map = (signed?.map ?? []) as Array<{ col: string; prop: string; dir: string }>;
    const properties = schema.properties.map((p) => {
      const m = map.find((x) => x.prop === p.id);
      if (!opts.managedBy || !m) return p;
      return { ...p, managedBy: { src: signed!.id, dir: m.dir, col: m.col } } as typeof p;
    });
    const { t: _t, ...rest } = schema;
    void _t;
    replica.setSchema({ ...rest, properties, extra });
    await replica.flush();
    return signed;
  }

  /** Les clés `K_xs` d'un magasin à sa génération courante (ce que dérive tout membre). */
  private async kxs(storeId: string): Promise<{ key: Uint8Array; e: number; g: number }> {
    const store = this.mustStore(storeId);
    const k = await this.rootKeys(storeId, store.epoch, store.g);
    return { key: await statusKey(c, k.kDb, storeId), e: store.epoch, g: store.g };
  }

  /** Un membre tranche des conflits : décisions scellées sous `K_xs`, déposées dans la boîte aux lettres de l'exécutant. */
  async appDecide(storeId: string, runnerId: string, defId: string, decisions: Array<{ id: string; choice: string }>, by = { userId: 'u_membre', device: 'PC de Camille' }): Promise<number> {
    const ext = this.extOf(storeId);
    const { key } = await this.kxs(storeId);
    const box = ext.mailbox.get(runnerId) ?? [];
    for (const d of decisions) {
      ext.seq += 1;
      box.push({ seq: ext.seq, defId, sealed: await sealJson(c, key, { id: d.id, choice: d.choice, by, at: new Date().toISOString() }, resolveAad(storeId, runnerId)) });
    }
    ext.mailbox.set(runnerId, box);
    // Le dépôt déclenche un passage (`ext-run`)
    const accessId = runnerId.slice(2);
    const access = this.accesses.get(accessId);
    if (access) this.signal(access, { t: 'ext-run', storeId, defId });
    return ext.seq;
  }

  /** `POST /dbstore/:id/ext-run` d'un membre (avec un accord pour CE passage, au besoin). */
  appExtRun(storeId: string, runnerId: string, defId: string, ack?: Record<string, unknown>): void {
    const access = this.accesses.get(runnerId.slice(2));
    if (access) this.signal(access, { t: 'ext-run', storeId, defId, ...(ack ? { ack } : {}) });
  }

  /** Ce qu'un membre lit de l'état publié (et de la file) : ouverts sous `K_xs`. */
  async appReadStatus(storeId: string, runnerId: string): Promise<{ status: SyncStatus | null; queue: { entries: QueueEntry[] } | null }> {
    const ext = this.extOf(storeId);
    const st = ext.statuses.get(runnerId);
    const q = ext.queues.get(runnerId);
    const open = async <T>(item: { e: number; g: number; sealed: string; rev: number } | undefined, aad: (rev: number) => string): Promise<T | null> => {
      if (!item) return null;
      const k = await this.rootKeys(storeId, item.e, item.g);
      return openJson<T>(c, await statusKey(c, k.kDb, storeId), item.sealed, aad(item.rev));
    };
    return {
      status: await open<SyncStatus>(st, (rev) => statusAad(storeId, runnerId, rev)),
      queue: await open<{ entries: QueueEntry[] }>(q, (rev) => queueAad(storeId, runnerId, rev)),
    };
  }

  // ==================== La porte (`apiGate.ts`) ====================

  private quotaHeaders(access: MockAccess): Record<string, string> {
    const lim = this.limitsOf(access.tier);
    return {
      'RateLimit-Limit': String(lim.ratePerMinute),
      'RateLimit-Remaining': String(Math.max(0, lim.ratePerMinute - access.minuteCount)),
      'RateLimit-Reset': String(60 - (Math.floor(Date.now() / 1000) % 60)),
      'X-Filarr-Quota': `sync=${access.usage.sync}/${lim.syncPerMonth}; bytes=${access.usage.bytes}/${lim.bytesPerMonth}; writes=${access.usage.writes}/${lim.writesPerDay}`,
    };
  }

  /** L'ordre des refus du worker : capacités, preuve, révocation, échéance, interrupteur, pause, palier, compteur. */
  private gate(req: IncomingMessage, kind: MeterKind, storeId?: string): GateOutcome {
    const caps = String(req.headers['x-filarr-sync-caps'] ?? '').split(',').map((s) => s.trim());
    if (!caps.includes('db-store-1') || !caps.includes('api-base-1')) return { refusal: { status: 426, code: 'client_upgrade_required' } };
    const m = /^Filarr-Access ([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
    const access = m ? this.accesses.get(m[1]!) : undefined;
    const proofHash = m ? createHash('sha256').update(fromBase64Url(m[2]!)).digest('hex') : '';
    // Révision 3 : l'identité en attente d'une migration n'ouvre que `self` et `self/import`
    const pending = !!access && access.pending !== null && proofHash === access.pending.authHash;
    if (!m || !access || (proofHash !== access.authHash && !pending)) {
      return { refusal: { status: 401, code: 'api_access_unknown' } };
    }
    if (pending) {
      if (kind !== 'self' && kind !== 'import') return { refusal: { status: 403, code: 'api_access_pending' } };
      access.pending!.seenAt = new Date().toISOString();
      return { access, pending: true };
    }
    if (access.revoked) return { refusal: { status: 401, code: 'api_access_revoked' } };
    if (access.expiresAt && Date.now() >= Date.parse(access.expiresAt)) return { refusal: { status: 401, code: 'api_access_expired' } };
    if (!this.baseSwitch) return { refusal: { status: 403, code: 'api_base_not_switched' } };
    if (access.paused) return { refusal: { status: 403, code: 'api_access_paused' } };
    const lim = this.limitsOf(access.tier);
    if (kind === 'stage' || kind === 'commit') {
      if (!lim.write) return { refusal: { status: 403, code: 'api_tier_write' } };
      if (!this.writeSwitch) return { refusal: { status: 403, code: 'api_write_unavailable' } };
    }
    if (kind === 'stream' && !lim.stream) return { refusal: { status: 403, code: 'api_tier_stream' } };
    // Le compteur
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    if (access.minute !== minute) {
      access.minute = minute;
      access.minuteCount = 0;
    }
    const headers = this.quotaHeaders(access);
    if (access.minuteCount >= lim.ratePerMinute) {
      const retry = Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000));
      return { refusal: { status: 429, code: 'api_rate', headers: { ...headers, 'Retry-After': String(retry) }, extra: { retryAfter: retry } } };
    }
    const pollKey = (kind === 'head' || kind === 'changes') && storeId ? `${kind}:${storeId}` : null;
    if (pollKey && lim.pollIntervalS > 0) {
      const last = access.polls.get(pollKey);
      if (last !== undefined && now - last < lim.pollIntervalS * 1000) {
        const retry = Math.max(1, Math.ceil((last + lim.pollIntervalS * 1000 - now) / 1000));
        return { refusal: { status: 429, code: 'api_poll_interval', headers: { ...headers, 'Retry-After': String(retry) }, extra: { retryAfter: retry } } };
      }
    }
    access.minuteCount += 1;
    access.usage.sync += 1;
    if (pollKey) access.polls.set(pollKey, now);
    return { access };
  }

  // ==================== Le serveur ====================

  async listen(port = 0, host = '127.0.0.1'): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        if (!res.headersSent) fail(res, 500, 'mock_error', { error: String(err) });
      });
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const reject = (status: number, code: string, headers: Record<string, string> = {}) => {
        const text = JSON.stringify({ success: false, code, error: code });
        socket.write(
          `HTTP/1.1 ${status} Refused\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n` +
            Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') +
            `Connection: close\r\n\r\n${text}`
        );
        socket.destroy();
        this.requests.push({ method: 'GET', path: '/api-access/self/stream', status, code });
      };
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path !== '/api-access/self/stream') return reject(401, 'session_required');
      const injected = this.takeInjection('GET', path);
      if (injected) return reject(injected.status, injected.code, injected.retryAfter !== undefined ? { 'Retry-After': String(injected.retryAfter) } : {});
      const outcome = this.gate(req, 'stream');
      if ('refusal' in outcome) return reject(outcome.refusal.status, outcome.refusal.code, outcome.refusal.headers);
      const access = outcome.access;
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.requests.push({ method: 'GET', path, status: 101, access: access.id });
        if (access.sockets.size >= STREAMS_PER_ACCESS) {
          ws.close(CLOSE.tooMany, 'too_many_streams');
          return;
        }
        access.sockets.add(ws);
        ws.on('close', () => access.sockets.delete(ws));
        ws.on('message', (data) => {
          const text = data.toString();
          let ping = false;
          try {
            ping = text.length <= 64 && (JSON.parse(text) as { t?: unknown }).t === 'ping';
          } catch {
            ping = false;
          }
          if (ping) ws.send(JSON.stringify({ t: 'pong' }));
          else ws.close(CLOSE.unexpected, 'unexpected_frame');
        });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    const addr = this.server.address() as AddressInfo;
    this.url = `http://${host}:${addr.port}`;
    return this.url;
  }

  async close(): Promise<void> {
    for (const a of this.accesses.values()) for (const s of a.sockets) s.terminate();
    this.wss?.close();
    this.server?.closeAllConnections?.();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Coupe les flux ouverts (une coupure de réseau, vue de la boîte noire). */
  dropStreams(): void {
    for (const a of this.accesses.values()) for (const s of a.sockets) s.terminate();
  }

  private takeInjection(method: string, path: string): Injection | null {
    const i = this.injections.findIndex((inj) => inj.match(method, path));
    if (i < 0) return null;
    const inj = this.injections[i]!;
    inj.times -= 1;
    if (inj.times <= 0) this.injections.splice(i, 1);
    return inj;
  }

  /** Ce qu'une boîte noire peut appeler sous `/dbstore` (worker `dbStoreGateRoute`), sinon `null`. */
  private dbStoreRoute(method: string, path: string): { kind: MeterKind; storeId: string; action: string } | null {
    const m = /^\/dbstore\/([A-Za-z0-9_-]{22})\/(head|changes|stage|commit|slots:batchGet|slots\/[^/]+\/[^/]+)$/.exec(path);
    if (!m) return null;
    const [, storeId, action] = m as unknown as [string, string, string];
    if (method === 'GET' && action === 'head') return { kind: 'head', storeId, action };
    if (method === 'GET' && action === 'changes') return { kind: 'changes', storeId, action };
    if (method === 'GET' && action.startsWith('slots/')) return { kind: 'slots', storeId, action };
    if (method === 'POST' && action === 'slots:batchGet') return { kind: 'slots', storeId, action };
    if (method === 'PUT' && action === 'stage') return { kind: 'stage', storeId, action };
    if (method === 'POST' && action === 'commit') return { kind: 'commit', storeId, action };
    return null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    let accessId: string | undefined;
    const log = (status: number, code?: string) => this.requests.push({ method, path, status, ...(accessId ? { access: accessId } : {}), ...(code ? { code } : {}) });
    const refuse = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
      log(status, code);
      fail(res, status, code, extra, headers);
    };

    if (path === '/public/api-limits' && method === 'GET') {
      log(200);
      return json(res, 200, { success: true, data: { version: 1, tiers: API_LIMITS } }, { 'Cache-Control': 'public, max-age=3600' });
    }

    // L'application (créateur), pour écrire après une montée de génération
    const isApp = req.headers.authorization === 'Bearer mock-app';
    const rev3Route =
      this.rev3 && path.startsWith('/api-access/self/files')
        ? { kind: 'files' as MeterKind, storeId: undefined, action: 'files' }
        : this.rev3 && path === '/api-access/self/export' && method === 'PUT'
          ? { kind: 'export' as MeterKind, storeId: undefined, action: 'export' }
          : this.rev3 && path === '/api-access/self/import' && method === 'GET'
            ? { kind: 'import' as MeterKind, storeId: undefined, action: 'import' }
            : this.rev3 && /^\/dbstore\/[A-Za-z0-9_-]{22}\/ext-(status|lease|queue|resolve)(\/|$)/.test(path)
              ? { kind: 'ext' as MeterKind, storeId: path.split('/')[2], action: 'ext' }
              : null;
    const route =
      path === '/api-access/self' && method === 'GET'
        ? { kind: 'self' as MeterKind, storeId: undefined, action: 'self' }
        : path === '/api-access/self/stream' && method === 'GET'
          ? { kind: 'stream' as MeterKind, storeId: undefined, action: 'stream' }
          : (rev3Route ?? this.dbStoreRoute(method, path));
    let access: MockAccess | null = null;
    let pending = false;
    let headers: Record<string, string> = {};
    if (!isApp) {
      if (!route) return refuse(401, 'session_required');
      const injected = this.takeInjection(method, path);
      if (injected) return refuse(injected.status, injected.code, {}, injected.retryAfter !== undefined ? { 'Retry-After': String(injected.retryAfter) } : {});
      const outcome = this.gate(req, route.kind, route.storeId);
      if ('refusal' in outcome) return refuse(outcome.refusal.status, outcome.refusal.code, outcome.refusal.extra ?? {}, outcome.refusal.headers ?? {});
      access = outcome.access;
      pending = outcome.pending === true;
      accessId = access.id;
      headers = this.quotaHeaders(access);
    } else if (!route) {
      return refuse(404, 'not_found');
    }

    if (route!.kind === 'stream') return refuse(426, 'websocket_required', {}, headers);
    if (route!.kind === 'self' && access && pending) {
      // Vue réduite de l'identité en attente (gate-heberge-1 § 8.4)
      log(200);
      return json(res, 200, {
        success: true,
        data: {
          access: { id: access.id, name: access.name, encPublicKey: access.pending!.aPub, bindSig: access.pending!.bindSig, pending: true },
          creator: { userId: this.creatorUserId, signingPublicKey: this.creatorSigningPublicKey, tag: access.creatorTag },
          grants: [],
          manifests: [],
        },
      });
    }
    if (route!.kind === 'files' && access) return this.handleFiles(req, res, access, path, method, headers, log, refuse);
    if (route!.kind === 'ext' && access) return this.handleExt(req, res, access, path, method, headers, log, refuse);
    if (route!.kind === 'export' && access) {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { sealed?: unknown };
      if (!access.pending) return refuse(409, 'migration_not_pending', {}, headers);
      if (typeof body.sealed !== 'string') return refuse(400, 'bad_request', {}, headers);
      access.pending.exportSealed = body.sealed;
      log(200);
      return json(res, 200, { success: true, data: { ok: true } }, headers);
    }
    if (route!.kind === 'import' && access) {
      if (!pending || !access.pending?.exportSealed) return refuse(404, 'export_not_ready', {}, headers);
      log(200);
      return json(res, 200, { success: true, data: { sealed: access.pending.exportSealed } }, headers);
    }
    if (route!.kind === 'self' && access) {
      const lim = this.limitsOf(access.tier);
      log(200);
      return json(res, 200, {
        success: true,
        data: {
          ...(this.rev3
            ? {
                creator: { userId: this.creatorUserId, signingPublicKey: this.creatorSigningPublicKey, tag: access.creatorTag },
                files: access.files
                  ? {
                      ...access.files,
                      pending: this.pendingDeposits(),
                      limits: { maxFileBytes: 104_857_600, filesPerMonth: 2000, fileBytesPerMonth: 20 * GIB, pendingMax: this.pendingMax },
                      usage: { files: [...this.deposits.values()].filter((d) => d.status !== 'uploading').length, fileBytes: 0 },
                    }
                  : null,
                hosting: access.hosted ? { hostName: 'essai-0000' } : null,
                // « Export sans flux » : la cible d'un export attendu de cette boîte, jusqu'au dépôt
                pendingExport:
                  access.pending && access.pending.exportSealed === null && !this.hidePendingExport
                    ? { encPublicKey: access.pending.aPub, bindSig: access.pending.bindSig, expiresAt: access.pending.expiresAt }
                    : null,
              }
            : {}),
          access: {
            id: access.id,
            name: access.name,
            encPublicKey: access.aPub,
            ...(this.rev3 ? { bindSig: access.bindSig } : {}),
            expiresAt: access.expiresAt,
            ipAllowlist: null,
            createdAt: access.createdAt,
            tier: access.tier,
            write: lim.write && this.writeSwitch,
            stream: lim.stream,
          },
          // Le droit EFFECTIF : `rw` se lit `r` sans écriture au palier ou sans l'interrupteur
          grants: [...access.grants].map(([storeId, g]) => ({ storeId, rights: g.rights === 'rw' && lim.write && this.writeSwitch ? 'rw' : 'r', keys: g.keys })),
          manifests: [...access.manifests].map(([storeId, m]) => ({ storeId, sealed: m.sealed, rev: m.rev })),
          limits: lim,
          usage: {
            period: new Date().toISOString().slice(0, 7),
            day: new Date().toISOString().slice(0, 10),
            sync: { n: access.usage.sync, max: lim.syncPerMonth },
            bytes: { n: access.usage.bytes, max: lim.bytesPerMonth },
            writes: { n: access.usage.writes, max: lim.writesPerDay },
            writesMonth: access.usage.writes,
            access: { ...access.usage },
          },
        },
      }, headers);
    }

    const { storeId, action } = route as { storeId: string; action: string };
    const store = this.stores.get(storeId);
    const grant = access ? access.grants.get(storeId) : { rights: 'rw' as const };
    if (!store || !grant) return refuse(403, 'store_not_granted', {}, headers);
    const countBytes = (n: number) => {
      if (access) access.usage.bytes += n;
    };

    if (action === 'head') {
      const head = store.headToken ? this.bodies.get(store.headToken)! : null;
      if (head) countBytes(head.length);
      log(200);
      return json(res, 200, { success: true, data: { seq: store.seq, head: head ? toBase64Url(head) : null, hk: head ? store.hk : null, g: store.g } }, headers);
    }
    if (action === 'changes') {
      const since = Number(url.searchParams.get('since') ?? '0');
      const slots = new Map<string, { p: string; ver: number; e: number; g?: number }>();
      const removed = new Set<string>();
      for (const e of store.log.filter((x) => x.seq > since)) {
        for (const s of e.slots) slots.set(s.p, s);
        for (const p of e.removed) removed.add(p);
      }
      log(200);
      return json(res, 200, { success: true, data: { seq: store.seq, slots: [...slots.values()], removed: [...removed] } }, headers);
    }
    if (action === 'slots:batchGet') {
      const body = JSON.parse((await readBody(req)).toString('utf8')) as { slots: Array<{ p: string; ver: number }>; maxBytes?: number };
      const maxBytes = body.maxBytes ?? 2 * 1024 * 1024;
      const out: Array<Record<string, unknown>> = [];
      let total = 0;
      let more = false;
      for (const r of body.slots) {
        const bytes = this.bodyOf(store, r.p, r.ver);
        const size = bytes?.length ?? 0;
        if (out.length > 0 && total + size > maxBytes) {
          more = true;
          break;
        }
        total += size;
        out.push(bytes ? { p: r.p, ver: r.ver, body: toBase64Url(bytes) } : { p: r.p, ver: r.ver, missing: true });
      }
      countBytes(total);
      log(200);
      return json(res, 200, { success: true, data: { slots: out, more } }, headers);
    }
    if (action.startsWith('slots/')) {
      const [, rawP, rawVer] = action.split('/');
      const bytes = this.bodyOf(store, rawP === '-' ? '' : rawP!, Number(rawVer));
      if (!bytes) return refuse(404, 'slot_not_found', {}, headers);
      countBytes(bytes.length);
      log(200);
      res.writeHead(200, { 'content-type': 'application/octet-stream', ...headers });
      return void res.end(Buffer.from(bytes));
    }
    // Écritures : le droit `rw` (sinon `store_not_granted` avec `rights: "r"`)
    if (access && grant.rights !== 'rw') return refuse(403, 'store_not_granted', { rights: 'r' }, headers);
    const raw = await readBody(req);
    if (action === 'stage') {
      const token = newToken();
      this.staged.set(token, new Uint8Array(raw));
      log(200);
      return json(res, 200, { success: true, data: { token } }, headers);
    }
    const body = JSON.parse(raw.toString('utf8')) as Parameters<MockFilarr['applyCommit']>[1] & { hk?: { e: number; g: number } | null };
    const outcome = this.applyCommit(store, { ...body, hk: body.hk ?? null });
    if (!outcome.ok) return refuse(outcome.status, outcome.code, outcome.extra ?? {}, headers);
    if (access) access.usage.writes += 1;
    log(200);
    return json(res, 200, { success: true, data: { seq: outcome.seq } }, headers);
  }
}
