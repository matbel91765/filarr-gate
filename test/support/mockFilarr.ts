/**
 * UN FILARR EN MÉMOIRE, pour les essais et le banc local (`npm run mock-filarr`).
 *
 * Deux moitiés :
 *  - le SERVEUR : les routes que le contrat `api-base-1` § 5 ouvre à un accès
 *    (`/api-access/self`, le flux, `/dbstore/*`), avec la génération du § 2, le
 *    compare-and-swap de `db-store-1` § 8, les quotas et les en-têtes du § 6, et
 *    `/public/api-limits` ;
 *  - l'APPLICATION du créateur : elle tient la racine (FEK), écrit les magasins
 *    avec la VRAIE réplique de Filarr (`test/helpers/appReplica.ts`), scelle les
 *    droits vers `A_pub`, publie les manifestes, monte une génération, révoque.
 *
 * Ce n'est pas le worker de Filarr : c'est une lecture du contrat, écrite pour
 * éprouver la boîte noire. Le worker réel n'a pas encore les routes `api-access`.
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
import {
  fromBase64Url,
  personalStoreId,
  storeKeys,
  toBase64Url,
  utf8Encode,
  type StoreKeys,
} from '../../src/core/engine/store/crypto';
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

// ==================== Barème (contrat § 6) ====================

export type Tier = 'free' | 'solo' | 'pro' | 'teams';

export const TIER_LIMITS: Record<Tier, {
  accesses: number;
  storesPerAccess: number;
  writesPerDay: number | null;
  syncPerMonth: number;
  bytesPerMonth: number;
  ratePerMinute: number;
  live: boolean;
  pollSeconds: number | null;
  eventsDays: number;
  ipAllowlist: boolean;
}> = {
  free: { accesses: 1, storesPerAccess: 1, writesPerDay: null, syncPerMonth: 10_000, bytesPerMonth: 1e9, ratePerMinute: 30, live: false, pollSeconds: 300, eventsDays: 7, ipAllowlist: false },
  solo: { accesses: 3, storesPerAccess: 3, writesPerDay: 1_000, syncPerMonth: 100_000, bytesPerMonth: 10e9, ratePerMinute: 120, live: true, pollSeconds: null, eventsDays: 30, ipAllowlist: false },
  pro: { accesses: 20, storesPerAccess: 20, writesPerDay: 20_000, syncPerMonth: 1_000_000, bytesPerMonth: 100e9, ratePerMinute: 600, live: true, pollSeconds: null, eventsDays: 90, ipAllowlist: true },
  teams: { accesses: 100, storesPerAccess: 100, writesPerDay: 100_000, syncPerMonth: 5_000_000, bytesPerMonth: 500e9, ratePerMinute: 1_200, live: true, pollSeconds: null, eventsDays: 365, ipAllowlist: true },
};

// ==================== État ====================

interface MockSlot {
  ver: number;
  e: number;
  g: number;
  token: string;
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
  log: Array<{ seq: number; slots: Array<{ p: string; ver: number; e: number; g: number }>; removed: string[] }>;
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
  grants: Map<string, { rights: 'r' | 'rw'; keys: Array<{ e: number; g: number; sealed: string }> }>;
  manifests: Map<string, { sealed: string; rev: number }>;
  usage: { sync: number; bytes: number; writes: number };
  lastChanges: Map<string, number>;
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
  /** L'interrupteur `API_BASE_WRITE` (§ 0). */
  writeSwitch?: boolean;
  /** Relève minimale en Free, en millisecondes (300 s au contrat). */
  freePollMs?: number;
}

export interface NewStore {
  dbId: string;
  title: string;
  properties: DbProperty[];
  rows: DbRow[];
  views?: DbView[];
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
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

export class MockFilarr {
  readonly fek = randomBytes(32);
  readonly site = randomBytes(4).toString('hex');
  readonly stores = new Map<string, MockStore>();
  readonly accesses = new Map<string, MockAccess>();
  /** Corps chiffrés, par jeton (le R2 du worker). */
  readonly bodies = new Map<string, Uint8Array>();
  readonly staged = new Map<string, Uint8Array>();
  /** Les requêtes reçues (méthode et chemin), pour les essais. */
  readonly requests: Array<{ method: string; path: string; status: number; access?: string }> = [];
  writeSwitch: boolean;
  freePollMs: number;
  private injections: Injection[] = [];
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  url = '';

  constructor(opts: MockOptions = {}) {
    this.writeSwitch = opts.writeSwitch ?? true;
    this.freePollMs = opts.freePollMs ?? 300_000;
  }

  // ==================== Le côté de l'application (créateur) ====================

  /** Les clés d'un magasin à (e, g), dérivées de la racine — ce que seul un membre peut faire. */
  rootKeys(storeId: string, e: number, g: number): Promise<StoreKeys> {
    return storeKeys(c, this.fek, storeId, e, g);
  }

