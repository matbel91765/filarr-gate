/**
 * Écrit les vecteurs dont filarr-gate est l'ORIGINE (aucune implémentation dans
 * filarg à ce jour) : `test/vectors/source-externe-1.vectors.json` et
 * `test/vectors/gate-fichiers-1.vectors.json`. Les essais vérifient que le cœur
 * les reproduit à l'identique et les rejoue sous deux fournisseurs de crypto.
 *
 *   npx tsx scripts/build-vectors.ts
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { curves, storeCrypto } from '../packages/gate/src/crypto/providers';
import { buildExtsrcVectors, formatVectors } from '../test/helpers/extsrcVectors';
import { buildGateFilesVectors } from '../test/helpers/gateFilesVectors';

const dir = join(import.meta.dirname, '..', 'test', 'vectors');
const write = (name: string, value: object) => writeFileSync(join(dir, name), formatVectors(value), 'utf8');
write('source-externe-1.vectors.json', await buildExtsrcVectors(storeCrypto, curves));
write('gate-fichiers-1.vectors.json', await buildGateFilesVectors(storeCrypto, curves));
process.stdout.write('vecteurs écrits dans test/vectors\n');
