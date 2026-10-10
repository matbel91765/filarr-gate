/**
 * LES GARDES DU SERVICE HÉBERGÉ (contrat gate-heberge-1 § 2.0.4, § 10.2, § 10.3) :
 *  - configuration (`packages/host/wrangler.jsonc`) : aucune trace activée, aucune liaison hors de ses objets,
 *    aucune autre porte que la route, secrets par leur nom ;
 *  - aucune liaison croisée avec le script de l'API, dans les deux sens (le `wrangler.toml` de l'API est
 *    relu si `FILARR_API_WRANGLER_TOML` le désigne ; sinon un extrait fidèle sert de témoin) ;
 *  - code : aucun `console.*` hors de la liste fermée des codes d'erreur, journal du cœur muet, objets créés en
 *    juridiction UE, aucune adresse de production en dur ;
 *  - le module construit (celui qui est mis en service) : reproductible, sans code Node, mêmes sorties de console.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { crossBindingViolations, hostConfigViolations, readJsonc } from '../scripts/host/config-guard.mjs';
import { OPS_CODES } from '../packages/host/src/ops';

const repo = join(__dirname, '..');
const hostDir = join(repo, 'packages', 'host');
const config = readJsonc(readFileSync(join(hostDir, 'wrangler.jsonc'), 'utf8'));
const srcFiles = readdirSync(join(hostDir, 'src')).filter((f) => f.endsWith('.ts'));
const source = (f: string) => readFileSync(join(hostDir, 'src', f), 'utf8');
const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** Un extrait fidèle des liaisons du `wrangler.toml` de l'API (filarg, infra/cloudflare-worker, 2026-10-10). */
const API_TOML = `name = "filarr-api"
main = "src/index.ts"
[[kv_namespaces]]
binding = "PINGS"
id = "427d0cdb3ae949a9998f32833d6b726d"
[[d1_databases]]
binding = "DB"
database_name = "filarr-auth"
[[r2_buckets]]
binding = "SYNC_BUCKET"
bucket_name = "filarr-sync"
[[durable_objects.bindings]]
name = "COLLAB_ROOMS"
class_name = "NoteRoom"
[[migrations]]
tag = "v1"
new_sqlite_classes = ["NoteRoom"]
[[durable_objects.bindings]]
name = "DB_STORES"
class_name = "DbStore"
[[durable_objects.bindings]]
name = "API_METERS"
class_name = "ApiMeter"
[vars]
GATE_HOST_DOMAIN = "gate.filarr.com"
GATE_HOST_CONTROL_URL = "https://ctl.gate.filarr.com"
`;

describe('wrangler.jsonc du service', () => {
  it('conforme : script filarr-gate-host, sa route, ses deux objets, ses secrets par leur nom, aucune trace', () => {
    expect(hostConfigViolations(config)).toEqual([]);
    expect(config.observability).toEqual({ enabled: false, logs: { enabled: false, invocation_logs: false }, traces: { enabled: false } });
    expect(config).not.toHaveProperty('tail_consumers');
    expect(config.main).toBe('dist/filarr-gate-host.js');
    expect(config.no_bundle).toBe(true);
  });

  it('la garde refuse chaque écart : trace allumée, consommateur de traces, liaison à une ressource, porte de plus', () => {
    const variants: Array<[string, Record<string, unknown>]> = [
      ['observabilité allumée', { observability: { enabled: true } }],
      ['journaux allumés', { observability: { enabled: false, logs: { enabled: true } } }],
      ['journaux d’invocation', { observability: { enabled: false, logs: { invocation_logs: true } } }],
      ['échantillonnage', { observability: { enabled: false, head_sampling_rate: 0.1 } }],
      ['bloc absent', { observability: undefined }],
      ['logpush', { logpush: true }],
      ['tail_consumers', { tail_consumers: [{ service: 'collecteur' }] }],
      ['streaming_tail_consumers', { streaming_tail_consumers: [{ service: 'collecteur' }] }],
      ['base D1 de l’API', { d1_databases: [{ binding: 'DB', database_name: 'filarr-auth' }] }],
      ['KV de l’API', { kv_namespaces: [{ binding: 'PINGS', id: 'x' }] }],
      ['R2 de l’API', { r2_buckets: [{ binding: 'SYNC_BUCKET', bucket_name: 'filarr-sync' }] }],
      ['liaison de service', { services: [{ binding: 'API', service: 'filarr-api' }] }],
      ['objet d’un autre script', { durable_objects: { bindings: [...config.durable_objects.bindings, { name: 'DB_STORES', class_name: 'DbStore', script_name: 'filarr-api' }] } }],
      ['workers.dev', { workers_dev: true }],
      ['autre route', { routes: [...config.routes, { pattern: 'api.filarr.com/*', zone_name: 'filarr.com' }] }],
      ['secret en clair', { vars: { ...config.vars, HOST_SIG: '{"id":"h1"}' } }],
      ['secrets non déclarés', { secrets: undefined }],
    ];
    for (const [why, patch] of variants) {
      const c = JSON.parse(JSON.stringify({ ...config, ...patch }));
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete c[k];
      expect(hostConfigViolations(c).length, why).toBeGreaterThan(0);
    }
  });

  it('lit le JSON à commentaires comme wrangler (chaînes avec // et /* préservées)', () => {
    expect(readJsonc('{ // c\n "a": "https://x/*y*/", /* b */ "b": [1,], }')).toEqual({ a: 'https://x/*y*/', b: [1] });
  });
});

