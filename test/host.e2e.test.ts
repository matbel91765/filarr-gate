/**
 * LE SERVICE HÉBERGÉ SOUS WORKERD (wrangler dev, en local : rien ne part chez Cloudflare), le MODULE CONSTRUIT
 * tel que la chaîne le met en service (`scripts/host/build.mjs`, ici avec des clés de TEST épinglées), contre le
 * Filarr en mémoire : objets durables en juridiction UE, annuaire, réveil par l'adresse de contrôle, jeton scellé
 * ouvert, première clé d'application servie, annonce de version signée, effacement et reçu.
 *
 * La configuration est celle de `packages/host/wrangler.jsonc`, SANS sa route : sous wrangler dev, une route
 * réécrit l'hôte de chaque requête (`*.gate.example.test` → `gate.example.test`), et le service route par l'hôte.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toBase64Url } from '../packages/core/src/engine/store/crypto';
import { sha256Hex } from '../packages/gate/src/util/bytes';
import { HOST_VERSION } from '../packages/host/src/env';
import { verifyHostSignature, versionMessage } from '../packages/host/src/wire';
import { readJsonc } from '../scripts/host/config-guard.mjs';
import { CLIENTS_DB, demoStores } from './support/demoData';
import { TEST_DOMAIN, testHostKey } from './support/hostHarness';
import { MockFilarr } from './support/mockFilarr';
import { tempDir, until } from './support/util';

const repo = join(__dirname, '..');
const wrangler = join(repo, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const key = testHostKey('h-e2e', 11);
const FIRST_KEY = `gk_live_${toBase64Url(new Uint8Array(24).fill(9))}`;
const hostName = 'banc-e2e-4k2z';
const CODE_HASH = `sha256:${'cd'.repeat(32)}`;

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });

function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.pid === undefined) return resolve();
    child.once('exit', () => resolve());
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  });
}

let mock: MockFilarr;
let worker: ChildProcess | null = null;
let port = 0;

/** Une requête vers le service local, l'hôte dans l'en-tête Host (comme la route de la zone le donnerait). */
function hostFetch(host: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: { ...(init.headers ?? {}), Host: host } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, text }));
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error('délai')));
    if (init.body) req.write(init.body);
    req.end();
  });
}

beforeAll(async () => {
  mock = new MockFilarr({ writeSwitch: true });
  await mock.listen();
  mock.hostKeys = [key.pinned];
  // Les réveils de l'API vers l'adresse de contrôle : ici, le service local, l'hôte en en-tête
  mock.hostControlUrl = `http://ctl.${TEST_DOMAIN}`;
  mock.hostWakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const res = await hostFetch(url.host, url.pathname, { method: init?.method ?? 'POST', headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body ?? '') });
    return new Response(res.text, { status: res.status });
  }) as typeof fetch;

  const dir = tempDir('filarr-gate-host-e2e-');
  writeFileSync(join(dir, 'keys.json'), JSON.stringify([key.pinned]));
  execFileSync(process.execPath, [join(repo, 'scripts', 'host', 'build.mjs'), '--outfile', join(dir, 'filarr-gate-host.js'), '--keys', join(dir, 'keys.json')], { cwd: repo, stdio: 'ignore' });
  const config = readJsonc(readFileSync(join(repo, 'packages', 'host', 'wrangler.jsonc'), 'utf8'));
  delete config.routes;
  delete config.$schema;
  config.main = 'filarr-gate-host.js';
  writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify(config, null, 2));
  writeFileSync(join(dir, '.dev.vars'), `HOST_ENC='${key.env.HOST_ENC}'\nHOST_SIG='${key.env.HOST_SIG}'\n`);
  [port] = [await freePort()];
  const inspector = await freePort();
  worker = spawn(
    process.execPath,
    [
      wrangler,
      'dev',
      '--config',
      join(dir, 'wrangler.jsonc'),
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      String(inspector),
      // Hors du dossier de la configuration : wrangler le surveille, et rechargerait à chaque écriture
      '--persist-to',
      tempDir('filarr-gate-host-e2e-etat-'),
      '--show-interactive-dev-session=false',
      '--var',
      `FILARR_API_URL:${mock.url}`,
      '--var',
      `GATE_HOST_DOMAIN:${TEST_DOMAIN}`,
      '--var',
      `HOST_CODE_HASH:${CODE_HASH}`,
      '--var',
      'HOST_BUILD_REF:v0.0.0-banc',
      '--var',
      'HOST_DEPLOYED_AT:2026-10-11T00:00:00.000Z',
      // workerd n'implémente pas les juridictions : le banc le dit explicitement (euNamespace, garde de test)
      '--var',
      'GATE_HOST_LOCAL_BENCH:workerd-sans-juridiction',
    ],
    { cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: 'ignore' }
  );
  await until(async () => (await hostFetch(`ctl.${TEST_DOMAIN}`, '/health').catch(() => null))?.status === 200, 120_000, 'wrangler dev prêt');
}, 180_000);

