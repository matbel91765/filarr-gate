/**
 * La réplique contre un Filarr en mémoire : jeton, droits scellés à leur place,
 * lecture vérifiée, flux, relève, 429, révocation, clé manquante, écriture.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoreOp } from '../src/core/engine/store/registers';
import { Journal } from '../src/journal';
import { keyId } from '../src/replica/access';
import { DiskBlockCache, MemoryBlockCache } from '../src/replica/blockCache';
import { FilarrClient } from '../src/replica/http';
import { Replicator } from '../src/replica/replicator';
import { StoreMirror } from '../src/replica/store';
import { InvalidTokenError, openToken } from '../src/replica/token';
import { CATALOGUE_DB, CLIENTS_DB, COMMANDES_DB, demoStores } from './support/demoData';
import { MockFilarr } from './support/mockFilarr';
import { tempDir, until } from './support/util';

const vectors = JSON.parse(readFileSync(join(__dirname, 'vectors', 'api-base-1.vectors.json'), 'utf8')) as {
  token: { token: string; accessId: string; authorization: string; aPub: string };
  tokensRefused: string[];
};

describe('le jeton', () => {
  it('rend la preuve et la clé publique des vecteurs, et efface le secret', async () => {
    const id = await openToken(vectors.token.token);
    expect(id.accessId).toBe(vectors.token.accessId);
    expect(id.authorization).toBe(vectors.token.authorization);
    expect(id.aPub).toBe(vectors.token.aPub);
    expect(id.hint).toBe(`flr_live_EBES…${vectors.token.token.slice(-4)}`);
    expect(id.hint).not.toContain(vectors.token.token.slice(32, 60));
  });

  it.each(vectors.tokensRefused)('refuse %j', async (t) => {
    await expect(openToken(t)).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe('la réplique', () => {
  let mock: MockFilarr;
  let replicator: Replicator;
  let journal: Journal;
  const stores: Record<string, string> = {};

  beforeEach(async () => {
    mock = new MockFilarr();
    await mock.listen();
    for (const spec of demoStores) stores[spec.dbId] = await mock.createStore(spec);
    journal = new Journal(null);
  });

  afterEach(async () => {
    await replicator?.stop();
    await mock.close();
  });

  const make = (opts: Partial<ConstructorParameters<typeof Replicator>[0]> = {}) => {
    replicator = new Replicator({
      apiUrl: mock.url,
      version: 'test',
      cache: new MemoryBlockCache(),
      site: '0000beef',
      journal,
      backoffMinMs: 20,
      backoffMaxMs: 200,
      pollIntervalMs: 100,
      pausedRetryMs: 100,
      ...opts,
    });
    return replicator;
  };

  it('lit les bases ouvertes, à l’identique de ce que l’application a écrit', async () => {
    const { token, accessId } = await mock.createAccess('ERP Atelier');
    await mock.grant(accessId, stores[CLIENTS_DB]!, 'rw');
    await mock.grant(accessId, stores[COMMANDES_DB]!, 'r');
    const r = make();
    await r.start(token);
    expect(r.access?.name).toBe('ERP Atelier');
    expect([...r.bases.keys()].sort()).toEqual([stores[CLIENTS_DB], stores[COMMANDES_DB]].sort());
    const clients = r.bySlug('clients')!;
    expect(clients.manifest?.title).toBe('Clients');
    expect(clients.manifest?.viewSlugs.get('v_actifs')).toBe('clients-actifs');
    expect(clients.mirror.status).toBe('ready');
    expect(clients.mirror.rows).toEqual(await mock.appRows(stores[CLIENTS_DB]!));
    expect(clients.mirror.head?.dbId).toBe(CLIENTS_DB);
    // Ce que le serveur a vu : la preuve, jamais le jeton
    expect(mock.requests.every((q) => q.access === accessId || q.access === undefined)).toBe(true);
    expect(r.client!.headers().Authorization).not.toContain(token.slice(32));
    expect(r.client!.headers()['X-Filarr-Sync-Caps']).toBe('db-store-1, api-base-1');
  });

  it('suit le flux : un geste dans Filarr arrive dans la copie, et émet le changement', async () => {
    const { token, accessId } = await mock.createAccess('ERP');
    await mock.grant(accessId, stores[CLIENTS_DB]!, 'r');
    const r = make();
    const diffs: Array<{ created: number; updated: number }> = [];
    r.on('change', (_b, d) => diffs.push({ created: d.created.length, updated: d.updated.length }));
    await r.start(token);
    await until(() => r.link === 'live', 3000, 'flux ouvert');
    await mock.appEdit(stores[CLIENTS_DB]!, [{ r: 'r_acme', f: 'p_ville', v: 'Villeurbanne' }]);
    await until(() => r.bySlug('clients')!.mirror.rowById('r_acme')?.cells.p_ville === 'Villeurbanne', 3000, 'changement reçu');
    expect(diffs.some((d) => d.updated === 1)).toBe(true);
    await mock.appEdit(stores[CLIENTS_DB]!, [{ r: 'r_new', f: 'p_nom', v: 'Hooli' }, { r: 'r_new', f: '#o', v: 'z' }]);
    await until(() => r.bySlug('clients')!.mirror.rows.some((x) => x.id === 'r_new'), 3000, 'ligne ajoutée');
    expect(diffs.some((d) => d.created === 1)).toBe(true);
  });

  it('refuse un droit scellé hors de sa place, et ne saute jamais un bloc', async () => {
    const { token, accessId } = await mock.createAccess('ERP');
    await mock.grant(accessId, stores[CLIENTS_DB]!, 'r');
    await mock.publishManifest(accessId, stores[COMMANDES_DB]!);
    // Le droit de Commandes porte en réalité la clé de Clients : refusé
    await mock.plantForeignGrant(accessId, stores[COMMANDES_DB]!, stores[CLIENTS_DB]!);
    const r = make();
    await r.start(token);
    expect(r.refused).toEqual([expect.objectContaining({ storeId: stores[COMMANDES_DB], what: 'grant', reason: 'droit scellé hors de sa place' })]);
    const commandes = r.bases.get(stores[COMMANDES_DB]!)!;
    expect(commandes.mirror.keys.size).toBe(0);
    expect(commandes.mirror.status).toBe('missing_key');
    expect(commandes.mirror.rows).toEqual([]);
    expect(r.bySlug('clients')!.mirror.status).toBe('ready');
  });

  it('montée de génération sans rescellement : « clé manquante pour (0, 1) », l’ancienne copie reste servie', async () => {
    const { token, accessId } = await mock.createAccess('ERP');
    await mock.grant(accessId, stores[CLIENTS_DB]!, 'r');
    const r = make();
    await r.start(token);
    const clients = r.bySlug('clients')!;
    const before = clients.mirror.rows;
    await mock.bumpGeneration(stores[CLIENTS_DB]!, { reseal: false });
    // L'application écrit sous la génération 1 (un membre dérive la clé depuis la racine)
    const app = await appWriter(mock, stores[CLIENTS_DB]!);
    await app.commit([{ r: 'r_acme', f: 'p_ca', v: 13000, t: app.tick() }]);
    await until(() => clients.mirror.status === 'missing_key', 3000, 'clé manquante');
    expect(clients.mirror.problem?.message).toBe('clé manquante pour (0, 1)');
    expect(clients.mirror.rows).toBe(before);
    // Le créateur rescelle : la base se rouvre sans geste
    await mock.grant(accessId, stores[CLIENTS_DB]!, 'r');
    await until(() => clients.mirror.status === 'ready' && clients.mirror.rowById('r_acme')?.cells.p_ca === 13000, 3000, 'rescellement');
    expect(clients.mirror.keys.has(keyId(0, 1))).toBe(true);
  });

  it('palier Free : sans flux (access.stream), relève par changes jamais plus vite que l’écart du palier', async () => {
    mock.freePollMs = 150;
    const { token, accessId } = await mock.createAccess('Free', 'free');
    await mock.grant(accessId, stores[CLIENTS_DB]!, 'r');
    const r = make({ pollIntervalMs: 20 });
    await r.start(token);
    await until(() => r.link === 'polling', 3000, 'relève');
    expect(r.streamRefused).toBe(true);
    expect(r.pollIntervalMs).toBe(150);
    // Le flux n'a même pas été tenté
    expect(mock.requests.some((q) => q.path === '/api-access/self/stream')).toBe(false);
    await mock.appEdit(stores[CLIENTS_DB]!, [{ r: 'r_globex', f: 'p_ville', v: 'Rennes' }]);
    await until(() => r.bySlug('clients')!.mirror.rowById('r_globex')?.cells.p_ville === 'Rennes', 5000, 'relève du changement');
    // L'écart du palier est tenu : aucun 429 api_poll_interval
    expect(mock.requests.filter((q) => q.status === 429)).toEqual([]);
  });

  it('un 429 api_poll_interval ne retient que SON magasin, jusqu’au Retry-After', async () => {
    const { token, accessId } = await mock.createAccess('ERP', 'free');
    mock.freePollMs = 50;
    await mock.grant(accessId, stores[CLIENTS_DB]!, 'r');
    const r = make({ pollIntervalMs: 20 });
    await r.start(token);
    await until(() => r.link === 'polling', 3000, 'relève');
    mock.failNext((m, p) => m === 'GET' && p.endsWith('/changes'), 429, 'api_poll_interval', { retryAfter: 1 });
    await until(() => (r.bySlug('clients')?.waitUntil ?? 0) > Date.now(), 3000, 'magasin en attente');
    expect(r.link).toBe('polling');
    expect(r.notBefore).toBe(0);
    await mock.appEdit(stores[CLIENTS_DB]!, [{ r: 'r_globex', f: 'p_ville', v: 'Brest' }]);
    await until(() => r.bySlug('clients')!.mirror.rowById('r_globex')?.cells.p_ville === 'Brest', 5000, 'reprise après Retry-After');
    expect(journal.list({ kind: 'filarr' }).some((e) => e.code === '429' && e.what.includes('api_poll_interval'))).toBe(true);
  });

  it('jeton remplacé dans Filarr : revoked puis fermeture 4301, tout est effacé', async () => {
    const { token, accessId } = await mock.createAccess('ERP');
    await mock.grant(accessId, stores[CLIENTS_DB]!, 'r');
    const r = make();
    await r.start(token);
    await until(() => r.link === 'live', 3000, 'flux');
    await mock.rotateToken(accessId);
    await until(() => r.link === 'revoked', 3000, 'révocation');
    expect(r.bases.size).toBe(0);
    // L'ancien jeton est refusé à l'instant
    const old = new FilarrClient({ baseUrl: mock.url, authorization: (await openToken(token)).authorization, version: 't' });
    await expect(old.json('GET', 'api-access/self')).rejects.toMatchObject({ code: 'api_access_unknown' });
  });

  it('pause (fermeture 4302) : la copie reste servie, la liaison le dit, la reprise rattrape', async () => {
    const { token, accessId } = await mock.createAccess('ERP');
    await mock.grant(accessId, stores[CLIENTS_DB]!, 'r');
    const r = make();
    await r.start(token);
    await until(() => r.link === 'live', 3000, 'flux');
    mock.pause(accessId);
    await until(() => r.link === 'paused', 3000, 'pause');
    expect(r.bySlug('clients')!.mirror.rows.length).toBe(4);
    mock.pause(accessId, false);
    await mock.appEdit(stores[CLIENTS_DB]!, [{ r: 'r_acme', f: 'p_ville', v: 'Bron' }]);
    await until(() => r.bySlug('clients')!.mirror.rowById('r_acme')?.cells.p_ville === 'Bron', 5000, 'reprise');
  });

  it('interrupteur API_BASE_SWITCH éteint : 403 api_base_not_switched, sans rien effacer', async () => {
    const { token, accessId } = await mock.createAccess('ERP');
    await mock.grant(accessId, stores[CLIENTS_DB]!, 'r');
    mock.baseSwitch = false;
    const r = make();
    await r.start(token);
    expect(r.link).toBe('not_switched');
    mock.baseSwitch = true;
    await until(() => r.bySlug('clients')?.mirror.status === 'ready', 5000, 'ouverture');
  });

  it('flux : ping applicatif accepté, tout autre envoi ferme en 4307 ; 8 flux au plus par accès', async () => {
    const { token } = await mock.createAccess('ERP');
    const id = await openToken(token);
    const client = new FilarrClient({ baseUrl: mock.url, authorization: id.authorization, version: 't' });
    const url = mock.url.replace('http', 'ws') + '/api-access/self/stream';
    const { default: WebSocket } = await import('ws');
    const open = () =>
      new Promise<InstanceType<typeof WebSocket>>((resolve, reject) => {
        const ws = new WebSocket(url, { headers: client.headers() });
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
      });
    const ws = await open();
    const pong = new Promise<string>((resolve) => ws.once('message', (d) => resolve(d.toString())));
    ws.send(JSON.stringify({ t: 'ping' }));
    expect(JSON.parse(await pong)).toEqual({ t: 'pong' });
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    ws.send('bonjour');
    expect(await closed).toBe(4307);
    const many = await Promise.all(Array.from({ length: 8 }, open));
    const ninth = await open();
    expect(await new Promise<number>((resolve) => ninth.once('close', (code) => resolve(code)))).toBe(4306);
    for (const s of many) s.terminate();
  });

  it('un 429 api_rate suspend tout échange jusqu’au Retry-After', async () => {
    const { token, accessId } = await mock.createAccess('ERP');
    await mock.grant(accessId, stores[CLIENTS_DB]!, 'r');
    mock.failNext((m, p) => m === 'GET' && p === '/api-access/self', 429, 'api_rate', { retryAfter: 1 });
    const r = make();
    const t0 = Date.now();
    await r.start(token);
    expect(r.link).toBe('limited');
    expect(r.limitedCode).toBe('api_rate');
    expect(r.notBefore).toBeGreaterThan(t0 + 900);
    await until(() => r.bySlug('clients')?.mirror.status === 'ready', 4000, 'reprise après Retry-After');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it('révocation : tout s’arrête, rien de déchiffré ne reste, le cache du disque est effacé', async () => {
    const dir = tempDir();
    const { token, accessId } = await mock.createAccess('ERP');
    await mock.grant(accessId, stores[CLIENTS_DB]!, 'r');
    const r = make({ cache: new DiskBlockCache(join(dir, 'blocks')) });
    await r.start(token);
    await until(() => r.link === 'live', 3000, 'flux');
    await until(() => existsSync(join(dir, 'blocks', stores[CLIENTS_DB]!, 'index.json')), 3000, 'cache écrit');
    // Le cache ne garde que des corps chiffrés
    const files = readdirSync(join(dir, 'blocks', stores[CLIENTS_DB]!));
    for (const f of files.filter((x) => x !== 'index.json')) {
      expect(readFileSync(join(dir, 'blocks', stores[CLIENTS_DB]!, f)).toString('latin1')).not.toContain('Acme');
    }
    const mirror = r.bySlug('clients')!.mirror;
    const kDb = [...mirror.keys.values()][0]!.kDb;
    await mock.revoke(accessId);
    await until(() => r.link === 'revoked', 3000, 'révocation');
    expect(r.bases.size).toBe(0);
    expect(mirror.rows).toEqual([]);
    expect(kDb.every((b) => b === 0)).toBe(true);
    expect(existsSync(join(dir, 'blocks'))).toBe(false);
  });

  it('relation vers une base non ouverte : la base visée n’est pas résolue', async () => {
    const { token, accessId } = await mock.createAccess('ERP');
    await mock.grant(accessId, stores[CATALOGUE_DB]!, 'r');
    const r = make();
    await r.start(token);
    expect(r.byDbId('db-fournisseurs-ferme')).toBeUndefined();
    expect(r.bySlug('catalogue')!.mirror.rowById('r_k2')?.cells.k_fourn).toEqual(['f_bois', 'f_metal']);
  });
});

/** L'application écrit avec la racine, à la génération courante (un membre, § 2). */
async function appWriter(mock: MockFilarr, storeId: string): Promise<StoreMirror> {
  const store = mock.mustStore(storeId);
  const keys = new Map();
  for (let g = 0; g <= store.g; g += 1) keys.set(keyId(0, g), await mock.rootKeys(storeId, 0, g));
  const client = new FilarrClient({ baseUrl: mock.url, authorization: 'Bearer mock-app', version: 'app' });
  const mirror = new StoreMirror(storeId, 'rw', keys, { client, cache: new MemoryBlockCache(), site: 'a99a0001' });
  await mirror.sync(true);
  return mirror;
}

