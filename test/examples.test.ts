/**
 * Les exemples de la documentation TOURNENT : chacun est lancé tel quel (node, python, bash avec
 * curl) contre une boîte noire qui réplique le Filarr en mémoire, et sa sortie est vérifiée. La
 * documentation recopie ses blocs de code depuis examples/ (`npm run docs:check`) : ce qu'un
 * lecteur copie est ce qui a tourné ici.
 *
 * Sans Python ou sans bash, leurs exemples sont sautés, et le saut le dit.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Gate } from '../packages/cli/src/gate';
import { setLogLevel } from '../packages/server/src/log';
import { CATALOGUE_DB, CLIENTS_DB, COMMANDES_DB, demoStores } from './support/demoData';
import { bash, freePort, proxyWithOne429, python, repo, run, start } from './support/examples';
import { MockFilarr } from './support/mockFilarr';
import { tempDir, until } from './support/util';

setLogLevel('silent');

let mock: MockFilarr;
let gate: Gate;
let api = '';
let accessId = '';
const stores: Record<string, string> = {};
const keys = { calls: '', erp: '', export: '', mcp: '', form: '', site: '' };
const ORIGIN = 'https://shop.example.test';

beforeAll(async () => {
  execFileSync(process.execPath, [join(repo, 'packages', 'gate', 'scripts', 'build.mjs')], { stdio: 'ignore' });
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: join(repo, 'packages', 'cli'), stdio: 'ignore' });
  mock = new MockFilarr({ writeSwitch: true });
  await mock.listen();
  for (const spec of demoStores) stores[spec.dbId] = await mock.createStore(spec);
  const access = await mock.createAccess('ERP Atelier', 'pro');
  accessId = access.accessId;
  await mock.grant(accessId, stores[CLIENTS_DB]!, 'rw');
  await mock.grant(accessId, stores[COMMANDES_DB]!, 'rw');
  await mock.grant(accessId, stores[CATALOGUE_DB]!, 'r');
  mock.linkFiles(accessId);
  gate = new Gate({
    env: {
      FILARR_GATE_STATE_DIR: tempDir(),
      FILARR_GATE_API_URL: mock.url,
      FILARR_GATE_TOKEN: access.token,
      FILARR_GATE_PORT: '0',
      FILARR_GATE_ADMIN_PORT: '0',
      FILARR_GATE_CACHE: 'memory',
      FILARR_GATE_WRITE: 'true',
      FILARR_GATE_MCP: 'true',
      FILARR_GATE_CORS_ORIGINS: ORIGIN,
      FILARR_GATE_ADMIN_PASSWORD: 'mot-de-passe-des-exemples',
    },
    webhooks: { delaysMs: [0, 200, 200, 200, 200, 200, 200, 200] },
    replicaTiming: { backoffMinMs: 20, backoffMaxMs: 200 },
  });
  await gate.start();
  api = `http://127.0.0.1:${gate.apiPort}`;
  await until(() => gate.replicator.link === 'live' && gate.model.bases().length === 3, 10_000, 'boîte prête');
  const clients = stores[CLIENTS_DB]!;
  const commandes = stores[COMMANDES_DB]!;
  const catalogue = stores[CATALOGUE_DB]!;
  // Les clés qu'une personne crée dans l'écran « Clés des applications »
  keys.calls = gate.keys.create({ name: 'calls', scopes: [{ target: 'base', storeId: clients, read: true, create: true, update: true, delete: true }], sql: true }).key;
  keys.erp = gate.keys.create({ name: 'erp', scopes: [{ target: 'base', storeId: commandes, read: false, create: true, update: false, delete: false }, { target: 'files', deposit: true }] }).key;
  keys.export = gate.keys.create({ name: 'export', scopes: [{ target: 'base', storeId: clients, read: true, create: false, update: false, delete: false }, { target: 'base', storeId: commandes, read: true, create: false, update: false, delete: false }], sql: true }).key;
  keys.mcp = gate.keys.create({ name: 'assistant', scopes: [{ target: 'all', read: true }], sql: true, mcp: true }).key;
  keys.form = gate.keys.create({ name: 'form', scopes: [{ target: 'base', storeId: clients, read: false, create: true, update: false, delete: false }], rateLimit: 30 }).key;
  const catView = gate.model.baseById(catalogue)!.views.find((v) => v.slug === 'catalogue')!.view.id;
  keys.site = gate.keys.create({ name: 'site', scopes: [{ target: 'view', storeId: catalogue, viewId: catView, read: true }] }).key;
}, 120_000);

afterAll(async () => {
  await gate?.stop();
  await mock?.close();
});

const appRow = async (dbId: string, name: string, prop: string) => (await mock.appRows(stores[dbId]!)).find((r) => r.cells[prop] === name);

describe('examples/library-node', () => {
  it('index.mjs : une vue, des lignes, du SQL, puis un changement reçu en direct', async () => {
    const reader = await mock.createAccess('Exemple', 'pro');
    await mock.grant(reader.accessId, stores[CLIENTS_DB]!, 'r');
    let edited = false;
    const out = await run(process.execPath, ['examples/library-node/index.mjs'], { FILARR_GATE_TOKEN: reader.token, FILARR_GATE_API_URL: mock.url, EXAMPLE_SECONDS: '6' }, (line) => {
      if (line === 'ready' && !edited) {
        edited = true;
        // Laisse le flux s'ouvrir, puis un geste dans l'application
        setTimeout(() => void mock.appEdit(stores[CLIENTS_DB]!, [{ r: 'r_globex', f: 'p_ville', v: 'Saint-Nazaire' }]), 800);
      }
    });
    expect(out.lines, out.lines.join('\n')).toContain('database clients (4 rows): views tous-les-clients, clients-actifs, a-relancer');
    expect(out.lines).toContain('active: Acme (Lyon)');
    expect(out.lines).toContain('active: Globex (Nantes)');
    expect(out.lines).toContain('first: Acme, Globex · 3 in all · next: o2');
    expect(out.lines).toContain('per city: Lille=1 Lyon=1 Nantes=1 Paris=1');
    expect(out.lines).toContain('changed in clients: Globex → Saint-Nazaire');
    expect(out.code).toBe(0);
    await mock.appEdit(stores[CLIENTS_DB]!, [{ r: 'r_globex', f: 'p_ville', v: 'Nantes' }]);
  }, 30_000);

  it('write.mjs : ajoute, modifie et supprime des lignes', async () => {
    const writer = await mock.createAccess('Écriture', 'pro');
    await mock.grant(writer.accessId, stores[CLIENTS_DB]!, 'rw');
    const out = await run(process.execPath, ['examples/library-node/write.mjs'], { FILARR_GATE_TOKEN: writer.token, FILARR_GATE_API_URL: mock.url });
    expect(out.lines, out.lines.join('\n')).toContain('added Hooli: Prospect');
    expect(out.lines).toContain('added 2 more');
    expect(out.lines).toContain('updated Hooli: Client, 5100');
    expect(out.lines).toContain('deleted 3; 4 rows left');
    expect(out.lines).toContain('refused: GateError 404 row_not_found');
    expect(out.lines[0]).toMatch(/^fields: nom \(string\), ville \(string\), statut \(string\), ca \(number\), dernier_contact \(date\)/);
    expect(out.code).toBe(0);
    expect(await appRow(CLIENTS_DB, 'Hooli', 'p_nom')).toBeUndefined();
  }, 30_000);
});

describe('examples/first-calls', () => {
  const matched = (lines: string[]) => expect(lines.some((l) => /^3 customers match \(version \d+\)$/.test(l)), lines.join(' | ')).toBe(true);

  it('calls.mjs (fetch) : lister, vue, SQL, écriture idempotente, refus ; un 429 attendu', async () => {
    const proxy = await proxyWithOne429(api);
    try {
      const out = await run(process.execPath, ['examples/first-calls/calls.mjs'], { FILARR_GATE_URL: proxy.url, FILARR_GATE_KEY: keys.calls });
      expect(out.code, out.lines.join('\n')).toBe(0);
      expect(out.lines).toContain('429: waiting 1 s before trying again');
      matched(out.lines);
      expect(out.lines).toEqual(expect.arrayContaining(['  Acme (Lyon): 12500', '  Globex (Nantes): 9800', '  Umbrella (Paris): 1200']));
      expect(out.lines).toContain('view "Clients actifs": Acme, Globex');
      expect(out.lines).toContain('per city: Lille=1 Lyon=1 Nantes=1 Paris=1');
      expect(out.lines).toContain("created Hooli, status Prospect (the column's default), id db-…");
      expect(out.lines).toContain('sent again with the same Idempotency-Key: replayed=true, same id: true');
      expect(out.lines).toContain('updated: statut=Client');
      expect(out.lines).toContain('deleted');
      expect(out.lines).toContain('refused: 400 unknown_field (field: couleur)');
      expect(proxy.refused()).toBe(1);
      expect(await appRow(CLIENTS_DB, 'Hooli', 'p_nom')).toBeUndefined();
    } finally {
      await proxy.close();
    }
  }, 30_000);

  it.skipIf(!python)('calls.py (Python, bibliothèque standard) : les mêmes appels, les mêmes réponses', async () => {
    const proxy = await proxyWithOne429(api);
    try {
      const out = await run(python!, ['examples/first-calls/calls.py'], { FILARR_GATE_URL: proxy.url, FILARR_GATE_KEY: keys.calls });
      expect(out.code, out.lines.join('\n')).toBe(0);
      expect(out.lines).toContain('429: waiting 1 s before trying again');
      matched(out.lines);
      expect(out.lines).toContain('  Umbrella (Paris): 1200');
      expect(out.lines).toContain('view "Clients actifs": Acme, Globex');
      expect(out.lines).toContain('per city: Lille=1 Lyon=1 Nantes=1 Paris=1');
      expect(out.lines).toContain("created Hooli, status Prospect (the column's default), id db-...");
      expect(out.lines).toContain('sent again with the same Idempotency-Key: replayed=true, same id: True');
      expect(out.lines).toContain('updated: statut=Client');
      expect(out.lines).toContain('refused: 400 unknown_field (field: couleur)');
      expect(await appRow(CLIENTS_DB, 'Hooli', 'p_nom')).toBeUndefined();
    } finally {
      await proxy.close();
    }
  }, 30_000);

  it.skipIf(!bash)('calls.sh (curl) : les mêmes appels, à la main', async () => {
    const proxy = await proxyWithOne429(api);
    try {
      const out = await run(bash!, ['examples/first-calls/calls.sh'], { FILARR_GATE_URL: proxy.url, FILARR_GATE_KEY: keys.calls });
      const text = out.lines.join('\n');
      expect(out.code, text).toBe(0);
      expect(proxy.refused()).toBe(1);
      expect(text).toContain('{"rows":[{"id":"r_acme","nom":"Acme","ville":"Lyon","ca":12500},{"id":"r_globex","nom":"Globex","ville":"Nantes","ca":9800}],"next":"o2","total":3');
      expect(text).toContain('{"rows":[{"id":"r_umbrella","nom":"Umbrella","ville":"Paris","ca":1200}],"next":null,"total":3');
      expect(text).toContain('"view":{"slug":"clients-actifs","name":"Clients actifs"}');
      expect(text).toContain('"columns":["ville","n"],"rows":[["Lille",1],["Lyon",1],["Nantes",1],["Paris",1]]');
      expect(text).toMatch(/\{"id":"db-[^"]+","row":\{"id":"db-[^"]+","nom":"Hooli","ville":"Bordeaux","statut":"Prospect","ca":4200/);
      expect(text).toMatch(/"statut":"Client"/);
      expect(text).toMatch(/"deleted":true/);
      expect(text).toContain('"code":"unknown_field","field":"couleur"} HTTP 400');
      expect(await appRow(CLIENTS_DB, 'Hooli', 'p_nom')).toBeUndefined();
    } finally {
      await proxy.close();
    }
  }, 60_000);
});

describe('examples/webhook-receiver', () => {
  const receivers: Array<[string, string, string[]]> = [['node', process.execPath, ['examples/webhook-receiver/receiver.mjs']]];
  if (python) receivers.push(['python', python, ['examples/webhook-receiver/receiver.py']]);

  it.each(receivers)('récepteur (%s) : une livraison signée est traitée, une contrefaite refusée', async (name, cmd, args) => {
    const port = await freePort();
    const hook = gate.webhooks.create({ name: `récepteur ${name}`, url: `http://127.0.0.1:${port}/filarr`, target: { storeId: stores[CLIENTS_DB]! }, events: ['row.updated'], filter: null, transition: false, fields: null, expand: [] });
    const receiver = start(cmd, args, { WEBHOOK_SECRET: hook.secret, PORT: String(port) });
    try {
      await until(() => receiver.lines.some((l) => l.startsWith('listening on')), 10_000, 'récepteur prêt');
      await mock.appEdit(stores[CLIENTS_DB]!, [{ r: 'r_initech', f: 'p_ville', v: 'Roubaix' }]);
      await until(() => receiver.lines.includes('row.updated clients r_initech changed: ville'), 10_000, `livraison reçue : ${receiver.lines.join(' | ')}`);
      // Une livraison qui ne vient pas de la boîte : signature fausse
      const forged = await fetch(`http://127.0.0.1:${port}/filarr`, { method: 'POST', headers: { 'Filarr-Gate-Signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` }, body: '{"event":"row.deleted"}' });
      expect(forged.status).toBe(401);
      await until(() => receiver.lines.includes('refused: bad signature'), 5000, 'contrefaçon refusée');
    } finally {
      receiver.child.kill();
      gate.webhooks.remove(hook.id);
      await mock.appEdit(stores[CLIENTS_DB]!, [{ r: 'r_initech', f: 'p_ville', v: 'Lille' }]);
    }
  }, 30_000);
});

describe('examples/erp-orders-invoices', () => {
  it('commandes écrites une fois (lot idempotent), facture déposée, puis rangée par l’appli', async () => {
    let filed = false;
    const out = await run(process.execPath, ['examples/erp-orders-invoices/erp.mjs'], { FILARR_GATE_URL: api, FILARR_GATE_KEY: keys.erp, WAIT_SECONDS: '20' }, (line) => {
      const m = /^deposited (dp_\S+): deposited$/.exec(line);
      if (m && !filed) {
        filed = true;
        // L'appli Filarr du propriétaire le range (ici : le Filarr en mémoire le dit)
        const record = gate.files.get(m[1]!)!;
        setTimeout(() => mock.fileDeposit(record.depositId!, 'filed'), 500);
      }
    });
    expect(out.code, out.lines.join('\n')).toBe(0);
    expect(out.lines[0]).toMatch(/^attempt 1: 2 orders, Filarr version \d+, replayed=false$/);
    expect(out.lines[1]).toMatch(/^attempt 2: 2 orders, Filarr version \d+, replayed=true$/);
    expect(out.lines.some((l) => /^dp_\S+: filed at 20\d\d-/.test(l))).toBe(true);
    const orders = (await mock.appRows(stores[COMMANDES_DB]!)).filter((r) => r.cells.c_numero === 'C-2026-1190');
    expect(orders).toHaveLength(1);
    // Ce que Filarr a reçu : un dépôt scellé et sa taille ; jamais le nom ni le chemin demandé
    const dep = [...mock.deposits.values()].at(-1)!;
    expect(dep.status).toBe('filed');
    expect(JSON.stringify(dep)).not.toContain('facture-C-2026-1190');
    expect(JSON.stringify(dep)).not.toContain('Factures/2026');
  }, 40_000);
});

describe.skipIf(!python)('examples/python-nightly-export', () => {
  it('export.py écrit le résultat SQL en CSV', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'export-')), 'clients.csv');
    const res = await run(python!, ['examples/python-nightly-export/export.py', out], { FILARR_GATE_URL: api, FILARR_GATE_KEY: keys.export });
    expect(res.code, res.lines.join('\n')).toBe(0);
    const csv = readFileSync(out, 'utf8').trim().split(/\r?\n/);
    expect(csv[0]).toBe('nom,ville,commandes,chiffre');
    expect(csv[1]).toMatch(/^Acme,Lyon,\d+,/);
    expect(csv).toContain('Initech,Lille,0,0');
    expect(res.lines[0]).toMatch(new RegExp(`^${csv.length - 1} rows written to `));
  }, 30_000);
});

describe('examples/mcp-assistant', () => {
  it('check.mjs : initialize, outils, list_bases, query_view, run_sql, un appel refusé', async () => {
    const out = await run(process.execPath, ['examples/mcp-assistant/check.mjs'], { FILARR_GATE_URL: api, FILARR_GATE_KEY: keys.mcp });
    expect(out.code, out.lines.join('\n')).toBe(0);
    expect(out.lines[0]).toMatch(/^server: filarr-gate \S+, protocol 2025-06-18$/);
    expect(out.lines).toContain('tools: list_bases, query_view, get_row, run_sql');
    expect(out.lines.some((l) => l.startsWith('base clients: nom, ville, statut, ca'))).toBe(true);
    expect(out.lines).toContain('active customers: Acme, Globex');
    expect(out.lines).toContain('customers: 4');
    expect(out.lines).toContain('refused: true base_not_found');
  }, 30_000);

  it('le relais stdio de claude_desktop_config.json (filarr-gate mcp --gate …) répond de même', async () => {
    const config = JSON.parse(readFileSync(join(repo, 'examples/mcp-assistant/claude_desktop_config.json'), 'utf8')) as { mcpServers: { filarr: { args: string[] } } };
    const args = config.mcpServers.filarr.args.slice(1).map((a) => (a === 'http://127.0.0.1:8443' ? api : a));
    expect(args.slice(0, 2)).toEqual(['mcp', '--gate']);
    const relay = start(process.execPath, [join(repo, 'packages/cli/dist/cli.js'), ...args], { FILARR_GATE_KEY: keys.mcp, FILARR_GATE_LOG_LEVEL: 'error' });
    try {
      relay.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n`);
      relay.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'query_view', arguments: { base: 'clients', view: 'clients-actifs' } } })}\n`);
      await until(() => relay.lines.filter((l) => l.startsWith('{')).length >= 2, 10_000, `réponses du relais : ${relay.lines.join(' | ')}`);
      const answers = relay.lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as { id: number; result: { structuredContent?: { rows: Array<{ nom: string }> } } });
      expect(answers.find((a) => a.id === 2)!.result.structuredContent!.rows.map((r) => r.nom)).toEqual(['Acme', 'Globex']);
    } finally {
      relay.child.kill();
    }
    const http = JSON.parse(readFileSync(join(repo, 'examples/mcp-assistant/mcp-http.json'), 'utf8')) as { mcpServers: { filarr: { url: string } } };
    expect(new URL(http.mcpServers.filarr.url).pathname).toBe('/mcp');
  }, 30_000);
});

describe('examples/public-form', () => {
  it('une clé « création seule », depuis une page autorisée, crée ; elle ne lit rien ; une autre page est refusée', async () => {
    // Le module de la page, tel que le navigateur le charge (un chemin en variable : JavaScript sans types)
    const formModule = '../examples/public-form/form.js';
    const { contactRequest } = (await import(formModule)) as { contactRequest: (u: string, k: string, f: Record<string, string>) => { url: string; init: RequestInit } };
    const { url, init } = contactRequest(api, keys.form, { nom: 'Formulaire SARL', ville: 'Tours' });
    // Un navigateur pose Origin lui-même, et demande d'abord (pré-vérification) à cause d'Authorization
    const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const created = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Origin: ORIGIN } });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; row: { statut: string } };
    expect(body.row.statut).toBe('Prospect');
    const read = await fetch(`${api}/v1/clients`, { headers: { Authorization: `Bearer ${keys.form}`, Origin: ORIGIN } });
    expect(((await read.json()) as { code: string }).code).toBe('forbidden');
    const elsewhere = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Origin: 'https://evil.example' } });
    expect(elsewhere.status).toBe(403);
    expect(((await elsewhere.json()) as { code: string }).code).toBe('origin_forbidden');
    await fetch(`${api}/v1/clients/rows/${body.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${keys.calls}` } });
  });
});

describe('examples/static-site', () => {
  it('build.mjs écrit la page ; rebuild-on-webhook.mjs la refait quand un prix change dans Filarr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'site-'));
    const page = join(dir, 'index.html');
    const once = await run(process.execPath, ['examples/static-site/build.mjs', page], { FILARR_GATE_URL: api, FILARR_GATE_KEY: keys.site });
    expect(once.code, once.lines.join('\n')).toBe(0);
    expect(once.lines).toContain(`2 products written to ${page}`);
    expect(readFileSync(page, 'utf8')).toMatch(/<strong>Table chêne<\/strong> 890,00/);

    const port = await freePort();
    const hook = gate.webhooks.create({ name: 'site', url: `http://127.0.0.1:${port}/rebuild`, target: { storeId: stores[CATALOGUE_DB]! }, events: ['row.created', 'row.updated', 'row.deleted'], filter: null, transition: false, fields: null, expand: [] });
    const rebuild = start(process.execPath, ['examples/static-site/rebuild-on-webhook.mjs', page], { FILARR_GATE_URL: api, FILARR_GATE_KEY: keys.site, WEBHOOK_SECRET: hook.secret, PORT: String(port) });
    try {
      await until(() => rebuild.lines.some((l) => l.startsWith('first build: 2 products')), 10_000, 'première construction');
      await mock.appEdit(stores[CATALOGUE_DB]!, [{ r: 'r_k1', f: 'k_prix', v: 990 }]);
      await until(() => rebuild.lines.includes('rebuilt: 2 products'), 10_000, `reconstruite : ${rebuild.lines.join(' | ')}`);
      expect(readFileSync(page, 'utf8')).toMatch(/<strong>Table chêne<\/strong> 990,00/);
    } finally {
      rebuild.child.kill();
      gate.webhooks.remove(hook.id);
      await mock.appEdit(stores[CATALOGUE_DB]!, [{ r: 'r_k1', f: 'k_prix', v: 890 }]);
    }
  }, 30_000);
});
