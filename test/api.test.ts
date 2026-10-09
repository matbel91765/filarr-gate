/**
 * L'API locale de bout en bout : un Filarr en mémoire, une boîte noire qui le
 * réplique, et des requêtes HTTP réelles (clés, vues, SQL, OpenAPI, webhooks
 * signés, écriture, MCP, administration).
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifySignature } from '../packages/server/src/api/webhooks';
import { Gate } from '../packages/cli/src/gate';
import { setLogLevel } from '../packages/cli/src/log';
import { CATALOGUE_DB, CLIENTS_DB, COMMANDES_DB, demoStores } from './support/demoData';
import { MockFilarr } from './support/mockFilarr';
import { tempDir, until } from './support/util';

setLogLevel('silent');

let mock: MockFilarr;
let gate: Gate;
let api: string;
let admin: string;
const stores: Record<string, string> = {};
let accessIdOfGate = '';
const ADMIN_PASSWORD = 'mot-de-passe-de-test';

/** Un récepteur de webhooks : rend les statuts demandés, dans l'ordre, puis 200. */
let hookServer: Server;
let hookUrl: string;
const received: Array<{ headers: IncomingMessage['headers']; body: string; status: number }> = [];
const plannedStatuses: number[] = [];

beforeAll(async () => {
  mock = new MockFilarr({ writeSwitch: true });
  await mock.listen();
  for (const spec of demoStores) stores[spec.dbId] = await mock.createStore(spec);
  const { token, accessId } = await mock.createAccess('ERP Atelier');
  accessIdOfGate = accessId;
  await mock.grant(accessId, stores[CLIENTS_DB]!, 'rw');
  await mock.grant(accessId, stores[COMMANDES_DB]!, 'r');
  await mock.grant(accessId, stores[CATALOGUE_DB]!, 'r');

  hookServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const status = plannedStatuses.shift() ?? 200;
      received.push({ headers: req.headers, body, status });
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/hook`;

  gate = new Gate({
    env: {
      FILARR_GATE_STATE_DIR: tempDir(),
      FILARR_GATE_API_URL: mock.url,
      FILARR_GATE_TOKEN: token,
      FILARR_GATE_PORT: '0',
      FILARR_GATE_ADMIN_PORT: '0',
      FILARR_GATE_WRITE: 'true',
      FILARR_GATE_MCP: 'true',
      FILARR_GATE_CACHE: 'memory',
      FILARR_GATE_ADMIN_PASSWORD: ADMIN_PASSWORD,
    },
    webhooks: { delaysMs: [0, 50, 50, 50, 50, 50, 50, 50] },
    replicaTiming: { backoffMinMs: 20, backoffMaxMs: 200 },
  });
  await gate.start();
  api = `http://127.0.0.1:${gate.apiPort}`;
  admin = `http://127.0.0.1:${gate.adminPort}`;
  await until(() => gate.replicator.link === 'live', 5000, 'flux ouvert');
});

afterAll(async () => {
  await gate?.stop();
  await mock?.close();
  await new Promise<void>((r) => hookServer.close(() => r()));
});

const get = async (path: string, key?: string) => {
  const res = await fetch(api + path, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as Record<string, any> };
};

const send = async (method: string, path: string, key: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(api + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as Record<string, any> };
};

const keyFor = (scopes: Parameters<Gate['keys']['create']>[0]['scopes'], extra: Partial<Parameters<Gate['keys']['create']>[0]> = {}) =>
  gate.keys.create({ name: 'Essai', scopes, ...extra }).key;

