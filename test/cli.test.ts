/**
 * La ligne de commande, construite (`packages/cli/dist/cli.js`) et lancée comme un
 * administrateur la lance, contre le Filarr en mémoire : init, clés, fichiers,
 * diagnostic, migration hors ligne (export → init --import), et les mêmes gestes
 * sur une boîte EN MARCHE par `--remote`.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENTS_DB, demoStores } from './support/demoData';
import { MockFilarr } from './support/mockFilarr';
import { tempDir, until } from './support/util';

const repo = join(__dirname, '..');
const cli = join(repo, 'packages', 'cli', 'dist', 'cli.js');
const PASSWORD = 'mot-de-passe-de-banc';

let mock: MockFilarr;
let clients = '';

beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: join(repo, 'packages', 'cli'), stdio: 'ignore' });
  mock = new MockFilarr({ writeSwitch: true });
  await mock.listen();
  clients = await mock.createStore(demoStores.find((s) => s.dbId === CLIENTS_DB)!);
}, 60_000);

afterAll(async () => {
  await mock?.close();
});

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });

interface Run {
  code: number | null;
  out: string;
  err: string;
  json: any;
}

function gate(stateDir: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repo,
      env: { ...process.env, FILARR_GATE_STATE_DIR: stateDir, FILARR_GATE_CACHE: 'memory', FILARR_GATE_LOG_LEVEL: 'warn', FILARR_GATE_TOKEN: '', FILARR_GATE_ADMIN_PASSWORD: '', ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('exit', (code) => {
      let json: unknown = null;
      try {
        json = JSON.parse(out);
      } catch {
        /* sortie texte */
      }
      resolve({ code, out, err, json });
    });
  });
}

async function access(name: string) {
  const { token, accessId } = await mock.createAccess(name, 'pro');
  await mock.grant(accessId, clients, 'rw');
  mock.linkFiles(accessId);
  return { token, accessId };
}

