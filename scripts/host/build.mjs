// Construit le service hébergé (contrat gate-heberge-1, lot H) : UN module ESM autonome,
// packages/host/dist/filarr-gate-host.js, celui que la chaîne met en service tel quel
// (`wrangler deploy --no-bundle`) et dont l'empreinte entre dans SHA256SUMS (PH7).
//
// Reproductible : aucune date, aucun chemin absolu, esbuild et dépendances figés par package-lock.json,
// mêmes entrées → mêmes octets (scripts/pack-check.mjs construit deux fois et compare).
//
//   node scripts/host/build.mjs [--outfile <fichier>] [--keys <liste de clés publiques, essais seulement>]
//
// `--keys` remplace docs/hosted-keys.json (la liste ÉPINGLÉE embarquée) par une liste de clés de TEST : le banc
// local seulement (test/host.e2e.test.ts). Un module ainsi construit n'est jamais celui de SHA256SUMS.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const i = process.argv.indexOf('--outfile');
const outfile = i > 0 ? resolve(process.argv[i + 1]) : join(repo, 'packages', 'host', 'dist', 'filarr-gate-host.js');
const pkg = JSON.parse(readFileSync(join(repo, 'packages', 'cli', 'package.json'), 'utf8'));
const k = process.argv.indexOf('--keys');
const testKeys = k > 0 ? resolve(process.argv[k + 1]) : null;
const plugins = testKeys
  ? [
      {
        name: 'clés-de-test',
        setup(b) {
          b.onResolve({ filter: /hosted-keys\.json$/ }, () => ({ path: testKeys }));
        },
      },
    ]
  : [];

const result = await build({
  absWorkingDir: repo,
  entryPoints: ['packages/host/src/worker.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  // Le seul module que Workers fournit ; tout le reste est embarqué (aucun module Node : workerd sans nodejs_compat)
  external: ['cloudflare:workers'],
  conditions: ['workerd', 'worker', 'browser'],
  mainFields: ['module', 'main'],
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  charset: 'utf8',
  define: { __GATE_VERSION__: JSON.stringify(pkg.version) },
  metafile: true,
  plugins,
  logLevel: 'warning',
});

const inputs = Object.keys(result.metafile.inputs);
const nodeOnly = inputs.filter((p) => /^node:|(^|\/)node_modules\/(pg|mysql2|ws)\//.test(p));
if (nodeOnly.length > 0) {
  console.error(`le service hébergé embarque du code Node : ${nodeOnly.join(', ')}`);
  process.exit(1);
}
console.log(`${relative(repo, outfile)} (${inputs.length} modules)`);