describe('authentification par clé d’application', () => {
  it('refuse sans clé, avec une clé inconnue, et hors de ses points d’accès', async () => {
    expect((await get('/v1/clients')).body.code).toBe('key_missing');
    expect((await get('/v1/clients', 'gk_xxx_inconnue')).status).toBe(401);
    const key = keyFor([{ target: 'base', storeId: stores[COMMANDES_DB]!, read: true, create: false, update: false, delete: false }]);
    expect((await get('/v1/clients', key)).status).toBe(403);
    expect((await get('/v1/commandes', key)).status).toBe(200);
    // Une vue seule ne donne pas la base entière
    const viewOnly = keyFor([{ target: 'view', storeId: stores[CLIENTS_DB]!, viewId: 'v_actifs', read: true }]);
    expect((await get('/v1/clients/clients-actifs', viewOnly)).status).toBe(200);
    expect((await get('/v1/clients', viewOnly)).status).toBe(403);
  });

  it('applique le débit de la clé et ses adresses autorisées', async () => {
    const slow = keyFor([{ target: 'all', read: true }], { rateLimit: 2 });
    expect((await get('/v1/clients', slow)).status).toBe(200);
    expect((await get('/v1/clients', slow)).status).toBe(200);
    const third = await get('/v1/clients', slow);
    expect(third.status).toBe(429);
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
    const fenced = keyFor([{ target: 'all', read: true }], { ipAllow: ['10.0.4.0/24'] });
    expect((await get('/v1/clients', fenced)).body.code).toBe('ip_forbidden');
  });
});

