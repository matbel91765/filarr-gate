/**
 * Les tutoriels des synchros externes, rejoués : examples/sync-d1 (une base D1 simulée sur
 * `node:sqlite`, le moteur de D1, derrière l'API HTTP de Cloudflare) et examples/sync-postgres
 * (un PostgreSQL JETABLE, sauté s'il n'est pas installé). Le SQL des exemples est exécuté tel quel ;
 * les définitions sont celles des exemples, signées comme l'appli du créateur les signe ; la boîte
 * est pilotée par la VRAIE ligne de commande (`filarr-gate sources …`), par le canal de la boîte en
 * marche, comme le font les tutoriels.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Gate, type GateOptions } from '../packages/cli/src/gate';
import { setLogLevel } from '../packages/server/src/log';
import { memoryBlobs } from '../packages/server/src/sync/runner';
import type { DbProperty } from '../packages/core/src/types';
import { freePort, repo, start } from './support/examples';
import { MockFilarr } from './support/mockFilarr';
import { startPostgres, type TempPostgres } from './support/postgres';
import { D1Sim, routeFetch } from './support/simulators';
import { tempDir, until } from './support/util';

setLogLevel('silent');

const cli = join(repo, 'packages', 'cli', 'dist', 'cli.js');
const example = (p: string) => readFileSync(join(repo, 'examples', p), 'utf8');

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: join(repo, 'packages', 'cli'), stdio: 'ignore' });
}, 120_000);

/** Une commande `filarr-gate`, lancée comme un administrateur la lance sur la machine de la boîte. */
async function filarrGate(stateDir: string, args: string[], stdin?: string): Promise<{ code: number | null; out: string }> {
  const p = start(process.execPath, [cli, ...args], { FILARR_GATE_STATE_DIR: stateDir, FILARR_GATE_LOG_LEVEL: 'error', FILARR_GATE_TOKEN: '' });
  if (stdin !== undefined) p.child.stdin!.end(stdin);
  const { code, lines } = await p.done;
  return { code, out: lines.join('\n') };
}

/** Une définition d'exemple, telle que l'appli du créateur l'écrit pour CET accès. */
function definition(file: string, accessId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const def = JSON.parse(example(file)) as Record<string, unknown>;
  delete def.sig;
  delete def.signer;
  return { ...def, runner: { ...(def.runner as object), accessId }, ...over };
}

const CLIENT_PROPS: DbProperty[] = [
  { id: 'p_id', name: 'Id', type: 'number' },
  { id: 'p_nom', name: 'Nom', type: 'text' },
  { id: 'p_ville', name: 'Ville', type: 'text' },
  {
    id: 'p_statut',
    name: 'Statut',
    type: 'select',
    options: [
      { id: 'o_prospect', label: 'Prospect', color: 'gray' },
      { id: 'o_client', label: 'Client', color: 'green' },
      { id: 'o_perdu', label: 'Perdu', color: 'red' },
    ],
  },
  { id: 'p_note', name: 'Note', type: 'text' },
  { id: 'p_interne', name: 'Note interne', type: 'text' },
];
const VIEWS = [{ id: 'v1', name: 'Tous', type: 'table' as const, filters: [], sorts: [] }];

let mock: MockFilarr;
let gates: Gate[] = [];

afterEach(async () => {
  for (const g of gates) await g.stop().catch(() => undefined);
  gates = [];
  await mock?.close();
});

async function startGate(token: string, stateDir: string, sync: GateOptions['sync']): Promise<Gate> {
  const gate = new Gate({
    env: {
      FILARR_GATE_STATE_DIR: stateDir,
      FILARR_GATE_API_URL: mock.url,
      FILARR_GATE_TOKEN: token,
      FILARR_GATE_PORT: '0',
      FILARR_GATE_ADMIN_PORT: '0',
      FILARR_GATE_CACHE: 'memory',
      FILARR_GATE_WRITE: 'true',
      FILARR_GATE_ADMIN_PASSWORD: 'mot-de-passe-des-tutoriels',
    },
    replicaTiming: { backoffMinMs: 20, backoffMaxMs: 200, pausedRetryMs: 100 },
    sync: { blobs: memoryBlobs(), timers: false, jitter: false, ...sync },
  });
  gates.push(gate);
  await gate.start();
  await until(() => gate.replicator.link === 'live', 5000, 'flux');
  return gate;
}

