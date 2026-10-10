// Avant `npm pack` / `npm publish` d'un paquet : recopie depuis la racine les fichiers que sa liste `files`
// annonce (licence, avis, README…). Les copies sont ignorées par git (.gitignore). Dans les fichiers Markdown, les
// liens relatifs deviennent absolus vers le dépôt (`repository` du paquet, branche main) : sur npm, un lien relatif
// ne mène nulle part.
//   node ../../scripts/prepack.mjs LICENSE NOTICE [README.md …]
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** `git+https://github.com/o/r.git` → `https://github.com/o/r/blob/main/` */
export function blobBase(repositoryUrl) {
  const m = /github\.com[/:]([^/]+)\/([^/.]+)(\.git)?$/.exec(repositoryUrl ?? '');
  if (!m) throw new Error(`dépôt GitHub attendu dans repository.url (${repositoryUrl})`);
  return `https://github.com/${m[1]}/${m[2]}/blob/main/`;
}

/** Les liens Markdown relatifs (hors ancres seules) d'un fichier de la racine, rendus absolus. */
export function absolutizeLinks(markdown, base) {
  return markdown.replace(/(!?\[[^\]]*\]\()([^)\s]+)(\))/g, (all, open, target, close) => {
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) return all;
    return `${open}${base}${target.replace(/^\.\//, '')}${close}`;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  for (const name of process.argv.slice(2)) {
    const from = join(root, name);
    const to = join(process.cwd(), name);
    if (name.endsWith('.md')) writeFileSync(to, absolutizeLinks(readFileSync(from, 'utf8'), blobBase(pkg.repository?.url)));
    else copyFileSync(from, to);
  }
}