describe('lecture', () => {
  let key: string;
  beforeAll(() => {
    key = keyFor([{ target: 'all', read: true }], { sql: true });
  });

  it('rend les lignes avec les noms de champs, libellés, relations et agrégats', async () => {
    const { status, body, headers } = await get('/v1/clients?sort=nom', key);
    expect(status).toBe(200);
    expect(headers.get('x-filarr-version')).toBe(String(body.version));
    expect(body.total).toBe(4);
    const acme = body.rows.find((r: any) => r.id === 'r_acme');
    expect(acme).toMatchObject({ nom: 'Acme', ville: 'Lyon', statut: 'Client', ca: 12500, dernier_contact: '2026-10-03' });
    expect(acme.commandes.sort()).toEqual(['r_c1', 'r_c3']);
    expect(acme.total_commande).toBe(1540.5);
    expect(acme.created_at).toBe('2026-09-01T08:00:00.000Z');
    expect(body.unresolved).toBeUndefined();
  });

  it('rejoue une vue : ses filtres, son tri, ses colonnes', async () => {
    const { body } = await get('/v1/clients/clients-actifs', key);
    expect(body.view).toEqual({ slug: 'clients-actifs', name: 'Clients actifs' });
    expect(body.rows.map((r: any) => r.nom)).toEqual(['Acme', 'Globex']);
    expect(Object.keys(body.rows[0])).not.toContain('total_commande');
    expect(Object.keys(body.rows[0])).not.toContain('commandes');
    const relancer = await get('/v1/clients/a-relancer', key);
    expect(relancer.body.rows.map((r: any) => r.nom)).toEqual(['Initech', 'Umbrella']);
  });

  it('rejoue une vue Requête avec le moteur SQL de Filarr', async () => {
    const { body } = await get('/v1/commandes/chiffre-par-ville', key);
    expect(body.columns).toEqual(['ville', 'commandes', 'chiffre']);
    expect(body.rows).toEqual([
      { ville: 'Lyon', commandes: 2, chiffre: 1540.5 },
      { ville: 'Nantes', commandes: 1, chiffre: 860 },
    ]);
  });

  it('filtre, trie, choisit les champs et pagine', async () => {
    expect((await get('/v1/clients?ville=Lyon', key)).body.rows.map((r: any) => r.nom)).toEqual(['Acme']);
    expect((await get('/v1/clients?ca[gt]=5000&sort=-ca', key)).body.rows.map((r: any) => r.nom)).toEqual(['Acme', 'Globex']);
    const p1 = await get('/v1/clients?sort=nom&limit=3&fields=nom', key);
    expect(p1.body.rows).toEqual([{ id: 'r_acme', nom: 'Acme' }, { id: 'r_globex', nom: 'Globex' }, { id: 'r_initech', nom: 'Initech' }]);
    const p2 = await get(`/v1/clients?sort=nom&limit=3&fields=nom&cursor=${p1.body.next}`, key);
    expect(p2.body.rows.map((r: any) => r.nom)).toEqual(['Umbrella']);
    expect(p2.body.next).toBeNull();
    expect((await get('/v1/clients?inconnu=1', key)).body.code).toBe('unknown_field');
    expect((await get('/v1/clients/rows/r_globex', key)).body.row.nom).toBe('Globex');
  });

  it('relation vers une base NON ouverte : identifiants bruts, agrégat nul et non résolu (§ 8)', async () => {
    const { body } = await get('/v1/catalogue', key);
    const chaise = body.rows.find((r: any) => r.produit === 'Chaise');
    expect(chaise.fournisseur).toEqual(['f_bois', 'f_metal']);
    expect(chaise.nb_fournisseurs).toBeNull();
    expect(body.unresolved).toEqual(['fournisseur', 'nb_fournisseurs']);
  });

  it('SQL en lecture seule : SELECT servi, toute écriture refusée', async () => {
    const ok = await send('POST', '/v1/sql', key, { sql: 'SELECT ville, count(*) AS n FROM clients GROUP BY ville ORDER BY ville' });
    expect(ok.status).toBe(200);
    expect(ok.body.columns).toEqual(['ville', 'n']);
    expect(ok.body.rows).toContainEqual(['Lyon', 1]);
    expect(ok.body.scanned).toBe(4);
    for (const sql of ["INSERT INTO clients (id, nom) VALUES ('x', 'y')", "UPDATE clients SET nom = 'x'", 'DELETE FROM clients']) {
      const refused = await send('POST', '/v1/sql', key, { sql });
      expect([refused.status, refused.body.code]).toEqual([400, 'sql_read_only']);
    }
    expect((await send('POST', '/v1/sql', key, { sql: 'SELEC' })).body.code).toBe('sql_syntax');
    const noSql = keyFor([{ target: 'all', read: true }]);
    expect((await send('POST', '/v1/sql', noSql, { sql: 'SELECT 1' })).status).toBe(403);
  });

  it('décrit l’API en OpenAPI 3.1 tirée des manifestes et des types', async () => {
    const res = await fetch(`${api}/openapi.json`);
    const spec = (await res.json()) as any;
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/v1/clients', '/v1/clients/clients-actifs', '/v1/clients/rows/{id}', '/v1/commandes/chiffre-par-ville', '/v1/sql']));
    expect(spec.paths['/v1/clients'].post).toBeDefined();
    expect(spec.paths['/v1/commandes'].post).toBeUndefined();
    const clients = spec.components.schemas.Clients;
    expect(clients.properties.ca.type).toEqual(['number', 'null']);
    expect(clients.properties.statut.enum).toEqual(['Prospect', 'Client', 'Perdu', null]);
    expect(clients.properties.total_commande.readOnly).toBe(true);
    expect(clients.properties.dernier_contact.format).toBe('date');
    const docs = await fetch(`${api}/docs`);
    expect(await docs.text()).toContain('/v1/clients/clients-actifs');
  });

  it('santé et métriques Prometheus', async () => {
    const health = await get('/health');
    expect(health.body).toMatchObject({ status: 'ok', link: 'live' });
    const metrics = await (await fetch(`${api}/metrics`)).text();
    expect(metrics).toContain('# TYPE filarr_gate_requests_total counter');
    expect(metrics).toMatch(/filarr_gate_base_rows\{base="clients"\} \d+/);
    expect(metrics).toContain('filarr_gate_link_up 1');
  });
});

