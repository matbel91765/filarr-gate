/**
 * Les exemples de la documentation TOURNENT : chacun est lancé tel quel contre le
 * Filarr en mémoire, avec le paquet construit (`dist/`), et sa sortie est vérifiée.
 */

import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENTS_DB, demoStores } from './support/demoData';
import { MockFilarr } from './support/mockFilarr';
import { until } from './support/util';

const repo = join(__dirname, '..');

function run(script: string, env: Record<string, string>, onLine?: (line: string, all: string[]) => void): Promise<{ code: number | null; lines: string[] }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: repo, env: { ...process.env, ...env } });
    const lines: string[] = [];
    let buf = '';
    child.stdout.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        lines.push(line);
        onLine?.(line, lines);
      }
    });
    child.stderr.on('data', (c: Buffer) => lines.push(`[stderr] ${c.toString('utf8').trim()}`));
    child.on('exit', (code) => resolve({ code, lines }));
  });
}

let mock: MockFilarr;
let token = '';
const stores: Record<string, string> = {};

beforeAll(async () => {
  execFileSync(process.execPath, [join(repo, 'packages', 'gate', 'scripts', 'build.mjs')], { stdio: 'ignore' });
  mock = new MockFilarr();
  await mock.listen();
  for (const spec of demoStores) stores[spec.dbId] = await mock.createStore(spec);
  const access = await mock.createAccess('Exemple');
  token = access.token;
  await mock.grant(access.accessId, stores[CLIENTS_DB]!, 'r');
}, 120_000);

afterAll(async () => {
  await mock?.close();
});

describe('examples/library-node', () => {
  it('lit une vue, des lignes, du SQL, puis reçoit un changement en direct', async () => {
    let edited = false;
    const out = await run('examples/library-node/index.mjs', { FILARR_GATE_TOKEN: token, FILARR_GATE_API_URL: mock.url, EXAMPLE_SECONDS: '6' }, (line) => {
      if (line === 'prêt' && !edited) {
        edited = true;
        // Laisse le flux s'ouvrir, puis un geste dans l'application
        setTimeout(() => void mock.appEdit(stores[CLIENTS_DB]!, [{ r: 'r_globex', f: 'p_ville', v: 'Saint-Nazaire' }]), 800);
      }
    });
    expect(out.lines).toContain('base clients (4 lignes) : vues tous-les-clients, clients-actifs, a-relancer');
    expect(out.lines).toContain('actif : Acme (Lyon)');
    expect(out.lines).toContain('actif : Globex (Nantes)');
    expect(out.lines.some((l) => l.startsWith('premières : Acme, Globex · 3 au total · suite : o2'))).toBe(true);
    expect(out.lines).toContain('par ville : Lille=1 Lyon=1 Nantes=1 Paris=1');
    await until(() => out.lines.includes('changé dans clients : Globex → Saint-Nazaire'), 1, 'changement reçu');
    expect(out.code).toBe(0);
  }, 30_000);
});