describe('aucune liaison croisée entre le script de l’API et le service (§ 2.0.4)', () => {
  it('l’extrait du wrangler.toml de l’API et la configuration du service sont séparés', () => {
    expect(crossBindingViolations(API_TOML, config)).toEqual([]);
  });

  it('la garde voit une liaison dans un sens comme dans l’autre', () => {
    const apiToBox = `${API_TOML}[[durable_objects.bindings]]\nname = "GATE_BOX"\nclass_name = "GateBox"\nscript_name = "filarr-gate-host"\n`;
    expect(crossBindingViolations(apiToBox, config).length).toBeGreaterThan(0);
    const apiService = `${API_TOML}[[services]]\nbinding = "HOST"\nservice = "filarr-gate-host"\n`;
    expect(crossBindingViolations(apiService, config).length).toBeGreaterThan(0);
    const apiSecret = `${API_TOML}HOST_SIG = "x"\n`;
    expect(crossBindingViolations(apiSecret, config).length).toBeGreaterThan(0);
    const hostToApi = { ...config, durable_objects: { bindings: [...config.durable_objects.bindings, { name: 'API_METERS', class_name: 'ApiMeter' }] } };
    expect(crossBindingViolations(API_TOML, hostToApi).length).toBeGreaterThan(0);
  });

  const real = process.env.FILARR_API_WRANGLER_TOML;
  it.skipIf(!real || !existsSync(real))('le vrai wrangler.toml de l’API (FILARR_API_WRANGLER_TOML)', () => {
    expect(crossBindingViolations(readFileSync(real!, 'utf8'), config)).toEqual([]);
  });
});

