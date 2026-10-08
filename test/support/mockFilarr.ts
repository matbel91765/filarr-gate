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
  deriveAccessKeys,
  formatAccessToken,
  grantPlaintext,
  nextSlug,
  sealToKey,
} from '../../src/core/engine/store/apiAccess';
import { isCover } from '../../src/core/engine/store/codec';
import { fromBase64Url, personalStoreId, storeKeys, toBase64Url, utf8Encode, type StoreKeys } from '../../src/core/engine/store/crypto';
import { HlcClock } from '../../src/core/engine/store/hlc';
import type { StoreOp } from '../../src/core/engine/store/registers';
import type { DbProperty, DbRow, DbView } from '../../src/core/types';
import { curves, storeCrypto as c } from '../../src/crypto/providers';
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
}

export interface NewStore {
  dbId: string;
  title: string;
  properties: DbProperty[];
  rows: DbRow[];
  views?: DbView[];
}

type MeterKind = 'self' | 'stream' | 'head' | 'changes' | 'slots' | 'stage' | 'commit';

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
type GateOutcome = { refusal: { status: number; code: string; extra?: Record<string, unknown>; headers?: Record<string, string> } } | { access: MockAccess };

export class MockFilarr {
  readonly fek = randomBytes(32);
  readonly site = randomBytes(4).toString('hex');
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

  private async newProof(): Promise<{ token: string; id: string; authHash: string; aPub: string; idBytes: Uint8Array }> {
    const idBytes = randomBytes(16);
    const secret = randomBytes(32);
    const keys = await deriveAccessKeys(c, curves, idBytes, secret);
    return { token: formatAccessToken(idBytes, secret), id: toBase64Url(idBytes), authHash: await accessAuthHash(c, keys.aAuth), aPub: keys.aPub, idBytes };
  }

  /** Crée un accès et rend son jeton (montré une fois, jamais gardé par le serveur). */
  async createAccess(name: string, tier: Tier = 'pro'): Promise<{ token: string; accessId: string }> {
    const proof = await this.newProof();
    this.accesses.set(proof.id, {
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
  async rotateToken(accessId: string): Promise<string> {
    const access = this.accesses.get(accessId)!;
    // L'identifiant de l'accès reste ; la preuve et la paire changent
    const idBytes = fromBase64Url(accessId);
    const secret = randomBytes(32);
    const keys = await deriveAccessKeys(c, curves, idBytes, secret);
    this.signal(access, { t: 'revoked' }, { code: CLOSE.revoked, reason: 'api_access_token_rotated' });
    access.authHash = await accessAuthHash(c, keys.aAuth);
    access.aPub = keys.aPub;
    for (const [storeId, grant] of access.grants) await this.grant(accessId, storeId, grant.rights);
    return formatAccessToken(idBytes, secret);
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
    if (!m || !access || createHash('sha256').update(fromBase64Url(m[2]!)).digest('hex') !== access.authHash) {
      return { refusal: { status: 401, code: 'api_access_unknown' } };
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
    const route =
      path === '/api-access/self' && method === 'GET'
        ? { kind: 'self' as MeterKind, storeId: undefined, action: 'self' }
        : path === '/api-access/self/stream' && method === 'GET'
          ? { kind: 'stream' as MeterKind, storeId: undefined, action: 'stream' }
          : this.dbStoreRoute(method, path);
    let access: MockAccess | null = null;
    let headers: Record<string, string> = {};
    if (!isApp) {
      if (!route) return refuse(401, 'session_required');
      const injected = this.takeInjection(method, path);
      if (injected) return refuse(injected.status, injected.code, {}, injected.retryAfter !== undefined ? { 'Retry-After': String(injected.retryAfter) } : {});
      const outcome = this.gate(req, route.kind, route.storeId);
      if ('refusal' in outcome) return refuse(outcome.refusal.status, outcome.refusal.code, outcome.refusal.extra ?? {}, outcome.refusal.headers ?? {});
      access = outcome.access;
      accessId = access.id;
      headers = this.quotaHeaders(access);
    } else if (!route) {
      return refuse(404, 'not_found');
    }

    if (route!.kind === 'stream') return refuse(426, 'websocket_required', {}, headers);
    if (route!.kind === 'self' && access) {
      const lim = this.limitsOf(access.tier);
      log(200);
      return json(res, 200, {
        success: true,
        data: {
          access: {
            id: access.id,
            name: access.name,
            encPublicKey: access.aPub,
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