afterAll(async () => {
  if (worker) await killTree(worker);
  await mock?.close();
});

describe('service hébergé sous workerd (module construit, wrangler dev local)', () => {
  let accessId = '';

  it('annonce de version signée sur l’adresse de contrôle ; nom inconnu : 404', async () => {
    const res = await hostFetch(`ctl.${TEST_DOMAIN}`, '/.well-known/filarr-gate-host.json');
    expect(res.status).toBe(200);
    const { sig, ...rest } = JSON.parse(res.text) as Record<string, unknown>;
    expect(rest).toEqual({ version: HOST_VERSION, codeHash: CODE_HASH, buildRef: 'v0.0.0-banc', deployedAt: '2026-10-11T00:00:00.000Z', keyId: 'h-e2e' });
    expect(verifyHostSignature(versionMessage(rest), sig as string, Buffer.from(key.pinned.signPublicKey, 'base64'))).toBe(true);
    expect((await hostFetch(`${hostName}.${TEST_DOMAIN}`, '/health')).status).toBe(404);
  });

  it('création, réveil, jeton scellé ouvert dans l’objet durable : la première clé sert l’API', async () => {
    const clients = await mock.createStore(demoStores.find((s) => s.dbId === CLIENTS_DB)!);
    const created = await mock.createHostedAccess('Banc e2e', {
      hostName,
      key: key.pinned,
      settings: (id) => ({ v: 1, kind: 'filarr-gate/settings', accessId: id, appKeys: [{ id: 'k1', name: 'Première clé', hash: sha256Hex(FIRST_KEY), scopes: [{ target: 'all', read: true }] }] }),
    });
    accessId = created.accessId;
    await mock.grant(accessId, clients, 'r'); // le réveil `grant` arrive par l'adresse de contrôle
    await until(async () => {
      const h = await hostFetch(`${hostName}.${TEST_DOMAIN}`, '/health');
      return h.status === 200 && (JSON.parse(h.text) as { status: string }).status === 'ok';
    }, 45_000, 'boîte prête');
    const rows = await hostFetch(`${hostName}.${TEST_DOMAIN}`, '/v1/clients?limit=10', { headers: { Authorization: `Bearer ${FIRST_KEY}` } });
    expect(rows.status, rows.text).toBe(200);
    expect(rows.text).toContain('Acme');
    expect(mock.hostChecks.length).toBeGreaterThan(0);
    expect(mock.hostChecks.every((c) => c.ok)).toBe(true);
  }, 60_000);

  it('révocation : effacement, reçu signé remis à l’API, l’adresse ne répond plus', async () => {
    mock.hostingErase(accessId);
    await until(() => mock.hostedReceipts.some((r) => r.accessId === accessId && !r.partial), 30_000, 'reçu');
    const r = mock.hostedReceipts.find((x) => x.accessId === accessId)!;
    expect(r.receipt).toMatchObject({ reason: 'revoked', hostName, keyId: 'h-e2e', codeHash: CODE_HASH, version: HOST_VERSION });
    await until(async () => (await hostFetch(`${hostName}.${TEST_DOMAIN}`, '/health')).status === 404, 90_000, 'adresse éteinte');
  }, 130_000);
});
