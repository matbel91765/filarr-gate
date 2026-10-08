// Paquette le serveur en un seul module ESM (dist/cli.js) ; les dépendances restent dans node_modules.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: true,
  legalComments: 'inline',
  define: { __GATE_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
});
