// La construction est-elle REPRODUCTIBLE ? Construit et empaquette @filarr/gate et filarr-gate deux fois
// (rien n'est publié), compare les empreintes SHA-256 des archives, et écrit SHA256SUMS dans le dossier donné.
//   node scripts/pack-check.mjs <dossier>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = resolve(process.argv[2] ?? join(root, 'release'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args, cwd = root) => execFileSync(npm, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', shell: process.platform === 'win32' });

function packOnce(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  run(['run', 'build']);
  // Deux dossiers : `npm pack` nomme @filarr/gate et filarr-gate de la même façon (filarr-gate-<version>.tgz)
  const sums = {};
  for (const [ws, sub] of [['@filarr/gate', 'library'], ['filarr-gate', 'cli']]) {
    mkdirSync(join(dir, sub), { recursive: true });
    run(['pack', '--silent', '--pack-destination', join(dir, sub), '-w', ws]);
    for (const f of readdirSync(join(dir, sub)).filter((x) => x.endsWith('.tgz'))) sums[`${sub}/${f}`] = createHash('sha256').update(readFileSync(join(dir, sub, f))).digest('hex');
  }
  return sums;
}

const a = packOnce(join(out, 'a'));
const b = packOnce(join(out, 'b'));
const names = Object.keys(a);
const same = names.length > 0 && names.every((n) => a[n] === b[n]) && Object.keys(b).length === names.length;
writeFileSync(join(out, 'SHA256SUMS'), names.map((n) => `${a[n]}  ${n}`).join('\n') + '\n');
for (const n of names) console.log(`${a[n] === b[n] ? 'identique' : 'DIFFÉRENT'}  ${a[n]}  ${n}`);
if (!same) {
  console.error('construction non reproductible : les archives diffèrent');
  process.exit(1);
}