describe('webhooks signés', () => {
  it('livre un changement venu de Filarr, signé, et reprend après un échec', async () => {
    const hook = gate.webhooks.create({
      name: 'Slack : client perdu',
      url: hookUrl,
      target: { storeId: stores[CLIENTS_DB]! },
      events: ['row.updated'],
      filter: "statut = 'Perdu'",
      transition: true,
      fields: ['nom', 'ville', 'statut'],
      expand: [],
    });
    received.length = 0;
    plannedStatuses.push(503);
    await mock.appEdit(stores[CLIENTS_DB]!, [{ r: 'r_globex', f: 'p_statut', v: 'o_perdu' }]);
    await until(() => received.filter((r) => r.status === 200).length === 1, 5000, 'livraison après reprise');
    expect(received.map((r) => r.status)).toEqual([503, 200]);
    const ok = received[1]!;
    expect(ok.headers['filarr-gate-event']).toBe('row.updated');
    expect(verifySignature(hook.secret, ok.body, String(ok.headers['filarr-gate-signature']))).toBe(true);
    expect(verifySignature(hook.secret, ok.body.replace('Globex', 'Globez'), String(ok.headers['filarr-gate-signature']))).toBe(false);
    const payload = JSON.parse(ok.body);
    expect(payload).toMatchObject({ event: 'row.updated', base: 'clients', changed: ['statut'], before: { statut: 'Client' }, row: { id: 'r_globex', nom: 'Globex', ville: 'Nantes', statut: 'Perdu' } });
    expect(Object.keys(payload.row)).toEqual(['id', 'nom', 'ville', 'statut']);
    // Une modification qui ne fait pas DEVENIR la condition vraie ne part pas
    received.length = 0;
    await mock.appEdit(stores[CLIENTS_DB]!, [{ r: 'r_globex', f: 'p_ville', v: 'Brest' }]);
    await until(() => gate.model.base('clients')!.base.mirror.rowById('r_globex')?.cells.p_ville === 'Brest', 3000, 'changement reçu');
    await new Promise((r) => setTimeout(r, 150));
    expect(received).toEqual([]);
    gate.webhooks.remove(hook.id);
  });
});

describe('avis de quota', () => {
  it('un message quota du flux part vers les webhooks gate.quota, et au journal', async () => {
    const hook = gate.webhooks.create({ name: 'Alerte quota', url: hookUrl, target: null, events: ['gate.quota'], filter: null, transition: false, fields: null, expand: [] });
    received.length = 0;
    mock.quota(accessIdOfGate, 'sync', 80);
    await until(() => received.some((r) => r.headers['filarr-gate-event'] === 'gate.quota'), 3000, 'livraison gate.quota');
    const body = JSON.parse(received.find((r) => r.headers['filarr-gate-event'] === 'gate.quota')!.body);
    expect(body).toMatchObject({ event: 'gate.quota', name: 'sync', pct: 80 });
    expect(verifySignature(hook.secret, received.at(-1)!.body, String(received.at(-1)!.headers['filarr-gate-signature']))).toBe(true);
    expect(gate.replicator.quotaAlerts[0]).toMatchObject({ name: 'sync', pct: 80 });
    expect(gate.journal.list({ kind: 'filarr' }).some((e) => e.code === 'quota')).toBe(true);
    gate.webhooks.remove(hook.id);
  });
});

