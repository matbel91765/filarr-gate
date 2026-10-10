/**
 * gate-heberge-1, familles 2, 8 et 9 : la boîte noire en est l'ORIGINE.
 * Le fichier est écrit par une référence en Node seul (`scripts/gen-gate-heberge-1-gate-vectors.mjs`) ;
 * on le rejoue ici par le cœur (`engine/gate/host.ts`, sous WebCrypto et sous le crypto de Node) et par
 * la vérification de la chaîne de publication (`scripts/release/tag-check.mjs`, `scripts/release/journal.mjs`).
 * Les signatures SSH sont aussi relues par `ssh-keygen` quand il est là.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { webCryptoStore } from '../packages/core/src/engine/store/crypto';
import { parseAccessToken } from '../packages/core/src/engine/store/apiAccess';
import { deriveBoxKey, openSealedToken, openState, sealState, sealToken, sealedTokenPlaintext, stateAad, type SealedTokenPlain } from '../packages/core/src/engine/gate/host';
import { curves } from '../packages/gate/src/crypto/providers';
import { buildHebergeGateVectors, formatHebergeGateVectors } from '../scripts/gen-gate-heberge-1-gate-vectors.mjs';
import { checkEntry, codeHashOf, journalLine } from '../scripts/release/journal.mjs';
import { checkTag, splitSignedTag } from '../scripts/release/tag-check.mjs';
import { nodeCryptoStore } from './helpers/nodeCryptoStore';

interface TagCase {
  why: string;
  tag: string;
  raw: string;
  expected: Record<string, unknown>;
}
interface Vectors {
  sealedToken: {
    token: string;
    accessId: string;
    hostKey: { id: string; encPrivateKeyHex: string; encPublicKey: string };
    otherHostKey: { id: string; encPrivateKeyHex: string; encPublicKey: string };
    randomness: { ephemeralPrivHex: string; ivHex: string };
    expected: { accessId: string; keyId: string };
    accepted: Array<{ why: string; plain: SealedTokenPlain; plaintext: string; sealed: string }>;
    refused: Array<{ why: string; sealed: string }>;
  };
  box: {
    token: string;
    accessId: string;
    kBoxHex: string;
    otherToken: string;
    otherKBoxHex: string;
    aad: Array<{ key: string; aad: string; aadHex: string }>;
    state: { key: string; ivHex: string; plaintext: string; ciphertextHex: string; envelopeHex: string };
    refused: Array<{ why: string; aad?: string; kBoxHex?: string }>;
  };
  securityTag: {
    signers: Record<string, { principal: string | null; seedHex: string; publicKey: string }>;
    signersFile: string;
    sha256sums: string;
    knownAdvisories: string[];
    tags: { security: TagCase[]; ordinary: TagCase[]; securityRefused: TagCase[]; refused: TagCase[] };
    journal: {
      published: { entry: Record<string, string>; line: string };
      deployed: { entry: Record<string, string>; line: string };
      security: { entry: Record<string, string>; line: string };
      refused: Array<{ why: string; entry: Record<string, string> }>;
    };
  };
}

const file = join(__dirname, 'vectors', 'gate-heberge-1-gate.vectors.json');
const fixture = (): Vectors => JSON.parse(readFileSync(file, 'utf8')) as Vectors;
const unhex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const providers = [
  ['WebCrypto', webCryptoStore()],
  ['crypto de Node', nodeCryptoStore],
] as const;

describe('gate-heberge-1, familles 2, 8, 9 : le fichier', () => {
  it('est exactement ce que la référence en Node seul écrit', () => {
    expect(formatHebergeGateVectors(buildHebergeGateVectors())).toBe(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  });

  it('le jeton est celui de la famille 4 (gate-heberge-1.vectors.json, recopié de filarg)', () => {
    const notify = (JSON.parse(readFileSync(join(__dirname, 'vectors', 'gate-heberge-1.vectors.json'), 'utf8')) as { notify: { token: string } }).notify;
    expect(fixture().sealedToken.token).toBe(notify.token);
    expect(fixture().box.token).toBe(notify.token);
  });
});

describe('gate-heberge-1, famille 2 : le scellé du jeton', () => {
  it.each(providers)('s’ouvre, et se rescelle à l’identique à aléa imposé, sous %s', async (_name, c) => {
    const v = fixture().sealedToken;
    const priv = unhex(v.hostKey.encPrivateKeyHex);
    expect(Buffer.from(curves.x25519PublicKey(priv)).toString('base64')).toBe(v.hostKey.encPublicKey);
    for (const k of v.accepted) {
      expect(sealedTokenPlaintext(k.plain), k.why).toBe(k.plaintext);
      const opened = await openSealedToken(c, curves, priv, k.sealed, v.expected);
      expect(opened, k.why).toEqual(k.plain);
      const fixed = { ephemeralPriv: unhex(v.randomness.ephemeralPrivHex), iv: unhex(v.randomness.ivHex) };
      expect(await sealToken(c, curves, k.plain, v.hostKey.encPublicKey, fixed), k.why).toBe(k.sealed);
    }
  });

  it.each(providers)('refuse chaque scellé faux sous %s', async (_name, c) => {
    const v = fixture().sealedToken;
    for (const r of v.refused) {
      await expect(openSealedToken(c, curves, unhex(v.hostKey.encPrivateKeyHex), r.sealed, v.expected), r.why).rejects.toThrow();
    }
  });

  it('le scellé vers une autre clé s’ouvre avec CETTE clé-là, puis est refusé pour son k', async () => {
    const v = fixture().sealedToken;
    const other = v.refused.find((r) => r.why.startsWith('scellé vers une autre clé'))!;
    await expect(openSealedToken(nodeCryptoStore, curves, unhex(v.otherHostKey.encPrivateKeyHex), other.sealed, { accessId: v.accessId, keyId: v.otherHostKey.id })).rejects.toThrow(/autre clé du service/);
  });
});

describe('gate-heberge-1, famille 8 : K_box et l’AAD de l’état', () => {
  it.each(providers)('K_box, les AAD et le chiffré d’exemple sous %s', async (_name, c) => {
    const v = fixture().box;
    const tok = parseAccessToken(v.token)!;
    const kBox = await deriveBoxKey(c, tok.accessIdBytes, tok.secret);
    expect(hex(kBox)).toBe(v.kBoxHex);
    const other = parseAccessToken(v.otherToken)!;
    expect(hex(await deriveBoxKey(c, other.accessIdBytes, other.secret))).toBe(v.otherKBoxHex);
    for (const a of v.aad) {
      expect(hex(stateAad(v.accessId, a.key))).toBe(a.aadHex);
      expect(new TextDecoder().decode(stateAad(v.accessId, a.key))).toBe(a.aad);
    }
    const iv = unhex(v.state.ivHex);
    const aad = stateAad(v.accessId, v.state.key);
    expect(hex(await c.aesGcmEncrypt(kBox, iv, utf8(v.state.plaintext), aad))).toBe(v.state.ciphertextHex);
    expect(new TextDecoder().decode(await c.aesGcmDecrypt(kBox, iv, unhex(v.state.ciphertextHex), aad))).toBe(v.state.plaintext);
    expect(hex(await sealState(c, kBox, v.accessId, v.state.key, utf8(v.state.plaintext), iv))).toBe(v.state.envelopeHex);
    expect(new TextDecoder().decode(await openState(c, kBox, v.accessId, v.state.key, unhex(v.state.envelopeHex)))).toBe(v.state.plaintext);
    await expect(openState(c, kBox, v.accessId, 'queries', unhex(v.state.envelopeHex))).rejects.toThrow();
    for (const r of v.refused) {
      const key = r.kBoxHex ? unhex(r.kBoxHex) : kBox;
      const wrongAad = r.aad ? utf8(r.aad) : aad;
      await expect(c.aesGcmDecrypt(key, iv, unhex(v.state.ciphertextHex), wrongAad), r.why).rejects.toThrow();
    }
  });
});

describe('gate-heberge-1, famille 9 : l’étiquette de sécurité et le journal public', () => {
  const v = fixture().securityTag;
  const advisoryExists = (id: string) => v.knownAdvisories.includes(id);
  const all = [...v.tags.security, ...v.tags.ordinary, ...v.tags.securityRefused, ...v.tags.refused];

  it.each(all.map((t) => [t.why, t] as const))('%s', async (_why, t) => {
    const got = (await checkTag({ tag: t.tag, raw: t.raw, signers: v.signersFile, advisoryExists })) as unknown as Record<string, unknown>;
    expect(Object.fromEntries(Object.keys(t.expected).map((k) => [k, got[k]]))).toEqual(t.expected);
    if (t.expected.ok === true) expect(got).toEqual(t.expected);
  });

  it('les familles couvrent ce que demande le § 16 : un accepté, rôle ordinaire, avis absent, ligne manquante', () => {
    expect(v.tags.security.map((t) => t.expected.kind)).toEqual(['security']);
    const refused = v.tags.securityRefused.map((t) => (t.expected.security as { refused: string }).refused);
    expect(refused).toEqual(expect.arrayContaining(['role', 'advisory-unknown', 'kind-line-missing', 'advisory-line-missing']));
  });

  it('une clé déclarée dans les deux rôles est refusée, une option inconnue aussi', async () => {
    const t = v.tags.security[0]!;
    const releaseLine = v.signersFile.split('\n').find((l) => l.startsWith('release:'))!;
    const both = v.signersFile + releaseLine.replace('release:essai', 'security:autre') + '\n';
    expect((await checkTag({ tag: t.tag, raw: t.raw, signers: both, advisoryExists })).ok).toBe(false);
    const option = v.signersFile.replace('namespaces="git"', 'valid-before="20990101"');
    expect(await checkTag({ tag: t.tag, raw: t.raw, signers: option, advisoryExists })).toMatchObject({ ok: false, refused: 'signers' });
  });

  it('ssh-keygen lit les mêmes signatures (quand il est installé)', () => {
    if (spawnSync('ssh-keygen', ['-?'], { encoding: 'utf8' }).error) return;
    const dir = mkdtempSync(join(tmpdir(), 'filarr-gate-sshsig-'));
    try {
      writeFileSync(join(dir, 'signers'), v.signersFile);
      for (const t of all) {
        const split = splitSignedTag(t.raw);
        if (!split) continue;
        writeFileSync(join(dir, 'sig'), split.armored);
        const signer = v.tags.refused.some((r) => r === t && r.expected.refused === 'signer-unknown');
        const principal = spawnSync('ssh-keygen', ['-Y', 'find-principals', '-f', join(dir, 'signers'), '-s', join(dir, 'sig'), '-n', 'git'], { encoding: 'utf8' }).stdout.trim();
        if (signer) {
          expect(principal, t.why).toBe('');
          continue;
        }
        const ok = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', join(dir, 'signers'), '-I', principal, '-n', 'git', '-s', join(dir, 'sig')], { input: split.payload, encoding: 'utf8' }).status === 0;
        expect(ok, t.why).toBe(t.expected.refused !== 'signature-invalid');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('une entrée du journal de chaque sorte, et les refus', () => {
    for (const kind of ['published', 'deployed', 'security'] as const) {
      const e = v.journal[kind];
      expect(checkEntry(e.entry), kind).toEqual([]);
      expect(journalLine(e.entry), kind).toBe(e.line + '\n');
    }
    for (const r of v.journal.refused) expect(checkEntry(r.entry).length, r.why).toBeGreaterThan(0);
  });
});