  /** Le transport en mémoire de la réplique de l'application. */
  private appTransport(store: MockStore): StoreTransport {
    return {
      head: async () => ({
        seq: store.seq,
        head: store.headToken ? this.bodies.get(store.headToken) ?? null : null,
      }),
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
    const clock = new HlcClock(this.site);
    store.replica = new StoreReplica(c, { current: keys, all: [keys] }, this.appTransport(store), clock, { dbId: spec.dbId });
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

  /** Crée un accès et rend son jeton (montré une fois, jamais gardé par le serveur). */
  async createAccess(name: string, tier: Tier = 'pro'): Promise<{ token: string; accessId: string }> {
    const idBytes = randomBytes(16);
    const secret = randomBytes(32);
    const token = formatAccessToken(idBytes, secret);
    const keys = await deriveAccessKeys(c, curves, idBytes, secret);
    const id = toBase64Url(idBytes);
    this.accesses.set(id, {
      id,
      name,
      authHash: await accessAuthHash(c, keys.aAuth),
      aPub: keys.aPub,
      tier,
      revoked: false,
      paused: false,
      expiresAt: null,
      grants: new Map(),
      manifests: new Map(),
      usage: { sync: 0, bytes: 0, writes: 0 },
      lastChanges: new Map(),
      sockets: new Set(),
      baseSlugs: new Map(),
    });
    return { token, accessId: id };
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
    this.push(access, { t: 'grant' });
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
    access.manifests.set(storeId, { sealed: await sealToKey(c, curves, access.aPub, utf8Encode(plain)), rev: (previous?.rev ?? 0) + 1 });
    if (previous) this.push(access, { t: 'manifest', storeId, rev: (previous.rev ?? 0) + 1 });
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

  /** Révoque un accès : refus immédiat, message au flux, montée de génération de ses magasins. */
  async revoke(accessId: string): Promise<void> {
    const access = this.accesses.get(accessId)!;
    access.revoked = true;
    this.push(access, { t: 'revoked' });
    for (const s of access.sockets) s.close();
    for (const storeId of access.grants.keys()) await this.bumpGeneration(storeId);
  }

  quota(accessId: string, name: string, pct: number): void {
    this.push(this.accesses.get(accessId)!, { t: 'quota', name, pct });
  }

  /** Les prochaines requêtes qui correspondent reçoivent ce refus. */
  failNext(match: (method: string, path: string) => boolean, status: number, code: string, opts: { retryAfter?: number; times?: number } = {}): void {
    this.injections.push({ match, status, code, ...(opts.retryAfter !== undefined ? { retryAfter: opts.retryAfter } : {}), times: opts.times ?? 1 });
  }

  private push(access: MockAccess, msg: unknown): void {
    for (const s of access.sockets) s.send(JSON.stringify(msg));
  }

  // ==================== L'automate du magasin ====================

  /** Un corps par (p, ver) ; une version remplacée reste servie (30 jours au contrat). */
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
      hk: { e: number; g?: number } | null;
    }
  ): { ok: true; seq: number } | { ok: false; code: string; status: number; extra?: Record<string, unknown> } {
    if (body.baseSeq !== store.seq) return { ok: false, code: 'seq_conflict', status: 409, extra: { seq: store.seq } };
    const hkG = body.hk?.g ?? 0;
    if (body.hk && hkG !== store.g) return { ok: false, code: 'stale_generation', status: 409, extra: { g: store.g } };
    for (const s of body.slots) {
      if ((s.g ?? 0) !== store.g) return { ok: false, code: 'stale_generation', status: 409, extra: { g: store.g } };
      const old = store.slots.get(s.p);
      const expected = old ? old.ver + 1 : 1;
      if (s.ver !== expected) return { ok: false, code: 'slot_version', status: 409, extra: { p: s.p, expected } };
      if (s.stage !== undefined && !this.staged.has(s.stage)) return { ok: false, code: 'stage_unknown', status: 409 };
    }
    const prefixes = new Set(store.slots.keys());
    for (const p of body.removed) prefixes.delete(p);
    for (const s of body.slots) prefixes.add(s.p);
    if (!isCover([...prefixes])) return { ok: false, code: 'bad_cover', status: 422 };

    for (const p of body.removed) store.slots.delete(p);
    for (const s of body.slots) {
      const bytes = s.stage !== undefined ? this.staged.get(s.stage)! : typeof s.body === 'string' ? fromBase64Url(s.body) : s.body!;
      if (s.stage !== undefined) this.staged.delete(s.stage);
      const token = `${store.storeId}|${s.p}|${s.ver}`;
      this.bodies.set(token, bytes);
      store.slots.set(s.p, { ver: s.ver, e: s.e, g: s.g ?? 0, token });
    }
    const headToken = `${store.storeId}|head|${store.seq + 1}`;
    this.bodies.set(headToken, typeof body.head === 'string' ? fromBase64Url(body.head) : body.head);
    store.headToken = headToken;
    store.hk = body.hk ? { e: body.hk.e, g: hkG } : null;
    store.seq += 1;
    store.log.push({
      seq: store.seq,
      slots: body.slots.map((s) => ({ p: s.p, ver: s.ver, e: s.e, g: s.g ?? 0 })),
      removed: body.removed,
    });
    for (const access of this.accesses.values()) {
      if (access.grants.has(store.storeId) && !access.revoked) this.push(access, { t: 'commit', storeId: store.storeId, seq: store.seq });
    }
    return { ok: true, seq: store.seq };
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
          `HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : status === 401 ? 'Unauthorized' : status === 429 ? 'Too Many Requests' : 'Error'}\r\n` +
            `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n` +
            Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') +
            `Connection: close\r\n\r\n${text}`
        );
        socket.destroy();
      };
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path !== '/api-access/self/stream') return reject(404, 'not_found');
      const auth = this.authAccess(req);
      if (typeof auth === 'string') return reject(auth === 'api_access_paused' ? 403 : 401, auth);
      if (!TIER_LIMITS[auth.tier].live) return reject(403, 'api_tier_stream');
      const injected = this.takeInjection('GET', path);
      if (injected) return reject(injected.status, injected.code, injected.retryAfter !== undefined ? { 'Retry-After': String(injected.retryAfter) } : {});
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        auth.sockets.add(ws);
        ws.on('close', () => auth.sockets.delete(ws));
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
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server?.closeAllConnections?.();
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

