/**
 * L'APPLICATION FILARR, côté créateur, contre un VRAI worker (le worker local du banc
 * de filarg, `scripts/banc/worker-local.sh`) : ce que font le bureau et le web, réduit
 * à ce qu'il faut pour éprouver la boîte noire de bout en bout.
 *
 *  - connexion d'un compte fictif `@example.test` (mot de passe lu dans le fichier du
 *    banc, jamais écrit ici) ;
 *  - paire d'identité du compte (X25519 + Ed25519), `PUT /account/user-key` ;
 *  - bascule du compte au magasin (`GET /sync/capabilities` avec `db-store-1`) ;
 *  - une base au magasin, écrite par la RÉPLIQUE de l'application (copie de filarg) ;
 *  - un accès API (révision 3 : `creatorTag`, `notifyKey`, `bind_sig`), droits et
 *    manifestes scellés vers sa clé publique ; révocation.
 *
 * Aucune donnée réelle, aucune requête hors de la machine.
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { computeCreatorTag, deriveAccessKeys3 } from '../../packages/core/src/engine/gate/access3';
import { boxSigMessage } from '../../packages/core/src/engine/gate/files';
import { openJson, queueAad, resolveAad, sealJson, signDef, statusAad, statusKey, type ExtSourceDef, type QueueEntry, type SyncStatus } from '../../packages/core/src/engine/extsrc';
import {
  accessAuthHash,
  assignSlugs,
  bindMessage,
  deriveAccessKeys,
  formatAccessToken,
  grantPlaintext,
  sealToKey,
  toBase64Std,
} from '../../packages/core/src/engine/store/apiAccess';
import { fromBase64Url, personalStoreId, storeKeys, toBase64Url, utf8Encode } from '../../packages/core/src/engine/store/crypto';
import { HlcClock } from '../../packages/core/src/engine/store/hlc';
import type { StoreOp } from '../../packages/core/src/engine/store/registers';
import type { DbRow } from '../../packages/core/src/types';
import { curves, storeCrypto as c } from '../../packages/gate/src/crypto/providers';
import { slotRefKey, StoreReplica, StoreUnreachableError, type CommitRequest, type CommitResponse, type RemoteHead, type SlotRef, type StoreTransport } from '../helpers/appReplica';
import type { NewStore } from '../support/mockFilarr';

const CAPS = { 'X-Filarr-Sync-Caps': 'db-store-1' };

export class WorkerError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
    what: string
  ) {
    super(`${what} → ${status} ${JSON.stringify(body).slice(0, 300)}`);
  }
}

interface RealStore {
  storeId: string;
  dbId: string;
  title: string;
  views: NewStore['views'];
  replica: StoreReplica;
}

export class RealFilarr {
  private jwt = '';
  /** L'identifiant du compte (signataire des définitions de synchro). */
  userId = '';
  /** La paire d'identité du compte (de test, tirée au hasard pour ce banc). */
  readonly signingKey = new Uint8Array(randomBytes(32));
  readonly encKey = new Uint8Array(randomBytes(32));
  readonly fek = new Uint8Array(randomBytes(32));
  readonly stores = new Map<string, RealStore>();
  private readonly site = randomBytes(4).toString('hex');

  /** `sql` : une requête sur la D1 LOCALE du banc (`d1-locale.sh`), pour ce que l'appli fait par des écrans hors de portée ici. */
  constructor(
    readonly url: string,
    private readonly sql: ((query: string) => Array<Record<string, unknown>>) | null = null
  ) {}

  get signingPublicKey(): string {
    return toBase64Std(curves.ed25519PublicKey(this.signingKey));
  }

  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: { ...(this.jwt ? { Authorization: `Bearer ${this.jwt}` } : {}), ...(body !== undefined && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body) } : {}),
    });
    const parsed = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T } & Record<string, unknown>;
    if (!res.ok || parsed.success === false) throw new WorkerError(res.status, parsed, `${method} ${path}`);
    return (parsed.data ?? parsed) as T;
  }

  /** Connexion du compte fictif ; le mot de passe est la ligne 2 du fichier du banc (`worker/comptes/<adresse>.txt`). */
  async login(accountFile: string): Promise<void> {
    const [email, password] = readFileSync(accountFile, 'utf8').split(/\r?\n/);
    if (!email?.endsWith('@example.test')) throw new Error('compte fictif @example.test attendu');
    const data = await this.call<{ accessToken?: string; token?: string; tokens?: { accessToken?: string }; user?: { id?: string } }>('POST', '/auth/login', {
      email,
      password,
      deviceName: 'Banc Filarr Gate',
      deviceOs: 'node',
    });
    const jwt = data.accessToken ?? data.tokens?.accessToken ?? data.token;
    if (!jwt) throw new Error(`connexion sans jeton : ${JSON.stringify(data).slice(0, 200)}`);
    this.jwt = jwt;
    this.userId = data.user?.id ?? '';
  }

  /** La paire d'identité du compte : la boîte noire authentifie la clé de signature par l'étiquette du créateur. */
  async registerKeys(): Promise<void> {
    const encPublicKey = toBase64Std(curves.x25519PublicKey(this.encKey));
    const signPublicKey = this.signingPublicKey;
    const body = {
      encPublicKey,
      signPublicKey,
      wrappedPrivateKey: toBase64Std(new Uint8Array(randomBytes(48))),
      kekSalt: toBase64Std(new Uint8Array(randomBytes(16))),
      keyAlgo: 'x25519-ed25519',
      keyVersion: 1,
      fingerprint: toBase64Url(new Uint8Array(randomBytes(16))),
    };
    try {
      await this.call('PUT', '/account/user-key', { ...body, expectedPreviousDigest: 'initial' });
    } catch (err) {
      // Une paire existe déjà (banc relancé) : on la remplace, empreinte à l'appui
      if (!(err instanceof WorkerError) || err.body.code !== 'user_key_conflict') throw err;
      await this.call('PUT', '/account/user-key', { ...body, expectedPreviousDigest: String(err.body.serverDigest) });
    }
  }

  /** Le compte bascule au magasin (`db-store-1` § 8 bis) : deux lectures des capacités, avec le jeton de capacité. */
  async enableDbStore(): Promise<void> {
    for (let i = 0; i < 2; i += 1) await this.call('GET', '/sync/capabilities', undefined, CAPS);
  }

  private transport(storeId: string): StoreTransport {
    const base = `/dbstore/${storeId}`;
    const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof WorkerError) throw err;
        throw new StoreUnreachableError((err as Error).message);
      }
    };
    return {
      head: () =>
        wrap(async (): Promise<RemoteHead> => {
          const d = await this.call<{ seq?: number; head?: string; hk?: { e: number; g: number }; g?: number }>('GET', `${base}/head`, undefined, CAPS);
          return { seq: Number(d.seq ?? 0), head: d.head ? fromBase64Url(d.head) : null, ...(d.hk ? { hk: d.hk } : {}), ...(typeof d.g === 'number' ? { g: d.g } : {}) };
        }),
      slots: (refs: SlotRef[]) =>
        wrap(async () => {
          const out = new Map<string, Uint8Array | null>();
          if (refs.length === 0) return out;
          const d = await this.call<{ slots?: Array<{ p: string; ver: number; body?: string; missing?: boolean }> }>('POST', `${base}/slots:batchGet`, { slots: refs, maxBytes: 2 * 1024 * 1024 }, CAPS);
          for (const s of d.slots ?? []) out.set(slotRefKey(s.p, s.ver), s.missing || !s.body ? null : fromBase64Url(s.body));
          for (const r of refs) if (!out.has(slotRefKey(r.p, r.ver))) out.set(slotRefKey(r.p, r.ver), null);
          return out;
        }),
      stage: (body: Uint8Array) => wrap(async () => (await this.call<{ token: string }>('PUT', `${base}/stage`, body, { ...CAPS, 'Content-Type': 'application/octet-stream' })).token),
      commit: (req: CommitRequest) =>
        wrap(async (): Promise<CommitResponse> => {
          try {
            const d = await this.call<{ seq: number }>(
              'POST',
              `${base}/commit`,
              {
                baseSeq: req.baseSeq,
                slots: req.slots.map((s) => ({ p: s.p, ver: s.ver, e: s.e, g: s.g, ...(s.body ? { body: toBase64Url(s.body) } : { stage: s.stage }) })),
                removed: req.removed,
                head: toBase64Url(req.head),
                hk: { e: req.hk.e, g: req.hk.g },
              },
              CAPS
            );
            return { ok: true, seq: Number(d.seq) };
          } catch (err) {
            if (!(err instanceof WorkerError)) throw err;
            const code = String(err.body.code ?? `http_${err.status}`);
            if (code === 'seq_conflict') return { ok: false, code, seq: Number(err.body.seq ?? 0) };
            if (code === 'stale_generation') return { ok: false, code, g: Number(err.body.g ?? 0) };
            return { ok: false, code, detail: String(err.body.error ?? '') };
          }
        }),
      bumpGeneration: async (from: number) => {
        const d = await this.call<{ g: number }>('POST', `${base}/generation`, { from }, CAPS);
        return { ok: true, g: d.g };
      },
    };
  }

  /** Une base passe au magasin, écrite par la réplique de l'application. */
  async createStore(spec: NewStore): Promise<string> {
    const storeId = await personalStoreId(c, this.fek, spec.dbId);
    await this.call('POST', '/dbstore', { storeId }, CAPS);
    const keys = await storeKeys(c, this.fek, storeId, 0, 0);
    const replica = new StoreReplica(c, { current: keys, all: [keys], derive: (e, g) => storeKeys(c, this.fek, storeId, e, g) }, this.transport(storeId), new HlcClock(this.site), { dbId: spec.dbId });
    await replica.load();
    await replica.migrate(spec.rows, { properties: spec.properties, collation: 'fr' });
    this.stores.set(storeId, { storeId, dbId: spec.dbId, title: spec.title, views: spec.views ?? [{ id: 'v-main', name: 'Tableau', type: 'table', filters: [], sorts: [] }], replica });
    return storeId;
  }

  async appEdit(storeId: string, edits: Array<{ r: string; f: string; v?: unknown }>): Promise<void> {
    const replica = this.stores.get(storeId)!.replica;
    await replica.refresh();
    const ops: StoreOp[] = edits.map((e) => ({ ...e, t: replica.tick() }));
    replica.apply(ops);
    await replica.flush();
  }

  async appRows(storeId: string): Promise<DbRow[]> {
    const replica = this.stores.get(storeId)!.replica;
    await replica.refresh();
    return replica.rows();
  }

  /** L'appli écrit une définition de synchro, signée par la clé du compte, dans le schéma du magasin (avec `managedBy`). */
  async appSetExtSource(storeId: string, def: Omit<ExtSourceDef, 'signer' | 'sig'>): Promise<ExtSourceDef> {
    const replica = this.stores.get(storeId)!.replica;
    await replica.refresh();
    const schema = replica.schema()!;
    const signed = signDef(curves, { ...def, signer: this.userId } as ExtSourceDef, this.signingKey);
    const properties = schema.properties.map((p) => {
      const m = signed.map.find((x) => x.prop === p.id);
      return m ? ({ ...p, managedBy: { src: signed.id, dir: m.dir, col: m.col } } as typeof p) : p;
    });
    const { t: _t, ...rest } = schema;
    void _t;
    replica.setSchema({ ...rest, properties, extra: { ...(schema.extra ?? {}), extSource: signed } });
    await replica.flush();
    return signed;
  }

  /** Ce qu'un membre lit de l'état publié d'une synchro (`GET /dbstore/:id/ext-status`), ouvert sous `K_xs`. */
  async appReadStatus(storeId: string, runnerId: string): Promise<SyncStatus | null> {
    const d = await this.call<{ statuses?: Array<{ runnerId: string; rev: number; e: number; g: number; sealed: string }> }>('GET', `/dbstore/${storeId}/ext-status`, undefined, CAPS);
    const st = (d.statuses ?? []).find((x) => x.runnerId === runnerId);
    if (!st) return null;
    const k = await storeKeys(c, this.fek, storeId, st.e, st.g);
    return openJson<SyncStatus>(c, await statusKey(c, k.kDb, storeId), st.sealed, statusAad(storeId, runnerId, st.rev));
  }

  /** La file « me demander » publiée par l'exécutant (§ 6.12), ouverte comme l'appli l'ouvre, sous `K_xs`. */
  async appReadQueue(storeId: string, runnerId: string): Promise<QueueEntry[]> {
    const q = await this.call<{ rev: number; e: number | null; g: number | null; sealed: string | null }>('GET', `/dbstore/${storeId}/ext-queue/${encodeURIComponent(runnerId)}`, undefined, CAPS);
    if (!q.sealed || q.e === null || q.g === null) return [];
    const k = await storeKeys(c, this.fek, storeId, q.e, q.g);
    return (await openJson<{ entries: QueueEntry[] }>(c, await statusKey(c, k.kDb, storeId), q.sealed, queueAad(storeId, runnerId, q.rev))).entries;
  }

  /**
   * Trancher dans l'appli (`POST /dbstore/:id/ext-resolve`) : décisions scellées sous `K_xs` de la
   * génération courante ; le worker les range dans la boîte aux lettres de l'exécutant et lui relaie
   * un `ext-run`. Rend le numéro de dépôt.
   */
  async appDecide(storeId: string, runnerId: string, defId: string, decisions: Array<{ id: string; choice: 'filarr' | 'source' | 'delete' | 'keep' }>): Promise<number> {
    const head = await this.transport(storeId).head();
    const k = await storeKeys(c, this.fek, storeId, 0, head.g ?? 0);
    const kxs = await statusKey(c, k.kDb, storeId);
    const items = [];
    for (const d of decisions) {
      items.push({ sealed: await sealJson(c, kxs, { id: d.id, choice: d.choice, by: { userId: this.userId, device: 'Banc Filarr Gate' }, at: new Date().toISOString() }, resolveAad(storeId, runnerId)) });
    }
    return (await this.call<{ seq: number }>('POST', `/dbstore/${storeId}/ext-resolve`, { defId, runnerId, items }, CAPS)).seq;
  }

  /**
   * Une boîte de dépôt PERMANENTE du compte (celle de « Recevoir des fichiers ») : posée par la D1
   * locale du banc, sa clé privée gardée ici (l'appli la tient dans son trousseau).
   */
  createDepositBox(): { requestId: string; publicKey: string; privateKey: Uint8Array } {
    if (!this.sql) throw new Error('D1 locale du banc requise (FILARR_E2E_D1)');
    const privateKey = new Uint8Array(randomBytes(32));
    const publicKey = toBase64Url(curves.x25519PublicKey(privateKey));
    const requestId = toBase64Url(new Uint8Array(randomBytes(16)));
    const now = Date.now();
    this.sql(
      `INSERT INTO file_requests (id, public_key, creator_ip_hash, manage_token_hash, expires_at, max_deposits, max_bytes_total, status, created_at, account_id, permanent) VALUES ('${requestId}', '${publicKey}', 'banc', 'banc', ${now + 365 * 86_400_000}, 1000, 10000000000, 'open', ${now}, '${this.userId}', 1)`
    );
    return { requestId, publicKey, privateKey };
  }

  /** Un dépôt tel que le worker le garde (`file_request_deposits`). */
  deposit(depositId: string): Record<string, unknown> | null {
    if (!this.sql) throw new Error('D1 locale du banc requise (FILARR_E2E_D1)');
    return this.sql(`SELECT id, status, channel, access_id, sealed_file_key, encrypted_manifest, encrypted_manifest_iv, total_chunks, size_bytes FROM file_request_deposits WHERE id = '${depositId.replace(/'/g, '')}'`)[0] ?? null;
  }

  /** Un accès API à une base (révision 3), comme « Ouvrir à une API » : le jeton n'existe qu'ici. */
  async createAccess(name: string, storeId: string, rights: 'r' | 'rw', opts: { files?: { requestId: string; publicKey: string } } = {}): Promise<{ token: string; accessId: string }> {
    const idBytes = new Uint8Array(randomBytes(16));
    const secret = new Uint8Array(randomBytes(32));
    const id = toBase64Url(idBytes);
    const keys = await deriveAccessKeys(c, curves, idBytes, secret);
    const keys3 = await deriveAccessKeys3(c, idBytes, secret);
    const store = this.stores.get(storeId)!;
    const head = await this.transport(storeId).head();
    const g = head.g ?? 0;
    const k = await storeKeys(c, this.fek, storeId, 0, g);
    const viewSlugs = assignSlugs(store.views!.map((v) => v.name), 'vue');
    const manifest = JSON.stringify({
      v: 1,
      a: id,
      s: storeId,
      slug: assignSlugs([store.title], 'base')[0],
      title: store.title,
      rights,
      views: store.views!.map((v, i) => ({ ...v, slug: viewSlugs[i] })),
      updated: new Date().toISOString(),
    });
    const encPub = toBase64Std(curves.x25519PublicKey(this.encKey));
    const body = {
      id,
      name,
      encPublicKey: keys.aPub,
      authHash: await accessAuthHash(c, keys.aAuth),
      bindSig: toBase64Std(curves.ed25519Sign(this.signingKey, bindMessage(id, keys.aPub))),
      expiresAt: null,
      ipAllowlist: null,
      grants: [{ storeId, rights, keys: [{ e: 0, g, sealed: await sealToKey(c, curves, keys.aPub, utf8Encode(grantPlaintext({ a: id, s: storeId, e: 0, g }, k.kDb))) }] }],
      manifests: [{ storeId, sealed: await sealToKey(c, curves, keys.aPub, utf8Encode(manifest)), creator: await sealToKey(c, curves, encPub, utf8Encode(JSON.stringify({ v: 1, slugs: {} }))) }],
      creatorTag: await computeCreatorTag(c, keys3.aMac, id, this.signingPublicKey),
      notifyKey: toBase64Std(keys3.aNotify),
      ...(opts.files ? { files: { requestId: opts.files.requestId, boxSig: toBase64Url(curves.ed25519Sign(this.signingKey, boxSigMessage(id, opts.files.requestId, opts.files.publicKey))) } } : {}),
    };
    await this.call('POST', '/api-access', body);
    return { token: formatAccessToken(idBytes, secret), accessId: id };
  }

  /** Révoque : le serveur refuse à l'instant ; le créateur monte la génération des magasins rendus. */
  async revoke(accessId: string): Promise<void> {
    const d = await this.call<{ bump?: Array<{ storeId: string; from?: number; g?: number }> }>('POST', `/api-access/${accessId}/revoke`, {});
    for (const b of d.bump ?? []) {
      const s = this.stores.get(b.storeId);
      if (!s) continue;
      const head = await this.transport(b.storeId).head();
      await this.transport(b.storeId).bumpGeneration!(head.g ?? 0).catch(() => undefined);
    }
  }
}
