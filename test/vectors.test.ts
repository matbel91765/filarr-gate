/**
 * Les vecteurs dorés des deux contrats, rejoués par la copie du cœur que porte la
 * boîte noire. Les fichiers sont ceux de `.filarr-parity/contracts/`, à l'octet
 * près ; les rejoueurs sont ceux de filarg (`test/helpers`), recopiés.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { webCryptoStore } from '../packages/core/src/engine/store/crypto';
import { curves, storeCrypto } from '../packages/gate/src/crypto/providers';
import { nodeCryptoStore } from './helpers/nodeCryptoStore';
import { buildStoreVectors, replayStoreVectors, type StoreVectors } from './helpers/storeVectors';
import {
  buildApiAccessVectors,
  replayApiAccessVectors,
  type ApiAccessVectors,
} from './helpers/apiAccessVectors';

const dir = join(__dirname, 'vectors');
const storeFixture = (): StoreVectors =>
  JSON.parse(readFileSync(join(dir, 'db-store-1.vectors.json'), 'utf8')) as StoreVectors;
const apiFixture = (): ApiAccessVectors =>
  JSON.parse(readFileSync(join(dir, 'api-base-1.vectors.json'), 'utf8')) as ApiAccessVectors;

const providers = [
  ['WebCrypto', webCryptoStore()],
  ['crypto de Node', nodeCryptoStore],
] as const;

describe('db-store-1 (révision 3.9)', () => {
  it('le fichier du contrat est exactement ce que la copie du cœur produit', async () => {
    const built = await buildStoreVectors(storeCrypto);
    expect(JSON.parse(JSON.stringify(built))).toEqual(storeFixture());
  });

  it.each(providers)('se rejoue sans écart sous %s', async (_name, provider) => {
    const { mismatches, deflateIdentique } = await replayStoreVectors(provider, storeFixture());
    expect(mismatches).toEqual([]);
    expect(deflateIdentique).toBe(true);
  });

  it('le rejeu voit chaque altération', async () => {
    const flip = (b64: string) =>
      b64[5] === 'A' ? `${b64.slice(0, 5)}B${b64.slice(6)}` : `${b64.slice(0, 5)}A${b64.slice(6)}`;
    const tampered: Array<[string, (v: StoreVectors) => void]> = [
      ['corps du bloc', (v) => (v.slot.body = flip(v.slot.body))],
      ['tête', (v) => (v.head.body = flip(v.head.body))],
      ['clé de placement', (v) => (v.placement.placeKey = flip(v.placement.placeKey))],
      ['génération', (v) => (v.generations.personal[1]!.kDb = v.generations.personal[0]!.kDb)],
      ['zones', (v) => (v.zones.zones = v.zones.zones.replace('"n":4', '"n":5'))],
    ];
    for (const [what, mutate] of tampered) {
      const v = storeFixture();
      mutate(v);
      const { mismatches } = await replayStoreVectors(storeCrypto, v);
      expect(mismatches.length, what).toBeGreaterThan(0);
    }
  });
});

describe('api-base-1 (révision 2)', () => {
  it('le fichier du contrat est exactement ce que la copie du cœur produit', async () => {
    const built = await buildApiAccessVectors(storeCrypto, curves);
    expect(JSON.parse(JSON.stringify(built))).toEqual(apiFixture());
  });

  it.each(providers)('se rejoue sans écart sous %s', async (_name, provider) => {
    expect(await replayApiAccessVectors(provider, curves, apiFixture())).toEqual([]);
  });

  it('le rejeu voit chaque altération', async () => {
    const flipHex = (hex: string) => hex.replace(/^./, (ch) => (ch === '0' ? '1' : '0'));
    const tampered: Array<[string, (v: ApiAccessVectors) => void]> = [
      ['A_auth', (v) => (v.token.aAuth = flipHex(v.token.aAuth))],
      ['K_db', (v) => (v.grant.kDb = flipHex(v.grant.kDb))],
      ['génération', (v) => (v.grant.info = v.grant.info.replace('|g1', '|g2'))],
      ['scellé', (v) => (v.grant.sealed = v.grant.sealed.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')))],
      ['slug', (v) => (v.slugs.vues[1]!.slug = 'tableau')],
      ['jeton refusé', (v) => v.tokensRefused.push(v.token.token)],
    ];
    for (const [what, mutate] of tampered) {
      const v = apiFixture();
      mutate(v);
      expect((await replayApiAccessVectors(storeCrypto, curves, v)).length, what).toBeGreaterThan(0);
    }
  });
});
