// Avant `npm pack` / `npm publish` d'un paquet : recopie depuis la racine les fichiers que sa liste `files`
// annonce (licence, avis, README…). Les copies sont ignorées par git (.gitignore).
//   node ../../scripts/prepack.mjs LICENSE NOTICE [README.md …]
import { copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
for (const name of process.argv.slice(2)) copyFileSync(join(root, name), join(process.cwd(), name));
