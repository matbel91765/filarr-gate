/**
 * Les vecteurs dorés, rejoués par la copie du cœur que porte la boîte noire.
 * db-store-1 et api-base-1 : les fichiers sont ceux des contrats gelés avec les applis
 * Filarr, à l'octet près, et leurs rejoueurs ceux de filarg (`test/helpers`), recopiés.
 * source-externe-1, gate-fichiers-1 et gate-settings-1 : la boîte noire en est l'ORIGINE
 * (rien dans filarg à ce jour) ; `scripts/build-vectors.ts` les écrit. Les familles 2, 8
 * et 9 de gate-heberge-1 : `test/hebergeGateVectors.test.ts`.
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
import { buildExtsrcVectors, formatVectors, replayExtsrcVectors, type ExtsrcVectors } from './helpers/extsrcVectors';
import { buildGateFilesVectors, replayGateFilesVectors, type GateFilesVectors } from './helpers/gateFilesVectors';
import { buildSettingsVectors, replaySettingsVectors, type SettingsVectors } from './helpers/settingsVectors';

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

// ==================== Vecteurs dont la boîte noire est l'origine ====================

const extsrcFixture = (): ExtsrcVectors => JSON.parse(readFileSync(join(dir, 'source-externe-1.vectors.json'), 'utf8')) as ExtsrcVectors;
const filesFixture = (): GateFilesVectors => JSON.parse(readFileSync(join(dir, 'gate-fichiers-1.vectors.json'), 'utf8')) as GateFilesVectors;

describe('source-externe-1 (familles 1, 3, 3 bis, 4 à 8)', () => {
  it('le fichier est exactement ce que le cœur produit, au format du dépôt', async () => {
    const built = await buildExtsrcVectors(storeCrypto, curves);
    expect(formatVectors(built)).toBe(readFileSync(join(dir, 'source-externe-1.vectors.json'), 'utf8').replace(/\r\n/g, '\n'));
  });

  it.each(providers)('se rejoue sans écart sous %s', async (_name, provider) => {
    expect(await replayExtsrcVectors(provider, curves, extsrcFixture())).toEqual([]);
  });

  it('le rejeu voit chaque altération', async () => {
    const tampered: Array<[string, (v: ExtsrcVectors) => void]> = [
      ['identité', (v) => (v.identite.sourceIdentity[1]!.identity = 'postgres|db.lan:5433|erp|public.cmd')],
      ['mergeCell', (v) => ((v.mergeCell[3]!.output as { case: string }).case = 'Z')],
      ['planPass', (v) => ((v.planPass[0]!.output as { created: string[] }).created.pop())],
      ['file pleine', (v) => ((v.planPass.find((p) => p.name.startsWith('file pleine'))!.output as { overflow: number }).overflow = 0)],
      ['définition', (v) => v.definitions.validate[1]!.codes.push('bad_name')],
      ['signature', (v) => (v.definitions.signature.signed = { ...v.definitions.signature.signed, name: 'Autre' })],
      ['scellé', (v) => (v.sceaux.status.sealed = v.sceaux.status.sealed.replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A')))],
      ['schéma', (v) => (v.schema.headJson = v.schema.headJson.replace('"managedBy":{', '"managedBy":{"x":1,'))],
    ];
    for (const [what, mutate] of tampered) {
      const v = extsrcFixture();
      mutate(v);
      expect((await replayExtsrcVectors(storeCrypto, curves, v)).length, what).toBeGreaterThan(0);
    }
  });
});

describe('gate-fichiers-1 (familles 4, 5, 6 et filtre)', () => {
  it('le fichier est exactement ce que le cœur produit, au format du dépôt', async () => {
    expect(formatVectors(await buildGateFilesVectors(storeCrypto, curves))).toBe(readFileSync(join(dir, 'gate-fichiers-1.vectors.json'), 'utf8').replace(/\r\n/g, '\n'));
  });

  it.each(providers)('se rejoue sans écart sous %s', async (_name, provider) => {
    expect(await replayGateFilesVectors(provider, curves, filesFixture())).toEqual([]);
  });

  it('le rejeu voit chaque altération', async () => {
    const tampered: Array<[string, (v: GateFilesVectors) => void]> = [
      ['manifeste', (v) => (v.manifeste.manifestJson = v.manifeste.manifestJson.replace('"channel":"gate"', '"channel":"web"'))],
      ['K_file', (v) => (v.manifeste.fixed.fileKeyHex = v.manifeste.fixed.fileKeyHex.replace(/^./, '5'))],
      ['boxSig', (v) => (v.boxSig.accessId = `${v.boxSig.accessId}x`)],
      ['outcome', (v) => (v.outcome.plain = { ...v.outcome.plain, folder: 'Ailleurs' })],
      ['filtre', (v) => (v.filtre[1]!.refusal = null)],
    ];
    for (const [what, mutate] of tampered) {
      const v = filesFixture();
      mutate(v);
      expect((await replayGateFilesVectors(storeCrypto, curves, v)).length, what).toBeGreaterThan(0);
    }
  });
});

describe('gate-heberge-1, famille 6 : le paquet gate-settings-1', () => {
  const fixture = (): SettingsVectors => JSON.parse(readFileSync(join(dir, 'gate-settings-1.vectors.json'), 'utf8')) as SettingsVectors;

  it('le fichier est exactement ce que le cœur produit, au format du dépôt', async () => {
    expect(formatVectors(await buildSettingsVectors(storeCrypto, curves))).toBe(readFileSync(join(dir, 'gate-settings-1.vectors.json'), 'utf8').replace(/\r\n/g, '\n'));
  });

  it.each(providers)('se rejoue sans écart sous %s', async (_name, provider) => {
    expect(await replaySettingsVectors(provider, curves, fixture())).toEqual([]);
  });

  it('le rejeu voit chaque altération', async () => {
    const tampered: Array<[string, (v: SettingsVectors) => void]> = [
      ['clair', (v) => (v.plain = { ...v.plain, settings: { ...v.plain.settings, write: false } })],
      ['scellé', (v) => (v.sealed = v.sealed.replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A')))],
      ['bindSig', (v) => (v.bindSig = v.refused.bindSigOtherKey)],
    ];
    for (const [what, mutate] of tampered) {
      const v = fixture();
      mutate(v);
      expect((await replaySettingsVectors(storeCrypto, curves, v)).length, what).toBeGreaterThan(0);
    }
  });
});