// ==================== D1 ====================

describe('examples/sync-d1 : une base D1, dans chaque sens', () => {
  let d1: D1Sim;
  let token = '';
  let accessId = '';
  let stateDir = '';

  async function setup(rows: Array<{ id: string; cells: Record<string, unknown> }> = [], seed = true) {
    mock = new MockFilarr({ writeSwitch: true });
    await mock.listen();
    d1 = new D1Sim();
    // Le SQL de l'exemple, tel quel (D1 est SQLite)
    d1.db.exec(example('sync-d1/schema.sql'));
    if (seed) d1.db.exec(example('sync-d1/seed.sql'));
    const storeId = await mock.createStore({ dbId: 'db-clients-boutique', title: 'Clients de la boutique', properties: CLIENT_PROPS, rows: rows.map((r) => ({ ...r, createdAt: '2026-10-01T08:00:00.000Z' })), views: VIEWS });
    ({ token, accessId } = await mock.createAccess('ERP Atelier', 'pro'));
    await mock.grant(accessId, storeId, 'rw');
    stateDir = tempDir();
    return storeId;
  }

  const runnerOf = () => `a:${accessId}`;
  const d1Row = (id: number) => d1.exec('SELECT * FROM clients WHERE id = ?', [id]).results[0]!;
  const filarrRow = async (storeId: string, nom: string) => (await mock.appRows(storeId)).find((r) => r.cells.p_nom === nom);
  const sync = () => ({ tcp: false, fetch: routeFetch({ 'api.cloudflare.com': d1.handler }) });

  it('miroir entrant : la clé donnée par `sources key --stdin`, le passage, les colonnes tenues par la source', async () => {
    const storeId = await setup();
    const def = definition('sync-d1/definition.mirror.json', accessId);
    await mock.appSetExtSource(storeId, def, { managedBy: true });
    const gate = await startGate(token, stateDir, sync());
    await until(() => gate.sync!.list().length === 1, 5000, 'définition trouvée');

    // 1. La boîte dit ce qui manque : la clé, et le nom de la variable qui peut la donner
    const listed = await filarrGate(stateDir, ['sources', 'list', '--json']);
    const src = (JSON.parse(listed.out) as Array<{ defId: string; blocked: string; key: { source: string | null; env: string } }>)[0]!;
    expect(src).toMatchObject({ defId: 'xs_DemoClientsBoutique000', blocked: 'extdb_key_missing', key: { source: null, env: 'FILARR_GATE_EXTDB_DEMOCLIE' } });

    // 2. La clé, par l'entrée standard (jamais dans l'historique du shell)
    const keyed = await filarrGate(stateDir, ['sources', 'key', 'xs_DemoClientsBoutique000', '--stdin'], d1.token);
    expect(keyed.out).toContain('Clé enregistrée');

    // 3. Un passage maintenant
    const ran = await filarrGate(stateDir, ['sources', 'run', 'xs_DemoClientsBoutique000']);
    expect(ran.out, ran.out).toContain('Passage : ok');
    const acme = (await filarrRow(storeId, 'Acme'))!;
    expect(acme.id).toMatch(/^ext-/);
    expect(acme.cells).toMatchObject({ p_id: 1, p_ville: 'Lyon', p_statut: 'o_client', p_note: 'Paie à 30 jours' });

    // 4. L'API locale refuse d'écrire ce que la source tient ; une colonne « à vous » s'écrit
    const key = gate.keys.create({ name: 'erp', scopes: [{ target: 'base', storeId, read: true, create: true, update: true, delete: true }] }).key;
    const api = `http://127.0.0.1:${gate.apiPort}/v1/clients-de-la-boutique`;
    const h = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    expect(((await (await fetch(`${api}/rows/${acme.id}`, { method: 'PATCH', headers: h, body: '{"ville":"Paris"}' })).json()) as { code: string }).code).toBe('field_managed');
    expect((await fetch(`${api}/rows/${acme.id}`, { method: 'PATCH', headers: h, body: '{"note_interne":"Gros client"}' })).status).toBe(200);
    expect(((await (await fetch(api, { method: 'POST', headers: h, body: '{"note_interne":"x"}' })).json()) as { code: string }).code).toBe('rows_managed');

    // 5. Un changement dans D1 arrive au passage suivant ; la colonne « à vous » n'est pas touchée
    d1.exec("UPDATE clients SET ville = 'Villeurbanne' WHERE id = 1");
    expect((await filarrGate(stateDir, ['sources', 'run', 'xs_DemoClientsBoutique000'])).out).toContain('Passage : ok');
    expect((await filarrRow(storeId, 'Acme'))!.cells).toMatchObject({ p_ville: 'Villeurbanne', p_interne: 'Gros client' });
  }, 60_000);

  it('publication : les lignes de Filarr partent vers D1, la clé tirée par D1 revient ; une valeur changée dans D1 est remplacée', async () => {
    const storeId = await setup(
      [
        { id: 'db-hooli', cells: { p_nom: 'Hooli', p_ville: 'Bordeaux', p_statut: 'o_client' } },
        { id: 'db-piper', cells: { p_nom: 'Pied Piper', p_statut: 'o_prospect', p_note: 'Démo jeudi' } },
      ],
      false
    );
    await mock.appSetExtSource(storeId, definition('sync-d1/definition.publish.json', accessId), { managedBy: true });
    const gate = await startGate(token, stateDir, sync());
    await until(() => gate.sync!.list().length === 1, 5000, 'définition');
    await filarrGate(stateDir, ['sources', 'key', 'xs_DemoClientsBoutique001', '--stdin'], d1.token);
    expect((await filarrGate(stateDir, ['sources', 'run', 'xs_DemoClientsBoutique001'])).out).toContain('Passage : ok');
    const rows = d1.exec('SELECT id, nom, ville, statut, note FROM clients ORDER BY id').results;
    expect(rows).toEqual([
      { id: 1, nom: 'Hooli', ville: 'Bordeaux', statut: 'Client', note: null },
      { id: 2, nom: 'Pied Piper', ville: null, statut: 'Prospect', note: 'Démo jeudi' },
    ]);
    await until(async () => (await filarrRow(storeId, 'Hooli'))?.cells.p_id === 1, 5000, 'la clé de D1 revient dans Filarr');

    // Une valeur changée dans D1 hors de Filarr : Filarr fait foi, elle est remplacée (et notée au journal)
    d1.exec("UPDATE clients SET ville = 'Mérignac' WHERE id = 1");
    const st = await gate.sync!.runPass('xs_DemoClientsBoutique001');
    expect(d1Row(1).ville).toBe('Bordeaux');
    expect(st!.journal.some((j) => j.kind === 'replaced_source' && j.old === 'Mérignac')).toBe(true);
  }, 60_000);

  it('deux sens : les quatre politiques en un passage, la file « me demander », la décision, « Rétablir »', async () => {
    const storeId = await setup();
    await mock.appSetExtSource(storeId, definition('sync-d1/definition.both.json', accessId), { managedBy: true });
    const gate = await startGate(token, stateDir, sync());
    await until(() => gate.sync!.list().length === 1, 5000, 'définition');
    await filarrGate(stateDir, ['sources', 'key', 'xs_DemoClientsBoutique002', '--stdin'], d1.token);
    expect((await filarrGate(stateDir, ['sources', 'run', 'xs_DemoClientsBoutique002'])).out).toContain('Passage : ok');
    const acme = (await filarrRow(storeId, 'Acme'))!;

    // Les deux côtés changent les mêmes cellules d'Acme : Filarr d'abord, D1 ensuite (D1 est donc la plus récente)
    await mock.appEdit(storeId, [
      { r: acme.id, f: 'p_nom', v: 'Acme SA' },
      { r: acme.id, f: 'p_ville', v: 'Lyon 2e' },
      { r: acme.id, f: 'p_statut', v: 'o_perdu' },
      { r: acme.id, f: 'p_note', v: 'Note écrite dans Filarr' },
    ]);
    await until(() => gate.replicator.bases.get(storeId)!.mirror.rowById(acme.id)?.cells.p_note === 'Note écrite dans Filarr', 5000, 'geste de l’appli');
    await new Promise((r) => setTimeout(r, 20));
    d1.exec("UPDATE clients SET nom = 'Acme Corp', ville = 'Villeurbanne', statut = 'Prospect', note = 'Note écrite dans D1' WHERE id = 1");

    const st = (await gate.sync!.runPass('xs_DemoClientsBoutique002'))!;
    expect(st).toMatchObject({ state: 'ok', code: 'extdb_conflicts_pending', queue: { n: 1 } });
    const after = (await mock.appRows(storeId)).find((r) => r.id === acme.id)!;
    // « la plus récente l'emporte » (nom) : D1, changée après Filarr
    expect(after.cells.p_nom).toBe('Acme Corp');
    // « la source l'emporte » (ville)
    expect(after.cells.p_ville).toBe('Villeurbanne');
    // « Filarr l'emporte » (note) : la valeur part vers D1
    expect(d1Row(1).note).toBe('Note écrite dans Filarr');
    // « me demander » (statut) : rien n'est écrit, chaque côté garde sa valeur
    expect(after.cells.p_statut).toBe('o_perdu');
    expect(d1Row(1).statut).toBe('Prospect');
    // Chaque valeur perdue est au journal
    const lost = st.journal.filter((j) => j.kind === 'conflict').map((j) => [j.col, j.old]);
    expect(lost).toEqual(expect.arrayContaining([['nom', 'Acme SA'], ['ville', 'Lyon 2e'], ['note', 'Note écrite dans D1']]));

    // Un membre lit la file publiée et tranche « prendre celle de la source » ; le dépôt déclenche un passage
    const { queue } = await mock.appReadStatus(storeId, runnerOf());
    expect(queue!.entries).toMatchObject([{ col: 'statut', kind: 'cell', source: { v: 'o_prospect' }, filarr: { v: 'o_perdu' } }]);
    await mock.appDecide(storeId, runnerOf(), 'xs_DemoClientsBoutique002', [{ id: queue!.entries[0]!.id, choice: 'source' }]);
    await until(async () => (await mock.appRows(storeId)).find((r) => r.id === acme.id)!.cells.p_statut === 'o_prospect', 5000, 'décision appliquée');
    await until(async () => (await mock.appReadStatus(storeId, runnerOf())).status?.queue.n === 0, 5000, 'file vide');

    // « Rétablir » la ville perdue : l'appli l'écrit comme une modification ordinaire, le passage la porte à D1
    await mock.appEdit(storeId, [{ r: acme.id, f: 'p_ville', v: 'Lyon 2e' }]);
    await until(() => gate.replicator.bases.get(storeId)!.mirror.rowById(acme.id)?.cells.p_ville === 'Lyon 2e', 5000, 'rétabli dans Filarr');
    expect((await filarrGate(stateDir, ['sources', 'run', 'xs_DemoClientsBoutique002'])).out).toContain('Passage : ok');
    expect(d1Row(1).ville).toBe('Lyon 2e');
  }, 60_000);

  it('garde-fou : des lignes disparues d’un coup arrêtent le passage ; `--ack-guard` le laisse passer, une fois', async () => {
    // Les disparitions ne se voient qu'à une lecture ENTIÈRE (sans repère : à chaque passage ;
    // avec repère : toutes les 24 h ou tous les 96 passages)
    const storeId = await setup();
    await mock.appSetExtSource(storeId, definition('sync-d1/definition.both.json', accessId, { guard: { pct: 20, min: 1 }, marker: null, conflict: 'source' }));
    const gate = await startGate(token, stateDir, sync());
    await until(() => gate.sync!.list().length === 1, 5000, 'définition');
    await filarrGate(stateDir, ['sources', 'key', 'xs_DemoClientsBoutique002', '--stdin'], d1.token);
    await filarrGate(stateDir, ['sources', 'run', 'xs_DemoClientsBoutique002']);
    d1.exec('DELETE FROM clients WHERE id IN (2, 3)');
    const stopped = await filarrGate(stateDir, ['sources', 'run', 'xs_DemoClientsBoutique002', '--json']);
    const st = JSON.parse(stopped.out) as { state: string; code: string; question: { pass: string; gone: number } };
    expect(st).toMatchObject({ state: 'question', code: 'extdb_guard', question: { gone: 2 } });
    // Rien n'a été marqué dans Filarr
    const marked = () => Object.values(gate.replicator.bases.get(storeId)!.mirror.allRegisters()).filter((r) => r['#x.extGone']?.v).length;
    expect(marked()).toBe(0);
    const agreed = await filarrGate(stateDir, ['sources', 'run', 'xs_DemoClientsBoutique002', '--ack-guard', st.question.pass]);
    expect(agreed.out).toContain('Passage : ok');
    await until(() => marked() === 2, 5000, 'lignes marquées « disparues »');
  }, 60_000);
});

