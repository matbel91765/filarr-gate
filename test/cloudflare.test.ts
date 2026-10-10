/**
 * La variante Cloudflare, lancée par `wrangler dev` (workerd, en local : rien ne
 * part chez Cloudflare) contre le Filarr en mémoire : première copie, clés par
 * l'interface de gestion, lignes, écriture, réveil poussé signé, interface servie
 * par la liaison ASSETS, et l'état qui survit au redémarrage de l'objet durable.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENTS_DB, demoStores } from './support/demoData';
import { MockFilarr } from './support/mockFilarr';
import { tempDir, until } from './support/util';

const repo = join(__dirname, '..');
const wrangler = join(repo, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const PASSWORD = 'mot-de-passe-de-banc';

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });

/** Arrête `wrangler dev` ET son workerd (sous Windows, un kill n'emporte pas les enfants). */
function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.pid === undefined) return resolve();
    child.once('exit', () => resolve());
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  });
}

let mock: MockFilarr;
let clients = '';
let port = 0;
let inspector = 0;
let token = '';
const persist = tempDir('filarr-gate-cf-');
let worker: ChildProcess | null = null;
const base = () => `http://127.0.0.1:${port}`;

async function startWorker(): Promise<void> {
  worker = spawn(
    process.execPath,
    [
      wrangler,
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      String(inspector),
      '--persist-to',
      persist,
      '--show-interactive-dev-session=false',
      '--var',
      `FILARR_GATE_API_URL:${mock.url}`,
      '--var',
      `FILARR_GATE_TOKEN:${token}`,
      '--var',
      `FILARR_GATE_ADMIN_PASSWORD:${PASSWORD}`,
      '--var',
      'FILARR_GATE_WRITE:true',
      '--var',
      'FILARR_GATE_LOG_LEVEL:warn',
    ],
    { cwd: repo, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: 'ignore' }
  );
  await until(async () => (await fetch(`${base()}/health`).catch(() => null))?.status === 200, 90_000, 'wrangler dev prêt');
}

beforeAll(async () => {
  if (!existsSync(join(repo, 'packages', 'cli', 'dist', 'ui', 'index.html'))) {
    execFileSync(process.execPath, [join(repo, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'packages/cli/ui/vite.config.ts', '--logLevel', 'error'], { cwd: repo, stdio: 'ignore' });
  }
  mock = new MockFilarr({ writeSwitch: true });
  await mock.listen();
  clients = await mock.createStore(demoStores.find((s) => s.dbId === CLIENTS_DB)!);
  [port, inspector] = [await freePort(), await freePort()];
  const access = await mock.createAccess('Atelier sur Cloudflare', 'pro', { notifyUrl: `http://127.0.0.1:${port}/_filarr/notify` });
  token = access.token;
  await mock.grant(access.accessId, clients, 'rw');
  await startWorker();
}, 180_000);

afterAll(async () => {
  if (worker) await killTree(worker);
  await mock?.close();
});

async function login(): Promise<string> {
  const res = await fetch(`${base()}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gate-Admin': '1' }, body: JSON.stringify({ password: PASSWORD }) });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

describe('variante Cloudflare (wrangler dev, local)', () => {
  let key = '';

  it('première copie, clé par l’interface, lignes, interface servie', async () => {
    await until(async () => {
      const h = (await (await fetch(`${base()}/health`)).json()) as { status: string; bases: Array<{ status: string }> };
      return h.status === 'ok' && h.bases.length === 1 && h.bases[0]!.status === 'ready';
    }, 30_000, 'copie prête');
    const cookie = await login();
    const created = await fetch(`${base()}/admin/api/keys`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-Gate-Admin': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'erp', scopes: [{ target: 'all' }, { target: 'base', storeId: clients, read: true, create: true, update: true, delete: false }] }),
    });
    expect(created.status).toBe(201);
    key = ((await created.json()) as { key: string }).key;
    const rows = (await (await fetch(`${base()}/v1/clients?limit=10`, { headers: { Authorization: `Bearer ${key}` } })).json()) as { rows: Array<{ nom: string }> };
    expect(rows.rows.map((r) => r.nom)).toContain('Acme');
    const ui = await fetch(`${base()}/admin/`);
    expect(ui.status).toBe(200);
    expect(ui.headers.get('content-type')).toContain('text/html');
    const doctor = (await (await fetch(`${base()}/admin/api/doctor`, { headers: { Cookie: cookie } })).json()) as { ok: boolean };
    expect(doctor.ok).toBe(true);
  }, 60_000);

  it('un geste dans l’appli réveille l’objet (réveil poussé signé) ; une écriture part vers Filarr', async () => {
    await mock.appEdit(clients, [{ r: 'r_globex', f: 'p_ville', v: 'Brest' }]);
    await until(async () => {
      const row = (await (await fetch(`${base()}/v1/clients/rows/r_globex`, { headers: { Authorization: `Bearer ${key}` } })).json()) as { row?: { ville?: string } };
      return row.row?.ville === 'Brest';
    }, 20_000, 'réveil appliqué');
    expect(mock.notifications.some((n) => n.status === 202 && JSON.parse(n.body).t === 'commit')).toBe(true);
    // Un réveil mal signé est refusé
    const forged = await fetch(`${base()}/_filarr/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Filarr-Notify': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` }, body: '{"t":"commit"}' });
    expect(forged.status).toBe(401);

    const res = await fetch(`${base()}/v1/clients`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ nom: 'Hooli', ville: 'Rennes' }) });
    expect(res.status, await res.clone().text()).toBe(201);
    await until(async () => (await mock.appRows(clients)).some((r) => JSON.stringify(r).includes('Hooli')), 20_000, 'écriture reçue par Filarr');
  }, 60_000);

  it('l’état survit au redémarrage : la clé sert encore, la copie revient du cache', async () => {
    await killTree(worker!);
    await startWorker();
    await until(async () => {
      const res = await fetch(`${base()}/v1/clients?limit=1`, { headers: { Authorization: `Bearer ${key}` } });
      return res.status === 200;
    }, 30_000, 'clé encore valable');
  }, 150_000);
});