describe('écriture (§ 7)', () => {
  let writer: string;
  beforeAll(() => {
    writer = keyFor([{ target: 'base', storeId: stores[CLIENTS_DB]!, read: true, create: true, update: true, delete: true }]);
  });

  it('ajoute, modifie et supprime une ligne, validée par Filarr et relue par l’application', async () => {
    const created = await send('POST', '/v1/clients', writer, { nom: 'Initech Lille', ville: 'Lille', statut: 'Client', ca: 4200 }, { 'Idempotency-Key': 'k-1' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ validated: true, row: { nom: 'Initech Lille', statut: 'Client', ca: 4200 } });
    const id = created.body.id as string;
    let app = await mock.appRows(stores[CLIENTS_DB]!);
    expect(app.find((r) => r.id === id)?.cells).toMatchObject({ p_nom: 'Initech Lille', p_statut: 'o_client', p_ca: 4200 });
    // La même requête rejouée ne crée rien de plus
    const again = await send('POST', '/v1/clients', writer, { nom: 'Initech Lille' }, { 'Idempotency-Key': 'k-1' });
    expect(again.headers.get('idempotency-replayed')).toBe('true');
    expect(again.body.id).toBe(id);
    const patched = await send('PATCH', `/v1/clients/${id}`, writer, { ca: null, ville: 'Roubaix' });
    expect(patched.body.row).toMatchObject({ ville: 'Roubaix', ca: null });
    const removed = await send('DELETE', `/v1/clients/rows/${id}`, writer);
    expect(removed.body).toMatchObject({ deleted: true });
    app = await mock.appRows(stores[CLIENTS_DB]!);
    expect(app.some((r) => r.id === id)).toBe(false);
  });

  it('une ligne ajoutée reçoit les valeurs par défaut de ses colonnes, comme « Nouvelle ligne » dans Filarr', async () => {
    // Sans « statut » : l'option par défaut de la colonne (Prospect), pas null.
    const created = await send('POST', '/v1/clients', writer, { nom: 'Hooli' });
    expect(created.status).toBe(201);
    expect(created.body.row).toMatchObject({ nom: 'Hooli', statut: 'Prospect' });
    const app = await mock.appRows(stores[CLIENTS_DB]!);
    expect(app.find((r) => r.id === created.body.id)?.cells).toMatchObject({ p_nom: 'Hooli', p_statut: 'o_prospect' });
    // Un champ donné a le dernier mot, même vide (null = laisser vide).
    const empty = await send('POST', '/v1/clients', writer, { nom: 'Sans statut', statut: null });
    expect(empty.body.row.statut).toBeNull();
    const batch = await send('POST', '/v1/clients', writer, [{ nom: 'A', statut: 'Client' }, { nom: 'B' }]);
    expect(batch.body.rows.map((r: Record<string, unknown>) => r.statut)).toEqual(['Client', 'Prospect']);
    // Rien ne reste derrière pour les essais suivants.
    for (const id of [created.body.id, empty.body.id, ...batch.body.rows.map((r: Record<string, unknown>) => r.id)]) {
      expect((await send('DELETE', `/v1/clients/rows/${id as string}`, writer)).body).toMatchObject({ deleted: true });
    }
  });

  it('refuse un champ inconnu, calculé, une option inconnue, et une clé sans droit d’écriture', async () => {
    expect((await send('POST', '/v1/clients', writer, { inconnu: 1 })).body.code).toBe('unknown_field');
    expect((await send('POST', '/v1/clients', writer, { total_commande: 3 })).body.code).toBe('field_read_only');
    expect((await send('POST', '/v1/clients', writer, { statut: 'VIP' })).body.code).toBe('unknown_option');
    const reader = keyFor([{ target: 'all', read: true }]);
    expect((await send('POST', '/v1/clients', reader, { nom: 'x' })).status).toBe(403);
    // Base ouverte en lecture seule à l'accès
    const commandes = keyFor([{ target: 'base', storeId: stores[COMMANDES_DB]!, read: true, create: true, update: false, delete: false }]);
    expect((await send('POST', '/v1/commandes', commandes, { numero: 'x' })).body.code).toBe('base_read_only');
  });

  it('écriture éteinte : refusée sans rien envoyer à Filarr', async () => {
    gate.config.settings.write = false;
    try {
      const before = mock.requests.filter((r) => r.path.endsWith('/commit')).length;
      expect((await send('POST', '/v1/clients', writer, { nom: 'x' })).body.code).toBe('write_disabled');
      expect(mock.requests.filter((r) => r.path.endsWith('/commit')).length).toBe(before);
    } finally {
      gate.config.settings.write = true;
    }
  });
});