// ==================== PostgreSQL ====================

describe('examples/sync-postgres : un PostgreSQL du réseau local, en miroir puis dans les deux sens', () => {
  let pg: TempPostgres | null = null;
  let port = 0;

  beforeAll(async () => {
    port = await freePort();
    pg = startPostgres(port);
  }, 120_000);
  afterAll(() => pg?.stop());

  it('le rôle limité de role.sql suffit ; miroir, puis deux sens avec « me demander », puis une ligne créée dans Filarr', async (t) => {
    if (!pg) return t.skip();
    const { Client } = (await import('pg')).default as unknown as { Client: new (c: Record<string, unknown>) => { connect(): Promise<void>; query(s: string, p?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>; end(): Promise<void> } };
    // L'administrateur : la base, la table et son déclencheur, le rôle de la boîte (le SQL des exemples)
    const root = new Client({ host: pg.host, port: pg.port, user: pg.user, password: pg.password, database: 'postgres' });
    await root.connect();
    await root.query('DROP DATABASE IF EXISTS atelier');
    await root.query('CREATE DATABASE atelier');
    await root.end();
    const admin = new Client({ host: pg.host, port: pg.port, user: pg.user, password: pg.password, database: 'atelier' });
    await admin.connect();
    await admin.query(example('sync-postgres/schema.sql'));
    const rolePassword = `essai-${Math.random().toString(36).slice(2)}`;
    await admin.query('DROP ROLE IF EXISTS filarr_gate').catch(() => undefined);
    await admin.query(example('sync-postgres/role.sql').replace('choose-a-long-password', rolePassword));

    mock = new MockFilarr({ writeSwitch: true });
    await mock.listen();
    const props: DbProperty[] = [
      { id: 'p_id', name: 'Id', type: 'number' },
      { id: 'p_numero', name: 'Numéro', type: 'text' },
      { id: 'p_client', name: 'Client', type: 'text' },
      { id: 'p_montant', name: 'Montant', type: 'number' },
      { id: 'p_statut', name: 'Statut', type: 'select', options: [] },
      { id: 'p_suivi', name: 'Suivi', type: 'text' },
    ];
    const storeId = await mock.createStore({ dbId: 'db-commandes-atelier', title: 'Commandes', properties: props, rows: [], views: VIEWS });
    const { token, accessId } = await mock.createAccess('Serveur de l’atelier', 'pro');
    await mock.grant(accessId, storeId, 'rw');
    const local = { host: '127.0.0.1', port: pg.port };
    const conn = (def: Record<string, unknown>) => ({ ...def, conn: { ...(def.conn as object), ...local }, host: `127.0.0.1:${pg!.port}` });
    await mock.appSetExtSource(storeId, conn(definition('sync-postgres/definition.mirror.json', accessId)), { managedBy: true });
    const stateDir = tempDir();
    const gate = await startGate(token, stateDir, { tcp: true, loadDriver: (n) => import(n) });
    await until(() => gate.sync!.list().length === 1, 5000, 'définition');

    // Miroir : la clé (le mot de passe du rôle), un passage
    await filarrGate(stateDir, ['sources', 'key', 'xs_DemoCommandesAtelier00', '--stdin'], rolePassword);
    const ran = await filarrGate(stateDir, ['sources', 'run', 'xs_DemoCommandesAtelier00']);
    expect(ran.out, ran.out).toContain('Passage : ok');
    const rows = await mock.appRows(storeId);
    expect(rows.map((r) => r.cells.p_numero).sort()).toEqual(['C-2026-1181', 'C-2026-1182']);
    expect(rows.find((r) => r.cells.p_numero === 'C-2026-1181')!.cells.p_montant).toBe(1240.5);

    // Deux sens (révision 2 de la même définition) : « me demander » sur tout
    await mock.appSetExtSource(storeId, conn(definition('sync-postgres/definition.both.json', accessId)), { managedBy: true });
    await until(() => gate.sync!.get('xs_DemoCommandesAtelier00')?.def.rev === 2, 5000, 'révision 2');
    const c1181 = rows.find((r) => r.cells.p_numero === 'C-2026-1181')!;
    const options = gate.replicator.bases.get(storeId)!.mirror.head!.schema.properties.find((p) => p.id === 'p_statut')!.options!;
    const optionId = (label: string) => options.find((o) => o.label === label)!.id;
    await mock.appEdit(storeId, [{ r: c1181.id, f: 'p_statut', v: optionId('Reçue') }]);
    await until(() => gate.replicator.bases.get(storeId)!.mirror.rowById(c1181.id)?.cells.p_statut === optionId('Reçue'), 5000, 'geste');
    await admin.query("UPDATE commandes SET statut = 'Livrée' WHERE numero = 'C-2026-1181'");
    const st = (await gate.sync!.runPass('xs_DemoCommandesAtelier00'))!;
    expect(st).toMatchObject({ code: 'extdb_conflicts_pending', queue: { n: 1 } });
    const { queue } = await mock.appReadStatus(storeId, `a:${accessId}`);
    await mock.appDecide(storeId, `a:${accessId}`, 'xs_DemoCommandesAtelier00', [{ id: queue!.entries[0]!.id, choice: 'filarr' }]);
    await until(async () => (await admin.query("SELECT statut FROM commandes WHERE numero = 'C-2026-1181'")).rows[0]!.statut === 'Reçue', 5000, 'décision appliquée dans PostgreSQL');

    // Une ligne créée dans Filarr part vers PostgreSQL ; l'identifiant tiré par PostgreSQL revient
    await mock.appEdit(storeId, [
      { r: 'db-neuve', f: 'p_numero', v: 'C-2026-1200' },
      { r: 'db-neuve', f: 'p_client', v: 'Initech' },
      { r: 'db-neuve', f: 'p_statut', v: optionId('Reçue') },
      { r: 'db-neuve', f: '#o', v: 'z9' },
      { r: 'db-neuve', f: '#c', v: new Date().toISOString() },
    ]);
    await until(() => gate.replicator.bases.get(storeId)!.mirror.rowById('db-neuve') !== undefined, 5000, 'ligne neuve vue');
    expect((await filarrGate(stateDir, ['sources', 'run', 'xs_DemoCommandesAtelier00'])).out).toContain('Passage : ok');
    const inserted = (await admin.query("SELECT id, client FROM commandes WHERE numero = 'C-2026-1200'")).rows[0]!;
    expect(inserted.client).toBe('Initech');
    await until(async () => (await mock.appRows(storeId)).find((r) => r.id === 'db-neuve')!.cells.p_id === Number(inserted.id), 5000, 'clé revenue');
    await admin.end();
  }, 120_000);
});
