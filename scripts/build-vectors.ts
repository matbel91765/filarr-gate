/**
 * Écrit les vecteurs dont filarr-gate est l'ORIGINE (aucune implémentation dans
 * filarg à ce jour) : `test/vectors/source-externe-1.vectors.json`,
 * `test/vectors/gate-fichiers-1.vectors.json` et `test/vectors/gate-settings-1.vectors.json`
 * (gate-heberge-1, famille 6). Les essais vérifient que le cœur
 * les reproduit à l'identique et les rejoue sous deux fournisseurs de crypto.
 *
 * Les familles 2, 8 et 9 de gate-heberge-1 (`gate-heberge-1-gate.vectors.json`) ont leur propre
 * référence en Node seul : `node scripts/gen-gate-heberge-1-gate-vectors.mjs`.
 *
 *   npx tsx scripts/build-vectors.ts
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { curves, storeCrypto } from '../packages/gate/src/crypto/providers';
import { buildExtsrcVectors, formatVectors } from '../test/helpers/extsrcVectors';
import { buildGateFilesVectors } from '../test/helpers/gateFilesVectors';
import { buildSettingsVectors } from '../test/helpers/settingsVectors';

const dir = join(import.meta.dirname, '..', 'test', 'vectors');
const write = (name: string, value: object) => writeFileSync(join(dir, name), formatVectors(value), 'utf8');
write('source-externe-1.vectors.json', await buildExtsrcVectors(storeCrypto, curves));
write('gate-fichiers-1.vectors.json', await buildGateFilesVectors(storeCrypto, curves));
write('gate-settings-1.vectors.json', await buildSettingsVectors(storeCrypto, curves));
process.stdout.write('vecteurs écrits dans test/vectors\n');
