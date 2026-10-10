/**
 * L'exécutant des synchros externes (`source-externe-1`) de bout en bout : le
 * Filarr en mémoire (magasin, définition SIGNÉE dans le schéma, état et file
 * publiés, boîte aux lettres des décisions, bail) et une base D1 simulée sur
 * `node:sqlite` derrière l'API HTTP de Cloudflare.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbProperty, DbRow, DbView } from '../packages/core/src/types';
import { Gate } from '../packages/cli/src/gate';
import { memoryBlobs } from '../packages/server/src/sync/runner';
import { setLogLevel } from '../packages/server/src/log';
import { MockFilarr } from './support/mockFilarr';
import { D1Sim, routeFetch } from './support/simulators';
import { tempDir, until } from './support/util';

setLogLevel('silent');

const PROPS: DbProperty[] = [
  { id: 'p_id', name: 'Id', type: 'number' },
  { id: 'p_nom', name: 'Nom', type: 'text' },
  { id: 'p_statut', name: 'Statut', type: 'select', options: [{ id: 'o_a', label: 'Actif', color: 'green' }, { id: 'o_p', label: 'Perdu', color: 'red' }] },
  { id: 'p_note', name: 'Note interne', type: 'text' },
];
const VIEWS: DbView[] = [{ id: 'v1', name: 'Tous', type: 'table', filters: [], sorts: [] }];

let mock: MockFilarr;
let d1: D1Sim;
let storeId = '';
let token = '';
let accessId = '';
let gates: Gate[] = [];

const DEF_ID = 'xs_CLIENTSboutique0000001';

function def(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: DEF_ID,
    rev: 1,
    name: 'Clients de la boutique',
    connector: 'd1',
    conn: { account: 'acc123', database: 'db-boutique' },
    host: 'api.cloudflare.com',
    from: { table: 'clients' },
    key: { cols: ['id'], gen: 'source' },
    marker: { col: 'maj_le', kind: 'iso' },
    mode: 'both',
    map: [
      { col: 'id', prop: 'p_id', dir: 'in', type: 'number' },
      { col: 'nom', prop: 'p_nom', dir: 'both', type: 'text' },
      { col: 'statut', prop: 'p_statut', dir: 'both', type: 'select' },
    ],
    conflict: 'source',
    rowConflict: 'delete',
    onGone: 'mark',
    onFilarrDelete: 'delete',
    guard: { pct: 20, min: 2 },
    runner: { kind: 'gate', accessId, name: 'ERP Atelier' },
    schedule: { every: '15m', tz: 'Europe/Paris' },
    ...over,
  };
}

beforeEach(async () => {
  mock = new MockFilarr({ writeSwitch: true });
  await mock.listen();
  storeId = await mock.createStore({ dbId: 'db-clients-sync', title: 'Clients', properties: PROPS, rows: [] as DbRow[], views: VIEWS });
  ({ token, accessId } = await mock.createAccess('ERP Atelier', 'pro'));
  await mock.grant(accessId, storeId, 'rw');
  d1 = new D1Sim();
  d1.exec('CREATE TABLE clients (id INTEGER PRIMARY KEY, nom TEXT, statut TEXT, maj_le TEXT, interne TEXT)');
  const now = '2026-10-10T08:00:00Z';
  d1.exec("INSERT INTO clients (id, nom, statut, maj_le, interne) VALUES (1, 'Acme', 'Actif', ?, 'x'), (2, 'Globex', 'Actif', ?, 'y'), (3, 'Initech', 'Perdu', ?, 'z')", [now, now, now]);
});

afterEach(async () => {
  for (const g of gates) await g.stop().catch(() => undefined);
  gates = [];
  await mock.close();
});

async function startGate(opts: { secret?: string | null; tok?: string } = {}): Promise<Gate> {
  const gate = new Gate({
    env: {
      FILARR_GATE_STATE_DIR: tempDir(),
      FILARR_GATE_API_URL: mock.url,
      FILARR_GATE_TOKEN: opts.tok ?? token,
      FILARR_GATE_PORT: '0',
      FILARR_GATE_ADMIN_PORT: '0',
      FILARR_GATE_CACHE: 'memory',
      FILARR_GATE_WRITE: 'true',
      FILARR_GATE_ADMIN_PASSWORD: 'mot-de-passe-de-test',
    },
    replicaTiming: { backoffMinMs: 20, backoffMaxMs: 200, pausedRetryMs: 100 },
    sync: {
      blobs: memoryBlobs(),
      tcp: false,
      fetch: routeFetch({ 'api.cloudflare.com': d1.handler }),
      externalSecret: () => (opts.secret === undefined ? d1.token : opts.secret),
      timers: false,
      jitter: false,
    },
  });
  gates.push(gate);
  await gate.start();
  await until(() => gate.replicator.link === 'live', 5000, 'flux');
  return gate;
}

const rowsByNom = async () => Object.fromEntries((await mock.appRows(storeId)).map((r) => [r.cells.p_nom as string, r]));
const runner = () => `a:${accessId}`;

describe('miroir et deux sens contre D1', () => {
  it('premier passage : les lignes de D1 entrent dans Filarr ; l’état publié se lit par un membre', async () => {
    await mock.appSetExtSource(storeId, def({ mode: 'mirror', map: (def().map as Array<Record<string, unknown>>).map((m) => ({ ...m, dir: 'in' })), conflict: undefined, rowConflict: undefined }));
    const gate = await startGate();
    await until(() => gate.sync!.list().length === 1, 5000, 'définition trouvée');
    expect(gate.sync!.get(DEF_ID)!.blocked).toBeNull();
    const status = await gate.sync!.runPass(DEF_ID);
    expect(status).toMatchObject({ state: 'ok', counts: { in: { created: 3 } } });
    const rows = await rowsByNom();
    expect(Object.keys(rows).sort()).toEqual(['Acme', 'Globex', 'Initech']);
    expect(rows.Acme!.id).toMatch(/^ext-/);
    expect(rows.Initech!.cells.p_statut).toBe('o_p');
    // La colonne « interne » n'est jamais lue : rien d'elle dans Filarr
    expect(JSON.stringify(rows)).not.toContain('"x"');
    const published = await mock.appReadStatus(storeId, runner());
    expect(published.status).toMatchObject({ def: DEF_ID, state: 'ok', runner: runner(), where: 'self' });
    expect(published.status!.journal.some((j) => j.kind === 'created')).toBe(true);
  });

  it('miroir : une valeur locale changée par un vieux client est remplacée, au journal ; l’API refuse la colonne', async () => {
    await mock.appSetExtSource(storeId, def({ mode: 'mirror', map: (def().map as Array<Record<string, unknown>>).map((m) => ({ ...m, dir: 'in' })), conflict: undefined, rowConflict: undefined }));
    const gate = await startGate();
    await until(() => gate.sync!.list().length === 1, 5000, 'définition');
    await gate.sync!.runPass(DEF_ID);
    const acme = (await rowsByNom()).Acme!;
    await mock.appEdit(storeId, [{ r: acme.id, f: 'p_nom', v: 'Acme (modifié à la main)' }]);
    await until(async () => gate.replicator.bases.get(storeId)!.mirror.rowById(acme.id)?.cells.p_nom === 'Acme (modifié à la main)', 5000, 'vieux client');
    const st = await gate.sync!.runPass(DEF_ID);
    expect(st!.journal.some((j) => j.kind === 'replaced_local' && j.old === 'Acme (modifié à la main)')).toBe(true);
    expect((await rowsByNom()).Acme).toBeDefined();
    // L'API locale : colonne tenue par la source, lignes venues de la source
    const key = gate.keys.create({ name: 'erp', scopes: [{ target: 'base', storeId, read: true, create: true, update: true, delete: true }] }).key;
    const api = `http://127.0.0.1:${gate.apiPort}`;
    const patch = await fetch(`${api}/v1/clients/rows/${acme.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ nom: 'X' }) });
    expect(((await patch.json()) as { code: string }).code).toBe('field_managed');
    const post = await fetch(`${api}/v1/clients`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ note_interne: 'à moi' }) });
    expect(((await post.json()) as { code: string }).code).toBe('rows_managed');
    // Une colonne « à vous » reste écrivable
    const mine = await fetch(`${api}/v1/clients/rows/${acme.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ note_interne: 'à moi' }) });
    expect(mine.status).toBe(200);
  });

  it('deux sens : Filarr vers D1 sous condition, D1 vers Filarr ; conflit tranché par la politique', async () => {
    await mock.appSetExtSource(storeId, def());
    const gate = await startGate();
    await until(() => gate.sync!.list().length === 1, 5000, 'définition');
    await gate.sync!.runPass(DEF_ID);
    const rows = await rowsByNom();
    // Filarr change Globex ; D1 change Acme
    await mock.appEdit(storeId, [{ r: rows.Globex!.id, f: 'p_nom', v: 'Globex SA' }]);
    d1.exec("UPDATE clients SET statut = 'Perdu', maj_le = '2026-10-10T09:00:00Z' WHERE id = 1");
    await until(() => gate.replicator.bases.get(storeId)!.mirror.rowById(rows.Globex!.id)?.cells.p_nom === 'Globex SA', 5000, 'geste de l’appli');
    const st = await gate.sync!.runPass(DEF_ID);
    expect(st).toMatchObject({ state: 'ok' });
    expect(d1.exec('SELECT nom FROM clients WHERE id = 2').results[0]!.nom).toBe('Globex SA');
    expect((await rowsByNom()).Acme!.cells.p_statut).toBe('o_p');
    // Conflit : les deux côtés changent la même cellule ; politique « la source l'emporte »
    await mock.appEdit(storeId, [{ r: rows.Initech!.id, f: 'p_nom', v: 'Initech (Filarr)' }]);
    d1.exec("UPDATE clients SET nom = 'Initech (D1)', maj_le = '2026-10-10T10:00:00Z' WHERE id = 3");
    await until(() => gate.replicator.bases.get(storeId)!.mirror.rowById(rows.Initech!.id)?.cells.p_nom === 'Initech (Filarr)', 5000, 'geste');
    const st2 = await gate.sync!.runPass(DEF_ID);
    expect((await rowsByNom())['Initech (D1)']).toBeDefined();
    expect(st2!.journal.some((j) => j.kind === 'conflict' && j.old === 'Initech (Filarr)')).toBe(true);
  });

  it('« me demander » : la cellule entre dans la file, garde sa valeur ; un membre tranche, le passage suivant applique', async () => {
    await mock.appSetExtSource(storeId, def({ conflict: 'ask' }));
    const gate = await startGate();
    await until(() => gate.sync!.list().length === 1, 5000, 'définition');
    await gate.sync!.runPass(DEF_ID);
    const rows = await rowsByNom();
    await mock.appEdit(storeId, [{ r: rows.Acme!.id, f: 'p_nom', v: 'Acme (Filarr)' }]);
    d1.exec("UPDATE clients SET nom = 'Acme (D1)', maj_le = '2026-10-10T11:00:00Z' WHERE id = 1");
    await until(() => gate.replicator.bases.get(storeId)!.mirror.rowById(rows.Acme!.id)?.cells.p_nom === 'Acme (Filarr)', 5000, 'geste');
    const st = await gate.sync!.runPass(DEF_ID);
    expect(st).toMatchObject({ state: 'ok', code: 'extdb_conflicts_pending', queue: { n: 1 } });
    // Rien n'est écrit, d'aucun côté
    expect(d1.exec('SELECT nom FROM clients WHERE id = 1').results[0]!.nom).toBe('Acme (D1)');
    expect((await mock.appRows(storeId)).find((r) => r.id === rows.Acme!.id)!.cells.p_nom).toBe('Acme (Filarr)');
    // Un membre lit la file publiée et tranche « garder la valeur de Filarr » ; le dépôt déclenche un passage
    const { queue } = await mock.appReadStatus(storeId, runner());
    expect(queue!.entries).toMatchObject([{ col: 'nom', kind: 'cell', source: { v: 'Acme (D1)' }, filarr: { v: 'Acme (Filarr)' } }]);
    await mock.appDecide(storeId, runner(), DEF_ID, [{ id: queue!.entries[0]!.id, choice: 'filarr' }]);
    await until(() => d1.exec('SELECT nom FROM clients WHERE id = 1').results[0]!.nom === 'Acme (Filarr)', 5000, 'décision appliquée');
    await until(async () => (await mock.appReadStatus(storeId, runner())).status?.queue.n === 0, 5000, 'file vidée');
    const after = await mock.appReadStatus(storeId, runner());
    expect(after.status!.journal.some((j) => j.kind === 'resolved' && j.by?.userId === 'u_membre')).toBe(true);
    // La décision est acquittée : la boîte aux lettres est vide
    expect(mock.extOf(storeId).mailbox.get(runner())).toEqual([]);
  });

  it('garde-fou : trop de lignes disparues d’un coup, arrêt avant toute écriture ; l’accord d’un membre vaut pour ce passage', async () => {
    // Sans repère, chaque passage lit la table entière : seule une lecture entière voit les disparitions
    await mock.appSetExtSource(storeId, def({ marker: null }));
    const gate = await startGate();
    await until(() => gate.sync!.list().length === 1, 5000, 'définition');
    await gate.sync!.runPass(DEF_ID);
    d1.exec('DELETE FROM clients');
    const st = await gate.sync!.runPass(DEF_ID);
    expect(st).toMatchObject({ state: 'question', code: 'extdb_guard', question: { kind: 'guard', total: 3 } });
    expect(Object.keys(await rowsByNom())).toHaveLength(3);
    expect((await mock.appRows(storeId)).some((r) => (r as unknown as { extGone?: unknown }).extGone)).toBe(false);
    mock.appExtRun(storeId, runner(), DEF_ID, { guard: st!.question!.pass });
    await until(async () => (await mock.appRows(storeId)).filter((r) => (r as unknown as { extGone?: unknown }).extGone).length === 3, 5000, 'lignes marquées après accord');
  });
});

describe('ce qui empêche une synchro de tourner', () => {
  it('définition signée par un autre compte : en attente de la signature du créateur, rien n’est exécuté', async () => {
    await mock.appSetExtSource(storeId, def(), { signer: 'other' });
    const gate = await startGate();
    await until(() => gate.sync!.list().length === 1, 5000, 'définition');
    expect(gate.sync!.get(DEF_ID)!.blocked).toBe('extdb_unsigned');
    const st = await gate.sync!.runPass(DEF_ID);
    expect(st).toMatchObject({ state: 'waiting', code: 'extdb_unsigned' });
    expect(d1.calls).toBe(0);
    expect(await mock.appRows(storeId)).toEqual([]);
  });

  it('clé manquante, palier Free, accès sans étiquette', async () => {
    await mock.appSetExtSource(storeId, def());
    const g1 = await startGate({ secret: null });
    await until(() => g1.sync!.list().length === 1, 5000, 'définition');
    expect(g1.sync!.get(DEF_ID)!.blocked).toBe('extdb_key_missing');
    // La clé donnée dans la boîte (chiffrée sous A_local), la synchro devient prête
    await g1.sync!.setKey(DEF_ID, d1.token);
    expect(g1.sync!.get(DEF_ID)!.blocked).toBeNull();
    expect(JSON.stringify(g1.state.data.extdbKeys)).not.toContain(d1.token);

    const free = await mock.createAccess('Free', 'free');
    await mock.grant(free.accessId, storeId, 'r');
    await mock.appSetExtSource(storeId, def({ runner: { kind: 'gate', accessId: free.accessId } }));
    const g2 = new Gate({
      env: { FILARR_GATE_STATE_DIR: tempDir(), FILARR_GATE_API_URL: mock.url, FILARR_GATE_TOKEN: free.token, FILARR_GATE_PORT: '0', FILARR_GATE_ADMIN_PORT: '0', FILARR_GATE_CACHE: 'memory' },
      sync: { blobs: memoryBlobs(), tcp: false, fetch: routeFetch({ 'api.cloudflare.com': d1.handler }), externalSecret: () => d1.token, timers: false },
    });
    gates.push(g2);
    await g2.start();
    await until(() => g2.sync!.list().length === 1, 5000, 'définition (Free)');
    expect(g2.sync!.get(DEF_ID)!.blocked).toBe('extdb_tier');
  });

  it('deux boîtes avec le même jeton (P1) : chacune son instance ; la seconde voit le bail tenu, le dit au journal sans planter, et passe une fois la première arrêtée', async () => {
    await mock.appSetExtSource(storeId, def());
    const a = await startGate();
    const b = await startGate();
    await until(() => a.sync!.list().length === 1 && b.sync!.list().length === 1, 5000, 'définitions');
    // Le même jeton : le même exécutant `a:<accessId>` ; deux processus, deux instances tirées au démarrage
    expect(a.sync!.instance).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(b.sync!.instance).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.sync!.instance).not.toBe(b.sync!.instance);
    expect(await a.sync!.runPass(DEF_ID)).toMatchObject({ state: 'ok' });
    const calls = d1.calls;
    const st = await b.sync!.runPass(DEF_ID);
    expect(st).toMatchObject({ state: 'waiting', code: 'extdb_lease_held' });
    // Rien lu dans la source, rien écrit nulle part ; le journal le dit, avec l'échéance du bail
    expect(d1.calls).toBe(calls);
    const note = b.journal.list().find((e) => e.code === 'extdb_lease_held');
    expect(note?.note).toMatch(/une autre instance de cette boîte noire exécute déjà cette synchro \(bail tenu jusqu’à \d{4}-/);
    // Les demandes de bail portent l'instance de chaque processus
    expect(mock.leaseRequests.map((r) => r.instance)).toEqual([a.sync!.instance, b.sync!.instance]);
    // La première s'arrête proprement : elle rend son bail (DELETE ?instance=), la seconde passe
    await a.stop();
    expect(mock.extOf(storeId).leases.has(DEF_ID)).toBe(false);
    const again = await b.sync!.runPass(DEF_ID);
    expect(again, JSON.stringify({ code: again?.code, q: again?.question })).toMatchObject({ state: 'ok' });
    expect(mock.extOf(storeId).leases.get(DEF_ID)).toMatchObject({ runnerId: runner(), instance: b.sync!.instance });
  });

  it('P1 : à l’arrêt, un processus ne rend que SON bail, jamais celui d’une autre instance', async () => {
    await mock.appSetExtSource(storeId, def());
    const a = await startGate();
    await until(() => a.sync!.list().length === 1, 5000, 'définition');
    await a.sync!.runPass(DEF_ID);
    // Une autre instance (même exécutant) prend le bail après échéance ; l'arrêt de `a` n'y touche pas
    mock.extOf(storeId).leases.set(DEF_ID, { runnerId: runner(), instance: 'autre-processus-000001', until: Date.now() + 60_000 });
    await a.stop();
    expect(mock.extOf(storeId).leases.get(DEF_ID)).toMatchObject({ instance: 'autre-processus-000001' });
  });

  it('une relecture des définitions PENDANT un passage ne laisse pas la synchro « en cours » pour toujours', async () => {
    await mock.appSetExtSource(storeId, def());
    let gate: Gate | null = null;
    let rescanned = false;
    // La relecture tombe au milieu du passage (comme un changement du magasin reçu par le flux)
    const handler = d1.handler;
    const fetchDuring = routeFetch({
      'api.cloudflare.com': async (req) => {
        if (!rescanned && gate) {
          rescanned = true;
          await gate.sync!.scan();
        }
        return handler(req);
      },
    });
    gate = new Gate({
      env: { FILARR_GATE_STATE_DIR: tempDir(), FILARR_GATE_API_URL: mock.url, FILARR_GATE_TOKEN: token, FILARR_GATE_PORT: '0', FILARR_GATE_ADMIN_PORT: '0', FILARR_GATE_CACHE: 'memory', FILARR_GATE_WRITE: 'true' },
      sync: { blobs: memoryBlobs(), tcp: false, fetch: fetchDuring, externalSecret: () => d1.token, timers: false, jitter: false },
    });
    gates.push(gate);
    await gate.start();
    await until(() => gate!.sync!.list().length === 1, 5000, 'définition');
    expect(await gate.sync!.runPass(DEF_ID)).toMatchObject({ state: 'ok' });
    expect(rescanned).toBe(true);
    expect(gate.sync!.get(DEF_ID)!.running).toBe(false);
    // Le passage suivant tourne vraiment (il relit la source), et l'état retenu est le sien
    const calls = d1.calls;
    const next = await gate.sync!.runPass(DEF_ID);
    expect(d1.calls).toBeGreaterThan(calls);
    expect(gate.sync!.get(DEF_ID)!.status).toBe(next);
  });

  it('P3 : une relation entrante est refusée à la validation (`unsupported_column`), rien n’est lu ni importé', async () => {
    const map = [...(def().map as Array<Record<string, unknown>>), { col: 'client_parent', prop: 'p_parent', dir: 'in', type: 'relation' }];
    await mock.appSetExtSource(storeId, def({ map }));
    const gate = await startGate();
    await until(() => gate.sync!.list().length === 1, 5000, 'définition');
    expect(gate.sync!.get(DEF_ID)).toMatchObject({ blocked: 'extdb_def_invalid', detail: 'unsupported_column' });
    expect(await gate.sync!.runPass(DEF_ID)).toMatchObject({ state: 'waiting', code: 'extdb_def_invalid' });
    expect(d1.calls).toBe(0);
    expect(await mock.appRows(storeId)).toEqual([]);
  });
});
