// Construit @filarr/gate : un module ESM (dist/index.js, plus un morceau à part
// pour le cache sur disque, chargé seulement sous Node avec `cache: { dir }`), et
// les déclarations TypeScript (dist/types), réduites à ce que l'index atteint.
// Construction reproductible : aucune date, chemins relatifs, versions figées par
// package-lock.json (voir docs/release.md).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const repo = resolve(pkgDir, '..', '..');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const dist = join(pkgDir, 'dist');
rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: [join(pkgDir, 'src', 'index.ts')],
  outdir: dist,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  // Les dépendances restent des dépendances ; `node:*` n'est chargé que par le cache sur disque
  external: ['@noble/curves', '@noble/curves/*', '@noble/hashes', '@noble/hashes/*', 'fflate', 'node:*'],
  mainFields: ['module', 'main'],
  sourcemap: false,
  legalComments: 'none',
  chunkNames: 'chunks/[name]-[hash]',
  define: { __GATE_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'warning',
});

// Les déclarations : tsc, puis seulement les fichiers que l'index atteint
const tsconfig = join(pkgDir, 'tsconfig.build.json');
execFileSync(process.execPath, [join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', tsconfig], { stdio: 'inherit' });
const typesDir = join(dist, 'types');
const entry = join(typesDir, 'gate', 'src', 'index.d.ts');
const keep = new Set();
const visit = (file) => {
  if (keep.has(file) || !existsSync(file)) return;
  keep.add(file);
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const base = resolve(dirname(file), m[1]);
    for (const cand of [`${base}.d.ts`, join(base, 'index.d.ts')]) if (existsSync(cand)) visit(cand);
  }
};
visit(entry);
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      if (readdirSync(p).length === 0) rmSync(p, { recursive: true });
    } else if (!keep.has(p)) rmSync(p);
  }
};
walk(typesDir);
console.log(`@filarr/gate ${pkg.version} : dist/index.js, ${keep.size} fichier(s) de déclarations`);
for (const f of [...keep].sort()) console.log(`  ${relative(dist, f).split('\\').join('/')}`);
