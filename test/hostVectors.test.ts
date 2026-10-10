/**
 * gate-heberge-1, familles 2, 3, 4, 5, 7 et 8, REJOUÉES PAR LE SERVICE HÉBERGÉ (`packages/host`).
 *
 *  - 1, 3, 4, 5, 7 : `test/vectors/gate-heberge-1.vectors.json` (origine filarg, référence en Node seul) ;
 *  - 2, 8 (et 9) : `test/vectors/gate-heberge-1-gate.vectors.json` (origine filarr-gate).
 *
 * Ici, c'est le code QUE LE SERVICE EXÉCUTE qui est éprouvé : l'ouverture du jeton scellé par le
 * trousseau du service (clé désignée par `k`, `K_box` et `A_notify` tirés du jeton), la signature des
 * requêtes vers l'API, la vérification des réveils, la signature des reçus et de l'annonce de
 * version, la reconnaissance des noms d'hôte, et l'état au repos sous `K_box`.
 * Ed25519 et HMAC sont déterministes : les signatures sont comparées à l'octet.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyNotify } from '../packages/core/src/engine/gate/access3';
import { toBase64Std } from '../packages/core/src/engine/store/apiAccess';
import { canonicalJson } from '../packages/core/src/engine/store/canonical';
import { curves, storeCrypto } from '../packages/gate/src/crypto/providers';
import { openHostedToken } from '../packages/host/src/box';
import { hostNameBase, labelOf } from '../packages/host/src/front';
import { signedFetch } from '../packages/host/src/hostApi';
import { loadKeyring, type PinnedHostKey } from '../packages/host/src/keys';
import { SealedStorage } from '../packages/host/src/sealedStorage';
import {
  hostRequestHeader,
  hostRequestMessage,
  receiptMessage,
  signReceipt,
  signVersion,
  verifyHostRequestHeader,
  verifyHostSignature,
  versionMessage,
  type ErasureReceipt,
  type VersionAnnouncement,
} from '../packages/host/src/wire';
import { MemoryDoStorage } from './support/hostHarness';

const read = (f: string) => JSON.parse(readFileSync(join(__dirname, 'vectors', f), 'utf8'));
const filarg = read('gate-heberge-1.vectors.json');
const gate = read('gate-heberge-1-gate.vectors.json');
const unhex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** La graine Ed25519 de TEST de la référence (`fixed(11, 32)` de scripts/gen-gate-heberge-1-vectors.mjs). */
const fixed = (seed: number, n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (seed * 31 + i * 7 + 3) & 255);
const testSignKey = { id: 'h-test', privateKey: fixed(11, 32) };

describe('famille 2 : le jeton scellé, ouvert par le trousseau du service', () => {
  const v = gate.sealedToken;
  const pinned: PinnedHostKey[] = [v.hostKey, v.otherHostKey].map((k: { id: string; encPrivateKeyHex: string; encPublicKey: string }) => ({
    id: k.id,
    encPublicKey: k.encPublicKey,
    signPublicKey: toBase64Std(curves.ed25519PublicKey(fixed(k.id.length, 32))),
    notBefore: '2026-01-01T00:00:00.000Z',
    notAfter: '2030-01-01T00:00:00.000Z',
  }));
  const secret = (id: string, privHex: string) => JSON.stringify({ id, privateKey: Buffer.from(privHex, 'hex').toString('base64') });
  const ring = loadKeyring({ HOST_ENC: secret(v.hostKey.id, v.hostKey.encPrivateKeyHex), HOST_ENC_autre: secret(v.otherHostKey.id, v.otherHostKey.encPrivateKeyHex) }, pinned);

  it('le trousseau ne garde que des clés dont la publique est épinglée', () => {
    expect([...ring.enc.keys()].sort()).toEqual([v.hostKey.id, v.otherHostKey.id].sort());
    const wrong = loadKeyring({ HOST_ENC: secret(v.hostKey.id, v.otherHostKey.encPrivateKeyHex) }, pinned);
    expect(wrong.enc.size).toBe(0);
  });

  it('chaque scellé accepté s’ouvre ; K_box et A_notify sont ceux des familles 8 et 4 (même jeton)', async () => {
    for (const k of v.accepted) {
      const opened = await openHostedToken(storeCrypto, ring, { accessId: v.expected.accessId, keyId: v.expected.keyId, sealedToken: k.sealed });
      expect(opened.token, k.why).toBe(v.token);
      expect(opened.s, k.why).toEqual(k.plain.s);
      expect(hex(opened.kBox), k.why).toBe(gate.box.kBoxHex);
      expect(hex(opened.aNotify), k.why).toBe(filarg.notify.aNotify);
    }
  });

  it('chaque scellé faux est refusé (a, k, t d’un autre accès, autre clé, altéré)', async () => {
    for (const r of v.refused) {
      await expect(openHostedToken(storeCrypto, ring, { accessId: v.expected.accessId, keyId: v.expected.keyId, sealedToken: r.sealed }), r.why).rejects.toThrow();
    }
  });

  it('une clé que le service ne tient pas : host_key_missing', async () => {
    await expect(openHostedToken(storeCrypto, ring, { accessId: v.expected.accessId, keyId: 'h-inconnue', sealedToken: v.accepted[0].sealed })).rejects.toThrow('host_key_missing');
  });
});

