// Écrit THIRD_PARTY_NOTICES : les licences du code tiers que Filarr Gate distribue.
//   - l'interface de gestion (packages/cli/dist/ui) embarque Preact et ses signaux ;
//   - l'image Docker et `npm install filarr-gate` apportent les dépendances d'exécution (node_modules).
// La liste vient de package-lock.json (versions figées), les textes des fichiers de licence installés.
//   node scripts/third-party.mjs            réécrit le fichier
//   node scripts/third-party.mjs --check    échoue s'il n'est pas à jour
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
/** Embarqués dans le paquet de l'interface (dépendances de développement du dépôt, mais distribuées construites). */
export const UI_BUNDLED = ['preact', '@preact/signals', '@preact/signals-core'];

function licenseFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^(licen[cs]e|notice|copying)(\.(md|txt))?$/i.test(f) || /^licen[cs]e[-.]/i.test(f))
    .sort();
}

export function buildNotices() {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages;
  const entries = [];
  for (const [key, meta] of Object.entries(lock)) {
    if (!key.startsWith('node_modules/') || meta.link) continue;
    const name = key.slice('node_modules/'.length);
    if (name.includes('/node_modules/')) continue;
    const ui = UI_BUNDLED.includes(name);
    if (meta.dev && !ui) continue;
    entries.push({ name, version: meta.version, license: meta.license ?? 'voir le fichier', where: ui ? 'UI' : meta.optional || meta.devOptional ? 'runtime (optional)' : 'runtime' });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out = [
    'THIRD-PARTY NOTICES — Filarr Gate',
    '',
    'Filarr Gate is licensed under Apache-2.0 (LICENSE, NOTICE). It distributes the third-party software below:',
    '- "UI": built into the management interface (packages/cli/dist/ui);',
    '- "runtime": installed with the command `filarr-gate` and present in the Docker image (node_modules);',
    '  "optional": the PostgreSQL and MySQL connectors.',
    'Generated from package-lock.json by scripts/third-party.mjs.',
    '',
    ...entries.map((e) => `- ${e.name} ${e.version} (${e.license}) — ${e.where}`),
  ];
  for (const e of entries) {
    const dir = join(root, 'node_modules', ...e.name.split('/'));
    out.push('', '='.repeat(78), `${e.name} ${e.version} — ${e.license}`, '='.repeat(78));
    const files = licenseFiles(dir);
    if (files.length === 0) {
      const pkg = existsSync(join(dir, 'package.json')) ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) : {};
      out.push('', `No license file in the package. License: ${e.license}. Author: ${String(typeof pkg.author === 'string' ? pkg.author : pkg.author?.name ?? 'unknown').replace(/\s*<[^>]*>/, '')}.`);
    }
    for (const f of files) out.push('', readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trimEnd());
  }
  return out.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = join(root, 'THIRD_PARTY_NOTICES');
  const text = buildNotices();
  if (process.argv.includes('--check')) {
    const now = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
    if (now !== text) {
      console.error('THIRD_PARTY_NOTICES n’est pas à jour : node scripts/third-party.mjs');
      process.exit(1);
    }
    console.log('THIRD_PARTY_NOTICES : à jour');
  } else {
    writeFileSync(file, text, 'utf8');
    console.log(`THIRD_PARTY_NOTICES écrit (${text.length} octets)`);
  }
}