describe('l’écriture (§ 7)', () => {
  let mock: MockFilarr;
  let storeId: string;
  let gate: StoreMirror;

  beforeEach(async () => {
    mock = new MockFilarr({ writeSwitch: true });
    await mock.listen();
    storeId = await mock.createStore(demoStores[0]!);
    const { token, accessId } = await mock.createAccess('ERP');
    await mock.grant(accessId, storeId, 'rw');
    const r = new Replicator({ apiUrl: mock.url, version: 'test', cache: new MemoryBlockCache(), site: '0000beef', journal: new Journal(null) });
    await r.start(token);
    await r.stop();
    gate = r.bases.get(storeId)!.mirror;
  });

  afterEach(async () => {
    await mock.close();
  });

  const op = (r: string, f: string, v: unknown): StoreOp => ({ r, f, v, t: gate.tick() });

  it('valide une ligne neuve que l’application relit à l’identique', async () => {
    const { seq, diff } = await gate.commit([op('r_q71m', 'p_nom', 'Initech Lille'), op('r_q71m', '#o', gate.nextOrder()), op('r_q71m', '#c', new Date().toISOString())]);
    expect(seq).toBe(gate.seq);
    expect(diff.created.map((x) => x.id)).toEqual(['r_q71m']);
    const appRows = await mock.appRows(storeId);
    expect(appRows.find((x) => x.id === 'r_q71m')?.cells.p_nom).toBe('Initech Lille');
    expect(appRows).toEqual(gate.rows);
  });

  it('compare-and-swap : un geste concurrent de l’application, puis relecture et nouvel essai', async () => {
    await mock.appEdit(storeId, [{ r: 'r_globex', f: 'p_ville', v: 'Rennes' }]);
    const { diff } = await gate.commit([op('r_acme', 'p_ca', 15000)]);
    expect(diff.updated.map((u) => u.after.id)).toContain('r_acme');
    const appRows = await mock.appRows(storeId);
    expect(appRows.find((x) => x.id === 'r_acme')?.cells.p_ca).toBe(15000);
    expect(appRows.find((x) => x.id === 'r_globex')?.cells.p_ville).toBe('Rennes');
    expect(mock.requests.some((q) => q.status === 409 && q.path.endsWith('/commit'))).toBe(true);
  });

  it('409 stale_generation : relit la tête, rescelle sous la génération courante, rejoue', async () => {
    await mock.bumpGeneration(storeId); // rescellée pour l'accès
    // La boîte noire ne sait pas encore : elle a les clés (0, 0) seulement
    expect(gate.generation).toBe(0);
    const access = [...mock.accesses.values()][0]!;
    expect(access.grants.get(storeId)!.keys.map((k) => keyId(k.e, k.g)).sort()).toEqual(['0|0', '0|1']);
    // Elle relira ses droits par `self` ; ici on lui pose la clé rescellée comme le ferait `refreshSelf`
    gate.keys.set(keyId(0, 1), await mock.rootKeys(storeId, 0, 1));
    const { seq } = await gate.commit([op('r_umbrella', 'p_statut', 'o_client')]);
    expect(seq).toBeGreaterThan(0);
    expect(gate.generation).toBe(1);
    expect(mock.requests.some((q) => q.status === 409 && q.path.endsWith('/commit'))).toBe(true);
    const app = await appWriter(mock, storeId);
    expect(app.rowById('r_umbrella')?.cells.p_statut).toBe('o_client');
    // Le bloc réécrit est sous g = 1, la tête aussi
    expect(mock.mustStore(storeId).hk).toEqual({ e: 0, g: 1 });
  });

  it('sans la clé de la génération courante, l’écriture est refusée, jamais scellée sous une ancienne', async () => {
    await mock.bumpGeneration(storeId, { reseal: false });
    await expect(gate.commit([op('r_acme', 'p_ca', 1)])).rejects.toThrow(/clé manquante pour \(0, 1\)/);
    expect((await mock.appRows(storeId)).find((x) => x.id === 'r_acme')?.cells.p_ca).toBe(12500);
  });

  it('les corps envoyés restent chiffrés : aucune valeur en clair ne part vers Filarr', async () => {
    await gate.commit([op('r_secret', 'p_nom', 'Nom très secret'), op('r_secret', '#o', 'zz')]);
    for (const body of mock.bodies.values()) expect(Buffer.from(body).toString('latin1')).not.toContain('secret');
  });
});
