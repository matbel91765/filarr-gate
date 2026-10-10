/**
 * DE BOUT EN BOUT contre le VRAI worker de Filarr, lancé en local par le banc de filarg :
 *
 *   sh <filarg>/scripts/banc/worker-local.sh C:/tmp/banc-gate/worker --port 8805 \
 *     --origine http://localhost:3065 --var DB_STORE_SWITCH=true --var DB_STORE_QUIET_DAYS=0 \
 *     --var API_BASE_SWITCH=true --var API_BASE_WRITE=true --var GATE_FILES_SWITCH=true
 *   node <filarg>/scripts/banc/compte-fictif.mjs C:/tmp/banc-gate/worker gate-e2e-1@example.test
 *   sh <filarg>/scripts/banc/d1-locale.sh C:/tmp/banc-gate/worker \
 *     "UPDATE users SET subscription_tier = 'pro' WHERE email = 'gate-e2e-1@example.test'"
 *   FILARR_E2E_WORKER=http://127.0.0.1:8805 \
 *   FILARR_E2E_ACCOUNT=C:/tmp/banc-gate/worker/comptes/gate-e2e-1@example.test.txt \
 *     npx vitest run test/worker.e2e.test.ts
 *
 * Facultatif : `FILARR_E2E_D1=<filarg>/scripts/banc/d1-locale.sh FILARR_E2E_WORKER_DIR=C:/tmp/banc-gate/worker`
 * (la boîte de dépôt des fichiers, et les plafonds horaires remis à zéro sur la D1 LOCALE), `FILARR_E2E_CF_PORT=<port>`
 * (la variante Cloudflare sous wrangler dev, sur ce port et le suivant), PostgreSQL installé (port 3070).
 * Sans `FILARR_E2E_WORKER` et `FILARR_E2E_ACCOUNT`, les essais sont sautés (`npm test` ne demande aucun banc).
 * L'application est jouée par `test/e2e/realFilarr.ts` (réplique de l'appli recopiée de
 * filarg) : la base au magasin, l'accès (révision 3), les gestes, la révocation.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDeposit } from '../packages/core/src/engine/gate/files';
import { curves, storeCrypto } from '../packages/gate/src/crypto/providers';
import { Gate } from '../packages/cli/src/gate';
import { openGate, type Gate as LibraryGate } from '../packages/gate/src/index';
import { setLogLevel } from '../packages/server/src/log';
import { RealFilarr } from './e2e/realFilarr';
import { CLIENTS_DB, demoStores } from './support/demoData';
import { startPostgres } from './support/postgres';
import { tempDir, until } from './support/util';

const WORKER = process.env.FILARR_E2E_WORKER ?? '';
const ACCOUNT = process.env.FILARR_E2E_ACCOUNT ?? '';
const on = WORKER !== '' && ACCOUNT !== '';
// Facultatif : la D1 locale du banc (dépôts de fichiers), et des ports privés pour la variante Cloudflare
const D1 = process.env.FILARR_E2E_D1 ?? '';
const WORKER_DIR = process.env.FILARR_E2E_WORKER_DIR ?? '';
const CF_PORT = Number(process.env.FILARR_E2E_CF_PORT ?? 0);

function d1(query: string): Array<Record<string, unknown>> {
  const out = execFileSync('sh', [D1, WORKER_DIR, query], { encoding: 'utf8' });
  return (JSON.parse(out.slice(out.indexOf('['))) as Array<{ results: Array<Record<string, unknown>> }>)[0]!.results;
}

setLogLevel('warn');

describe.skipIf(!on)('de bout en bout contre le worker local de Filarr', () => {
  let filarr: RealFilarr;
  let clients = '';
  let token = '';
  let accessId = '';
  const gates: Gate[] = [];
  let lib: LibraryGate | null = null;

  beforeAll(async () => {
    // Banc relancé : les plafonds horaires (connexion, magasins, accès) repartent de zéro, sur la D1 LOCALE seulement
    if (D1 && WORKER_DIR) d1("DELETE FROM rate_limits WHERE key LIKE 'login%' OR key LIKE 'dbstore-create:%' OR key LIKE 'api-access-create:%'");
    filarr = new RealFilarr(WORKER, D1 && WORKER_DIR ? d1 : null);
    await filarr.login(ACCOUNT);
    await filarr.registerKeys();
    await filarr.enableDbStore();
    clients = await filarr.createStore(demoStores.find((s) => s.dbId === CLIENTS_DB)!);
    ({ token, accessId } = await filarr.createAccess('Banc Filarr Gate', clients, 'rw'));
  }, 120_000);

  afterAll(async () => {
    await lib?.close();
    for (const g of gates) await g.stop().catch(() => undefined);
  });

  it('la bibliothèque : lignes, vue, SQL ; clé du créateur authentifiée', async () => {
    lib = await openGate({ token, apiUrl: WORKER });
    const status = lib.status();
    expect(status.creator).toBe('authenticated');
    expect(status.bases).toEqual([expect.objectContaining({ slug: 'clients', status: 'ready' })]);
    const rows = await lib.base('clients').rows();
    expect(rows.map((r) => r.nom).sort()).toEqual(['Acme', 'Globex', 'Initech', 'Umbrella']);
    const sql = await lib.sql("SELECT ville FROM clients WHERE nom = 'Acme'");
    expect(sql.rows).toEqual([['Lyon']]);
  }, 60_000);

  it('le serveur : flux en direct, un geste dans l’appli arrive ; écriture vers Filarr', async () => {
    const gate = new Gate({
      env: { FILARR_GATE_STATE_DIR: tempDir(), FILARR_GATE_API_URL: WORKER, FILARR_GATE_TOKEN: token, FILARR_GATE_PORT: '0', FILARR_GATE_ADMIN_PORT: '0', FILARR_GATE_CACHE: 'memory', FILARR_GATE_WRITE: 'true' },
    });
    gates.push(gate);
    await gate.start();
    await until(() => gate.replicator.link === 'live', 20_000, 'flux en direct');
    expect(gate.replicator.creator.status).toBe('authenticated');

    await filarr.appEdit(clients, [{ r: 'r_globex', f: 'p_ville', v: 'Brest' }]);
    await until(() => gate.replicator.bySlug('clients')?.mirror.rowById('r_globex')?.cells.p_ville === 'Brest', 20_000, 'geste reçu par le flux');

    const key = gate.keys.create({ name: 'erp', scopes: [{ target: 'base', storeId: clients, read: true, create: true, update: true, delete: false }] }).key;
    const res = await fetch(`http://127.0.0.1:${gate.apiPort}/v1/clients`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ nom: 'Hooli', ville: 'Rennes' }) });
    expect(res.status, await res.clone().text()).toBe(201);
    await until(async () => (await filarr.appRows(clients)).some((r) => r.cells.p_nom === 'Hooli'), 20_000, 'écriture lue par l’appli');
  }, 90_000);

  it('révocation : la boîte s’arrête et oublie', async () => {
    const gate = gates[0]!;
    await filarr.revoke(accessId);
    await until(() => gate.replicator.link === 'revoked', 20_000, 'révoquée');
    expect(gate.replicator.bases.size).toBe(0);
  }, 60_000);
  it('une synchro externe exécutée par la boîte : PostgreSQL → base, bail et état publiés sur le worker', async (t) => {
    const pg = startPostgres(3070);
    if (!pg) return t.skip();
    try {
      const { Client } = (await import('pg')).default;
      const admin = new Client({ host: pg.host, port: pg.port, user: pg.user, password: pg.password, database: pg.db });
      await admin.connect();
      await admin.query("CREATE TABLE fournisseurs (id integer PRIMARY KEY, nom text, ville text); INSERT INTO fournisseurs VALUES (1, 'Acier du Nord', 'Lille'), (2, 'Bois et Fils', 'Épinal')");
      await admin.end();

      const store = await filarr.createStore({
        dbId: 'db-fournisseurs-e2e',
        title: 'Fournisseurs',
        properties: [
          { id: 'p_id', name: 'Id', type: 'number' },
          { id: 'p_nom', name: 'Nom', type: 'text' },
          { id: 'p_ville', name: 'Ville', type: 'text' },
        ],
        rows: [],
      });
      const access = await filarr.createAccess('Synchro PostgreSQL', store, 'rw');
      const def = await filarr.appSetExtSource(store, {
        v: 1,
        id: 'xs_E2EE2EE2EE2EE2EE2EE2EE',
        rev: 1,
        name: 'Fournisseurs de l’ERP',
        connector: 'postgres',
        conn: { host: pg.host, port: pg.port, db: pg.db, user: pg.user, tls: 'off-local' },
        host: `${pg.host}:${pg.port}`,
        from: { table: 'fournisseurs' },
        key: { cols: ['id'], gen: 'source' },
        marker: null,
        mode: 'mirror',
        map: [
          { col: 'id', prop: 'p_id', dir: 'in', type: 'number' },
          { col: 'nom', prop: 'p_nom', dir: 'in', type: 'text' },
          { col: 'ville', prop: 'p_ville', dir: 'in', type: 'text' },
        ],
        onGone: 'mark',
        guard: { pct: 50, min: 5 },
        runner: { kind: 'gate', accessId: access.accessId, name: 'Banc' },
        schedule: { every: 'manual' },
      } as never);

      const gate = new Gate({
        env: { FILARR_GATE_STATE_DIR: tempDir(), FILARR_GATE_API_URL: WORKER, FILARR_GATE_TOKEN: access.token, FILARR_GATE_PORT: '0', FILARR_GATE_ADMIN_PORT: '0', FILARR_GATE_CACHE: 'memory' },
        sync: { timers: false },
      });
      gates.push(gate);
      await gate.start();
      await gate.sync!.scan();
      const info = gate.sync!.get(def.id)!;
      expect(info.blocked).toBe('extdb_key_missing');
      await gate.sync!.setKey(def.id, pg.password);
      const status = await gate.sync!.runPass(def.id);
      expect(status, JSON.stringify(status)).toMatchObject({ state: 'ok' });
      // Les lignes, lues par l'appli dans le magasin
      await until(async () => (await filarr.appRows(store)).filter((r) => !r.cells['#x.extGone']).map((r) => r.cells.p_nom).sort().join(',') === 'Acier du Nord,Bois et Fils', 20_000, 'lignes importées');
      // L'état publié sur le worker, ouvert par un membre sous K_xs
      const published = await filarr.appReadStatus(store, `a:${access.accessId}`);
      expect(published).toMatchObject({ state: 'ok' });
      // La colonne venue de la source est verrouillée pour l'API locale (field_managed)
      const key = gate.keys.create({ name: 'erp', scopes: [{ target: 'base', storeId: store, read: true, create: true, update: true, delete: false }] }).key;
      const rows = (await (await fetch(`http://127.0.0.1:${gate.apiPort}/v1/fournisseurs`, { headers: { Authorization: `Bearer ${key}` } })).json()) as { rows: Array<{ id: string }> };
      expect(rows.rows).toHaveLength(2);
    } finally {
      pg.stop();
    }
  }, 120_000);
  it.skipIf(!D1 || !WORKER_DIR)('la fente à fichiers : boîte de dépôt signée, dépôt scellé reçu par le worker, que la boîte de l’appli ouvre', async () => {
    const box = filarr.createDepositBox();
    const access = await filarr.createAccess('Fichiers du banc', clients, 'r', { files: box });
    const gate = new Gate({
      env: { FILARR_GATE_STATE_DIR: tempDir(), FILARR_GATE_API_URL: WORKER, FILARR_GATE_TOKEN: access.token, FILARR_GATE_PORT: '0', FILARR_GATE_ADMIN_PORT: '0', FILARR_GATE_CACHE: 'memory' },
    });
    gates.push(gate);
    await gate.start();
    expect(gate.replicator.files?.signed).toBe(true);
    const key = gate.keys.create({ name: 'erp', scopes: [{ target: 'files', deposit: true }] }).key;
    const form = new FormData();
    form.append('file', new Blob([new TextEncoder().encode('%PDF-1.7 facture du banc') as BlobPart], { type: 'application/pdf' }), 'facture-banc.pdf');
    form.append('path', 'Factures/2026');
    const res = await fetch(`http://127.0.0.1:${gate.apiPort}/v1/files`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
    const out = (await res.json()) as { id: string; status: string };
    expect(res.status, JSON.stringify(out)).toBe(202);
    expect(out.status).toBe('deposited');
    // Refusé AVANT tout envoi : un exécutable ne part pas
    const exe = new FormData();
    exe.append('file', new Blob([new Uint8Array([0x4d, 0x5a, 0x90, 0]) as BlobPart]), 'outil.pdf');
    expect((await fetch(`http://127.0.0.1:${gate.apiPort}/v1/files`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: exe })).status).toBe(415);
    // Ce que le worker garde : le canal, l'accès, et des scellés que seule la boîte de l'appli ouvre
    const depositId = gate.files.get(out.id)!.depositId!;
    const row = filarr.deposit(depositId)!;
    expect(row).toMatchObject({ channel: 'gate', access_id: access.accessId, total_chunks: 1 });
    expect(String(row.encrypted_manifest)).not.toContain('facture');
    const opened = await openDeposit(storeCrypto, curves, box.privateKey, { sealedFileKey: String(row.sealed_file_key), encryptedManifest: String(row.encrypted_manifest), encryptedManifestIv: String(row.encrypted_manifest_iv) }, []);
    expect(opened.manifest).toMatchObject({ fileName: 'facture-banc.pdf', channel: 'gate', path: 'Factures/2026', source: 'erp' });
  }, 90_000);

  it.skipIf(!CF_PORT)('la variante Cloudflare (wrangler dev, local) contre le même worker', async () => {
    const access = await filarr.createAccess('Cloudflare du banc', clients, 'r');
    const repo = join(__dirname, '..');
    const child: ChildProcess = spawn(
      process.execPath,
      [join(repo, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'dev', '--local', '--ip', '127.0.0.1', '--port', String(CF_PORT), '--inspector-port', String(CF_PORT + 1), '--persist-to', tempDir('filarr-gate-cf-e2e-'), '--show-interactive-dev-session=false', '--var', `FILARR_GATE_API_URL:${WORKER}`, '--var', `FILARR_GATE_TOKEN:${access.token}`, '--var', 'FILARR_GATE_ADMIN_PASSWORD:mot-de-passe-de-banc'],
      { cwd: repo, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: 'ignore' }
    );
    try {
      const base = `http://127.0.0.1:${CF_PORT}`;
      await until(async () => {
        const h = (await (await fetch(`${base}/health`).catch(() => null))?.json().catch(() => null)) as { bases?: Array<{ status: string }> } | null;
        return h?.bases?.[0]?.status === 'ready';
      }, 90_000, 'variante Cloudflare prête');
      const login = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gate-Admin': '1' }, body: JSON.stringify({ password: 'mot-de-passe-de-banc' }) });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
      const doctor = (await (await fetch(`${base}/admin/api/doctor`, { headers: { Cookie: cookie } })).json()) as { checks: Array<{ name: string; result: string }> };
      expect(doctor.checks.find((c) => c.name === 'créateur')?.result).toBe('ok');
      const created = await fetch(`${base}/admin/api/keys`, { method: 'POST', headers: { Cookie: cookie, 'X-Gate-Admin': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'erp', scopes: [{ target: 'all' }] }) });
      const key = ((await created.json()) as { key: string }).key;
      const rows = (await (await fetch(`${base}/v1/clients?limit=50`, { headers: { Authorization: `Bearer ${key}` } })).json()) as { rows: Array<{ nom: string }> };
      expect(rows.rows.map((r) => r.nom)).toContain('Acme');
    } finally {
      if (child.pid !== undefined) {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGTERM');
      }
    }
  }, 180_000);
});