  /** L'accès qui présente sa preuve, ou le code de refus (§ 5). */
  private authAccess(req: IncomingMessage): MockAccess | string {
    const header = req.headers.authorization ?? '';
    const m = /^Filarr-Access ([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(header);
    if (!m) return 'api_access_unknown';
    const access = this.accesses.get(m[1]!);
    if (!access) return 'api_access_unknown';
    const hash = createHash('sha256').update(fromBase64Url(m[2]!)).digest('hex');
    if (hash !== access.authHash) return 'api_access_unknown';
    if (access.revoked) return 'api_access_revoked';
    if (access.expiresAt && Date.parse(access.expiresAt) < Date.now()) return 'api_access_expired';
    if (access.paused) return 'api_access_paused';
    return access;
  }

  private quotaHeaders(access: MockAccess): Record<string, string> {
    const lim = TIER_LIMITS[access.tier];
    return {
      'RateLimit-Limit': String(lim.ratePerMinute),
      'RateLimit-Remaining': String(Math.max(0, lim.ratePerMinute - 1)),
      'RateLimit-Reset': '60',
      'X-Filarr-Quota': `sync=${access.usage.sync}/${lim.syncPerMonth}; bytes=${access.usage.bytes}/${lim.bytesPerMonth}; writes=${access.usage.writes}/${lim.writesPerDay ?? 0}`,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const log = (status: number, access?: string) => this.requests.push({ method, path, status, ...(access ? { access } : {}) });

    if (path === '/public/api-limits' && method === 'GET') {
      log(200);
      return json(res, 200, { success: true, data: { tiers: TIER_LIMITS, enterprise: 'teams' } }, { 'Cache-Control': 'public, max-age=3600' });
    }

    // L'application (créateur), pour écrire après une montée de génération
    const isApp = req.headers.authorization === 'Bearer mock-app';
    let access: MockAccess | null = null;
    if (!isApp) {
      const auth = this.authAccess(req);
      if (typeof auth === 'string') {
        log(auth === 'api_access_paused' ? 403 : 401);
        return fail(res, auth === 'api_access_paused' ? 403 : 401, auth);
      }
      access = auth;
      access.usage.sync += 1;
      const caps = String(req.headers['x-filarr-sync-caps'] ?? '');
      if (!caps.includes('db-store-1') || !caps.includes('api-base-1')) {
        log(426, access.id);
        return fail(res, 426, 'client_upgrade_required');
      }
    }
    const headers = access ? this.quotaHeaders(access) : {};
    const injected = this.takeInjection(method, path);
    if (injected) {
      log(injected.status, access?.id);
      return fail(res, injected.status, injected.code, {}, {
        ...headers,
        ...(injected.retryAfter !== undefined ? { 'Retry-After': String(injected.retryAfter) } : {}),
      });
    }

    if (path === '/api-access/self' && method === 'GET' && access) {
      const lim = TIER_LIMITS[access.tier];
      log(200, access.id);
      return json(res, 200, {
        success: true,
        data: {
          access: { id: access.id, name: access.name, expiresAt: access.expiresAt, paused: access.paused, tier: access.tier },
          grants: [...access.grants].map(([storeId, g]) => ({ storeId, rights: g.rights, keys: g.keys })),
          manifests: [...access.manifests].map(([storeId, m]) => ({ storeId, sealed: m.sealed, rev: m.rev })),
          limits: { tier: access.tier, ...lim },
          usage: { ...access.usage },
        },
      }, headers);
    }

    const m = /^\/dbstore\/([A-Za-z0-9_-]{22})\/(head|changes|commit|stage|slots:batchGet|slots\/([^/]+)\/(\d+))$/.exec(path);
    if (!m) {
      log(404, access?.id);
      return fail(res, 404, 'not_found', {}, headers);
    }
    const store = this.stores.get(m[1]!);
    const grant = access ? access.grants.get(m[1]!) : { rights: 'rw' as const };
    if (!store || !grant) {
      log(403, access?.id);
      return fail(res, 403, 'store_not_granted', {}, headers);
    }
    const action = m[2]!;
    const countBytes = (n: number) => {
      if (access) access.usage.bytes += n;
    };

    if (action === 'head' && method === 'GET') {
      const head = store.headToken ? this.bodies.get(store.headToken)! : null;
      if (head) countBytes(head.length);
      log(200, access?.id);
      return json(res, 200, {
        success: true,
        data: { seq: store.seq, head: head ? toBase64Url(head) : null, ...(store.hk ? { hk: store.hk } : {}), g: store.g },
      }, headers);
    }
    if (action === 'changes' && method === 'GET') {
      if (access && access.tier === 'free') {
        const last = access.lastChanges.get(store.storeId) ?? 0;
        if (Date.now() - last < this.freePollMs) {
          log(429, access.id);
          return fail(res, 429, 'api_poll_interval', {}, { ...headers, 'Retry-After': String(Math.ceil((this.freePollMs - (Date.now() - last)) / 1000)) });
        }
        access.lastChanges.set(store.storeId, Date.now());
      }
      const since = Number(url.searchParams.get('since') ?? '0');
      const entries = store.log.filter((e) => e.seq > since);
      const slots = new Map<string, { p: string; ver: number; e: number; g: number }>();
      const removed = new Set<string>();
      for (const e of entries) {
        for (const s of e.slots) slots.set(s.p, s);
        for (const p of e.removed) removed.add(p);
      }
      log(200, access?.id);
      return json(res, 200, { success: true, data: { seq: store.seq, slots: [...slots.values()], removed: [...removed] } }, headers);
    }
    if (action === 'slots:batchGet' && method === 'POST') {
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
        countBytes(size);
        out.push(bytes ? { p: r.p, ver: r.ver, body: toBase64Url(bytes) } : { p: r.p, ver: r.ver, missing: true });
      }
      log(200, access?.id);
      return json(res, 200, { success: true, data: { slots: out, more } }, headers);
    }
    if (m[3] !== undefined && method === 'GET') {
      const p = m[3] === '-' ? '' : m[3];
      const bytes = this.bodyOf(store, p, Number(m[4]));
      if (!bytes) {
        log(404, access?.id);
        return fail(res, 404, 'slot_not_found', {}, headers);
      }
      countBytes(bytes.length);
      log(200, access?.id);
      res.writeHead(200, { 'content-type': 'application/octet-stream', ...headers });
      return void res.end(Buffer.from(bytes));
    }
    // Écritures : droit "rw", interrupteur API_BASE_WRITE, palier payant (§ 6, § 7)
    if ((action === 'stage' && method === 'PUT') || (action === 'commit' && method === 'POST')) {
      if (access) {
        if (grant.rights !== 'rw') {
          log(403, access.id);
          return fail(res, 403, 'store_read_only', {}, headers);
        }
        if (!this.writeSwitch) {
          log(403, access.id);
          return fail(res, 403, 'api_write_disabled', {}, headers);
        }
        if (TIER_LIMITS[access.tier].writesPerDay === null) {
          log(403, access.id);
          return fail(res, 403, 'api_tier_write', {}, headers);
        }
      }
      const raw = await readBody(req);
      if (action === 'stage') {
        const token = newToken();
        this.staged.set(token, new Uint8Array(raw));
        log(200, access?.id);
        return json(res, 200, { success: true, data: { token } }, headers);
      }
      const body = JSON.parse(raw.toString('utf8'));
      const outcome = this.applyCommit(store, body);
      if (!outcome.ok) {
        log(outcome.status, access?.id);
        return fail(res, outcome.status, outcome.code, outcome.extra ?? {}, headers);
      }
      if (access) access.usage.writes += 1;
      log(200, access?.id);
      return json(res, 200, { success: true, data: { seq: outcome.seq } }, headers);
    }
    log(404, access?.id);
    return fail(res, 404, 'not_found', {}, headers);
  }
}