describe('famille 3 : les requêtes signées du service vers l’API', () => {
  const v = filarg.hostRequest;
  const keys = [{ id: v.key.id, signPublicKey: Buffer.from(v.key.signPublicKey, 'base64'), notBefore: v.key.notBefore, notAfter: v.key.notAfter }];

  it('la graine de test redonne la clé publique du vecteur', () => {
    expect(toBase64Std(curves.ed25519PublicKey(testSignKey.privateKey))).toBe(v.key.signPublicKey);
  });

  it('le message canonique et l’en-tête, à l’octet', () => {
    for (const a of v.accepted) {
      expect(hostRequestMessage(a.method, a.path, a.t, a.bodySha256)).toBe(a.message);
      expect(hostRequestHeader(testSignKey, a.method, a.path, a.t, a.body)).toBe(a.header);
      expect(verifyHostRequestHeader({ header: a.header, method: a.method, pathWithQuery: a.path, body: a.body, keys, nowMs: a.now * 1000 })).toEqual({ ok: true, keyId: 'h-test' });
    }
  });

  it('signedFetch signe exactement ainsi les requêtes vers l’API, et seulement elles', async () => {
    const seen: Array<{ url: string; header: string | null }> = [];
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), header: new Headers(init?.headers).get('filarr-gate-host') });
      return new Response('{}');
    }) as typeof fetch;
    for (const a of v.accepted) {
      const f = signedFetch('https://api.example.test', () => testSignKey, base, () => a.t * 1000);
      await f(`https://api.example.test${a.path}`, { method: a.method, ...(a.body ? { body: a.body } : {}) });
      expect(seen.at(-1)!.header).toBe(a.header);
    }
    const f = signedFetch('https://api.example.test', () => testSignKey, base);
    await f('https://hooks.example.test/x', { method: 'POST', body: '{}' });
    expect(seen.at(-1)!.header).toBeNull();
    // Sans clé de signature, rien ne part vers l'API
    await expect(signedFetch('https://api.example.test', () => null, base)('https://api.example.test/api-access/self')).rejects.toThrow('host_key_missing');
  });

  it('chaque refus du vecteur est refusé (horloge, chemin, corps, clé)', () => {
    for (const r of v.refused) {
      const verdict = verifyHostRequestHeader({ header: r.header, method: r.method, pathWithQuery: r.path, body: r.body, keys, nowMs: r.now * 1000 });
      expect(verdict.ok, r.why).toBe(false);
    }
  });
});

describe('famille 4 : le réveil HMAC, vérifié par la boîte', () => {
  const v = filarg.notify;
  it('A_notify du jeton, en-tête accepté, refus', async () => {
    const aNotify = unhex(v.aNotify);
    for (const a of v.accepted) expect(await verifyNotify(storeCrypto, aNotify, v.header, v.body, a.now)).toBe('ok');
    for (const r of v.refused) expect(await verifyNotify(storeCrypto, aNotify, r.header ?? v.header, r.body ?? v.body, r.now), r.why).not.toBe('ok');
  });
});

describe('famille 5 : le reçu d’effacement et l’annonce de version, signés par le service', () => {
  const v = filarg.receipt;
  const pub = Buffer.from(v.key.signPublicKey, 'base64');

  it('le reçu : JSON canonique, message, signature à l’octet ; altération détectée', () => {
    expect(canonicalJson(v.receipt)).toBe(v.canonical);
    expect(receiptMessage(v.receipt)).toBe(v.message);
    expect(signReceipt(testSignKey, v.receipt as ErasureReceipt)).toBe(v.sig);
    expect(verifyHostSignature(v.message, v.sig, pub)).toBe(true);
    expect(verifyHostSignature(receiptMessage(v.altered.receipt), v.altered.sig, pub)).toBe(v.altered.accepted);
  });

  it('l’annonce de version : message et signature à l’octet', () => {
    const signed = signVersion(testSignKey, v.version.announcement as VersionAnnouncement);
    expect(versionMessage(v.version.announcement)).toBe(v.version.message);
    expect(signed.sig).toBe(v.version.sig);
    expect(verifyHostSignature(v.version.message, signed.sig, pub)).toBe(true);
  });
});