describe('le code du service', () => {
  it('aucun console.* hors de ops.ts, et là, un code de la liste fermée et rien d’autre', () => {
    for (const f of srcFiles) {
      const calls = withoutComments(source(f)).match(/\bconsole\s*\.\s*\w+/g) ?? [];
      if (f === 'ops.ts') expect(calls, f).toEqual(['console.error']);
      else expect(calls, f).toEqual([]);
    }
    expect(withoutComments(source('ops.ts'))).toContain('console.error(`filarr-gate-host ${code}`)');
    for (const code of OPS_CODES) expect(code).toMatch(/^[a-z_]+$/);
    for (const f of srcFiles) {
      for (const m of withoutComments(source(f)).matchAll(/opsError\(([^)]*)\)/g)) {
        if (f === 'ops.ts') continue;
        expect(m[1], `${f} : ${m[0]}`).toMatch(/^'[a-z_]+'$/);
        expect(OPS_CODES as readonly string[], f).toContain(m[1]!.slice(1, -1));
      }
    }
  });

  it('le journal de console du cœur est muet dans le service', async () => {
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { log, setLogLevel, setLogWriter } = await import('../packages/server/src/log');
      const { silenceCoreLog } = await import('../packages/host/src/silence');
      silenceCoreLog();
      log.error('une ligne : Acme, https://hooks.example.test');
      log.info('une autre');
      expect(spyError).not.toHaveBeenCalled();
      expect(spyLog).not.toHaveBeenCalled();
      setLogLevel('warn');
      setLogWriter((level, line) => (level === 'error' || level === 'warn' ? console.error(line) : console.log(line)));
    } finally {
      spyError.mockRestore();
      spyLog.mockRestore();
    }
    // Importé EN PREMIER par le point d'entrée
    expect(source('worker.ts')).toMatch(/^import '\.\/silence';$/m);
    expect(source('worker.ts').indexOf("import './silence';")).toBeLessThan(source('worker.ts').indexOf("from './box'"));
  });

  it('les objets sont créés en juridiction UE ; aucune adresse de production en dur', () => {
    for (const f of srcFiles) {
      const code = withoutComments(source(f));
      // Toute ouverture d'objet passe par euNamespace (juridiction UE), jamais par l'espace de noms nu
      for (const m of code.matchAll(/(.{0,12})env\.(GATE_BOX|GATE_DIRECTORY)\b/g)) expect(m[1], `${f} : ${m[0]}`).toMatch(/euNamespace\($/);
      expect(code, f).not.toMatch(/api\.filarr\.com/);
    }
    expect(readFileSync(join(hostDir, 'wrangler.jsonc'), 'utf8')).not.toMatch(/api\.filarr\.com/);
    expect(withoutComments(source('env.ts'))).toContain("return ns.jurisdiction('eu');");
  });

  it('le passe-droit du banc local (objets sans juridiction sous workerd) n’existe ni dans la configuration ni dans la chaîne', async () => {
    const { euNamespace, LOCAL_BENCH_NO_JURISDICTION } = await import('../packages/host/src/env');
    expect(readFileSync(join(hostDir, 'wrangler.jsonc'), 'utf8')).not.toContain('GATE_HOST_LOCAL_BENCH');
    for (const w of ['deploy-host.yml', 'release.yml', 'ci.yml']) expect(readFileSync(join(repo, '.github', 'workflows', w), 'utf8'), w).not.toContain('GATE_HOST_LOCAL_BENCH');
    const eu = { tag: 'eu' } as unknown as DurableObjectNamespace;
    const ns = { jurisdiction: (j: string) => (j === 'eu' ? eu : null) } as unknown as DurableObjectNamespace;
    expect(euNamespace(ns, {})).toBe(eu);
    const workerd = {
      jurisdiction: () => {
        throw new Error('Jurisdiction restrictions are not implemented in workerd.');
      },
    } as unknown as DurableObjectNamespace;
    expect(() => euNamespace(workerd, {})).toThrow(/workerd/);
    expect(() => euNamespace(workerd, { GATE_HOST_LOCAL_BENCH: 'oui' })).toThrow(/workerd/);
    expect(euNamespace(workerd, { GATE_HOST_LOCAL_BENCH: LOCAL_BENCH_NO_JURISDICTION })).toBe(workerd);
    const other = {
      jurisdiction: () => {
        throw new Error('autre panne');
      },
    } as unknown as DurableObjectNamespace;
    expect(() => euNamespace(other, { GATE_HOST_LOCAL_BENCH: LOCAL_BENCH_NO_JURISDICTION })).toThrow('autre panne');
  });
});

describe('le module construit (celui que la chaîne met en service)', () => {
  it('se construit à l’identique deux fois, sans code Node, et n’a que les sorties de console attendues', () => {
    const dir = mkdtempSync(join(tmpdir(), 'filarr-gate-host-'));
    const build = (out: string) => execFileSync(process.execPath, [join(repo, 'scripts', 'host', 'build.mjs'), '--outfile', out], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    build(join(dir, 'a.js'));
    build(join(dir, 'b.js'));
    const a = readFileSync(join(dir, 'a.js'));
    expect(a.equals(readFileSync(join(dir, 'b.js')))).toBe(true);
    const text = a.toString('utf8');
    expect(text).not.toMatch(/from\s+["']node:/);
    expect([...text.matchAll(/^import .* from ["']([^"']+)["'];?$/gm)].map((m) => m[1])).toEqual(['cloudflare:workers']);
    // Le rédacteur d'office du journal du cœur (remplacé au chargement par silence.ts) et le code d'erreur de ops.ts
    expect(text.match(/\bconsole\.\w+/g)).toEqual(['console.error', 'console.log', 'console.error']);
    expect(text).toMatch(/export \{[^}]*GateBox[^}]*\}/);
    expect(text).toMatch(/export \{[^}]*GateDirectory[^}]*\}/);
  }, 60_000);
});