describe('serveur MCP', () => {
  it('initialise, liste les outils, lit une vue et refuse une écriture SQL', async () => {
    const key = keyFor([{ target: 'all', read: true }], { mcp: true, sql: true });
    const rpc = async (body: unknown) => {
      const res = await fetch(`${api}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, session: res.headers.get('mcp-session-id'), body: res.status === 202 ? null : ((await res.json()) as any) };
    };
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'essai', version: '1' } } });
    expect(init.body.result.protocolVersion).toBe('2025-06-18');
    expect(init.body.result.serverInfo.name).toBe('filarr-gate');
    expect(init.session).toBeTruthy();
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(tools.body.result.tools.map((t: any) => t.name)).toEqual(['list_bases', 'query_view', 'get_row', 'run_sql']);
    const view = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'query_view', arguments: { base: 'clients', view: 'clients-actifs' } } });
    expect(view.body.result.isError).toBe(false);
    expect(view.body.result.structuredContent.rows.map((r: any) => r.nom)).toContain('Acme');
    const write = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'run_sql', arguments: { sql: 'DELETE FROM clients' } } });
    expect(write.body.result.isError).toBe(true);
    expect(write.body.result.content[0].text).toContain('sql_read_only');
    const noMcp = keyFor([{ target: 'all', read: true }]);
    const refused = await fetch(`${api}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${noMcp}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(refused.status).toBe(403);
  });
});

describe('interface de gestion', () => {
  it('demande une session, puis l’en-tête X-Gate-Admin pour écrire', async () => {
    expect((await fetch(`${admin}/admin/api/dashboard`)).status).toBe(401);
    const state = (await (await fetch(`${admin}/admin/api/state`)).json()) as any;
    expect(state.setup.done).toBe(true);
    expect(state.authenticated).toBe(false);
    expect(state.link).toBeUndefined();
    const noHeader = await fetch(`${admin}/admin/api/login`, { method: 'POST', body: JSON.stringify({ password: ADMIN_PASSWORD }) });
    expect(noHeader.status).toBe(403);
    const bad = await fetch(`${admin}/admin/api/login`, { method: 'POST', headers: { 'X-Gate-Admin': '1' }, body: JSON.stringify({ password: 'non' }) });
    expect(bad.status).toBe(401);
    const login = await fetch(`${admin}/admin/api/login`, { method: 'POST', headers: { 'X-Gate-Admin': '1' }, body: JSON.stringify({ password: ADMIN_PASSWORD }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect(login.headers.get('set-cookie')).toContain('HttpOnly');
    const dash = (await (await fetch(`${admin}/admin/api/dashboard`, { headers: { Cookie: cookie } })).json()) as any;
    expect(dash.bases.map((b: any) => b.slug)).toEqual(['catalogue', 'clients', 'commandes']);
    expect(dash.link.state).toBe('live');
    const bases = (await (await fetch(`${admin}/admin/api/bases`, { headers: { Cookie: cookie } })).json()) as any;
    const catalogue = bases.bases.find((b: any) => b.slug === 'catalogue');
    expect(catalogue.fields.find((f: any) => f.name === 'fournisseur')).toMatchObject({ target: { granted: false }, unresolved: true });
    const created = await fetch(`${admin}/admin/api/keys`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-Gate-Admin': '1' },
      body: JSON.stringify({ name: 'Tableau Power BI', scopes: [{ target: 'view', storeId: stores[CLIENTS_DB], viewId: 'v_actifs' }], expiresInDays: 90 }),
    });
    const { key, record } = (await created.json()) as any;
    expect(key).toMatch(/^gk_tab_/);
    expect(record.endpoints).toBe('clients/clients-actifs');
    expect((await get('/v1/clients/clients-actifs', key)).status).toBe(200);
    const sql = (await (await fetch(`${admin}/admin/api/sql`, { method: 'POST', headers: { Cookie: cookie, 'X-Gate-Admin': '1' }, body: JSON.stringify({ sql: 'SELECT count(*) AS n FROM commandes' }) })).json()) as any;
    expect(sql.rows).toEqual([[3]]);
    const journal = (await (await fetch(`${admin}/admin/api/journal?kind=filarr`, { headers: { Cookie: cookie } })).json()) as any;
    expect(journal.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(journal)).not.toContain('flr_live_');
  });
});