describe('famille 7 : les noms d’hôte', () => {
  const v = filarg.hostName;
  it('la partie lisible, et la reconnaissance de <slug>-<4 base36> sous le domaine', () => {
    for (const c of v.cases) {
      expect(hostNameBase(c.name), c.name).toBe(c.slug);
      expect(c.slug.length).toBeLessThanOrEqual(v.max);
      expect(labelOf(`${c.slug}-7qm2.gate.filarr.com`, 'gate.filarr.com'), c.name).toBe(`${c.slug}-7qm2`);
    }
    // « ctl » seul est l'adresse de contrôle ; une boîte « CTL » porte toujours un suffixe
    expect(labelOf('ctl.gate.filarr.com', 'gate.filarr.com')).toBe('ctl');
    expect(labelOf('CTL-7QM2.gate.filarr.com.', 'gate.filarr.com')).toBe('ctl-7qm2');
    for (const bad of ['gate.filarr.com', 'site-vitrine.gate.filarr.com', 'a.b-7qm2.gate.filarr.com', 'site-vitrine-7qm2.filarr.com', 'site-vitrine-7qm2.gate.filarr.com.evil.test', '-x-7qm2.gate.filarr.com']) {
      expect(labelOf(bad, 'gate.filarr.com'), bad).toBeNull();
    }
  });
});

describe('famille 8 : l’état au repos sous K_box, par le stockage du service', () => {
  const v = gate.box;
  const kBox = unhex(v.kBoxHex);

  it('l’entrée d’exemple se range à l’octet (IV imposé) et se relit', async () => {
    const raw = new MemoryDoStorage();
    const sealed = new SealedStorage(raw, { crypto: storeCrypto, kBox, accessId: v.accessId, fixedIv: () => unhex(v.state.ivHex) });
    await sealed.put(v.state.key, JSON.parse(v.state.plaintext));
    expect(hex((await raw.get<Uint8Array>(v.state.key))!)).toBe(v.state.envelopeHex);
    expect(await new SealedStorage(raw, { crypto: storeCrypto, kBox, accessId: v.accessId }).get(v.state.key)).toEqual(JSON.parse(v.state.plaintext));
  });

  it('refusée sous une autre clé de stockage, un autre accès, un autre K_box, tronquée', async () => {
    const raw = new MemoryDoStorage();
    await raw.put(v.state.key, unhex(v.state.envelopeHex));
    await raw.put('appKeys', unhex(v.state.envelopeHex));
    const good = new SealedStorage(raw, { crypto: storeCrypto, kBox, accessId: v.accessId });
    await expect(good.get('appKeys')).rejects.toThrow();
    await expect(new SealedStorage(raw, { crypto: storeCrypto, kBox, accessId: 'AAECAwQFBgcICQoLDA0ODw' }).get(v.state.key)).rejects.toThrow();
    await expect(new SealedStorage(raw, { crypto: storeCrypto, kBox: unhex(v.otherKBoxHex), accessId: v.accessId }).get(v.state.key)).rejects.toThrow();
    await raw.put('webhooks', unhex(v.state.envelopeHex).slice(0, 20));
    await expect(good.get('webhooks')).rejects.toThrow();
  });

  it('les octets bruts (blocs, morceaux d’état) font l’aller-retour ; les clés host:* restent au service', async () => {
    const raw = new MemoryDoStorage();
    const sealed = new SealedStorage(raw, { crypto: storeCrypto, kBox, accessId: v.accessId });
    const bytes = Uint8Array.from([1, 2, 3, 250]);
    await sealed.put({ 'state#0': bytes, n: 3 });
    expect(await sealed.get('state#0')).toEqual(bytes);
    expect(await sealed.get('n')).toBe(3);
    await expect(sealed.put('host:meta', 1)).rejects.toThrow();
    await raw.put('host:meta', { clair: true });
    expect([...(await sealed.list()).keys()].sort()).toEqual(['n', 'state#0']);
  });
});