describe('filarr-gate (ligne de commande)', () => {
  it('init, clés, fichier d’essai, diagnostic, puis migration hors ligne vers un nouveau jeton', async () => {
    const { token, accessId } = await access('ERP Atelier');
    const dir = tempDir();
    const [port, adminPort] = [await freePort(), await freePort()];

    const init = await gate(dir, ['init', '--token', token, '--port', String(port), '--admin-port', String(adminPort), '--api-url', mock.url, '--admin-password', PASSWORD, '--json']);
    expect(init.code, init.err).toBe(0);
    expect(init.json).toMatchObject({ stateDir: dir, api: `127.0.0.1:${port}`, admin: `http://127.0.0.1:${adminPort}/admin/` });
    // Le jeton est rangé à part, lisible du seul propriétaire (sous Windows, les droits POSIX ne disent rien)
    const tokenFile = join(dir, 'token');
    expect(readFileSync(tokenFile, 'utf8').trim()).toBe(token);
    if (process.platform !== 'win32') expect(statSync(tokenFile).mode & 0o077).toBe(0);

    const bad = await gate(dir, ['init', '--token', 'pas-un-jeton']);
    expect(bad.code).toBe(2);

    const created = await gate(dir, ['keys', 'create', '--name', 'erp', '--files', '--json']);
    expect(created.code, created.err).toBe(0);
    expect(created.json.key).toMatch(/^gk_/);
    const list = await gate(dir, ['keys', 'list', '--json']);
    expect(list.json).toEqual([expect.objectContaining({ id: created.json.id, name: 'erp', paused: false })]);

    const deposit = await gate(dir, ['files', 'test', '--json']);
    expect(deposit.code, deposit.err).toBe(0);
    expect(deposit.json).toMatchObject({ status: 'deposited' });
    expect([...mock.deposits.values()].filter((d) => d.accessId === accessId)).toHaveLength(1);
    const status = await gate(dir, ['files', 'status', deposit.json.id, '--json']);
    expect(status.json).toMatchObject({ id: deposit.json.id, status: 'deposited' });

    const doctor = await gate(dir, ['doctor', '--json']);
    expect(doctor.code, JSON.stringify(doctor.json)).toBe(0);
    const checks = Object.fromEntries((doctor.json.checks as Array<{ name: string; result: string }>).map((c) => [c.name, c.result]));
    expect(checks).toMatchObject({ filarr: 'ok', horloge: 'ok', créateur: 'ok', fichiers: 'ok', 'base clients': 'ok' });

    const sources = await gate(dir, ['sources', 'list', '--json']);
    expect(sources.json).toEqual([]);

    // Migration : Filarr prépare le jeton de la nouvelle boîte, l'ancienne scelle ses réglages pour lui
    const newToken = await mock.migrateStart(accessId);
    const pkgFile = join(tempDir(), 'reglages.json');
    const exported = await gate(dir, ['export', '--for-token', newToken, '--out', pkgFile, '--json']);
    expect(exported.code, exported.err).toBe(0);
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    expect(pkg).toMatchObject({ v: 1, kind: 'filarr-gate/settings-sealed', accessId });
    // Rien en clair : ni le nom de la clé, ni son empreinte
    expect(readFileSync(pkgFile, 'utf8')).not.toContain('erp');
    const same = await gate(dir, ['export', '--for-token', token, '--out', pkgFile]);
    expect(same.code).toBe(1);

    const dir2 = tempDir();
    const init2 = await gate(dir2, ['init', '--token', newToken, '--api-url', mock.url, '--import', pkgFile, '--json']);
    expect(init2.code, init2.err).toBe(0);
    expect(init2.json.imported).toMatchObject({ keys: 1 });
    const list2 = await gate(dir2, ['keys', 'list', '--json']);
    // La clé garde son identifiant : le logiciel garde sa clé gk_… en changeant de boîte
    expect(list2.json).toEqual([expect.objectContaining({ id: created.json.id, name: 'erp' })]);

    const revoked = await gate(dir, ['keys', 'revoke', created.json.id, '--json']);
    expect(revoked.json).toEqual({ revoked: created.json.id });
    expect((await gate(dir, ['keys', 'list', '--json'])).json).toEqual([]);
  }, 90_000);

  it('--remote : les mêmes gestes sur une boîte en marche, qui les voit tout de suite', async () => {
    const { token } = await access('Comptabilité');
    const dir = tempDir();
    const [port, adminPort] = [await freePort(), await freePort()];
    await gate(dir, ['init', '--token', token, '--port', String(port), '--admin-port', String(adminPort), '--api-url', mock.url, '--admin-password', PASSWORD]);
    let server: ChildProcess | null = null;
    try {
      server = spawn(process.execPath, [cli, 'serve'], { cwd: repo, env: { ...process.env, FILARR_GATE_STATE_DIR: dir, FILARR_GATE_CACHE: 'memory', FILARR_GATE_LOG_LEVEL: 'warn', FILARR_GATE_TOKEN: '' }, stdio: 'ignore' });
      await until(async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.status === 200, 20_000, 'boîte en marche');
      expect((await gate(dir, ['health'])).code).toBe(0);

      const remote = ['--remote', `http://127.0.0.1:${adminPort}`, '--admin-password', PASSWORD, '--json'];
      const created = await gate(dir, ['keys', 'create', '--name', 'compta', ...remote]);
      expect(created.code, created.err + created.out).toBe(0);
      // Servie sans redémarrer
      const rows = await fetch(`http://127.0.0.1:${port}/v1/clients`, { headers: { Authorization: `Bearer ${created.json.key}` } });
      expect(rows.status).toBe(200);

      expect((await gate(dir, ['keys', 'list', ...remote])).json).toEqual([expect.objectContaining({ name: 'compta' })]);
      expect((await gate(dir, ['sources', 'list', ...remote])).json).toEqual([]);
      const deposit = await gate(dir, ['files', 'test', ...remote]);
      expect(deposit.json).toMatchObject({ status: 'deposited' });

      const wrong = await gate(dir, ['keys', 'list', '--remote', `http://127.0.0.1:${adminPort}`, '--admin-password', 'pas-le-bon-mot', '--json']);
      expect(wrong.code).toBe(1);
      expect(wrong.json.error).toContain('connexion refusée');

      const revoked = await gate(dir, ['keys', 'revoke', created.json.id, ...remote]);
      expect(revoked.code).toBe(0);
      expect((await fetch(`http://127.0.0.1:${port}/v1/clients`, { headers: { Authorization: `Bearer ${created.json.key}` } })).status).toBe(401);
    } finally {
      server?.kill('SIGTERM');
    }
  }, 90_000);
});
