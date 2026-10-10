#!/usr/bin/env node
/**
 * VECTEURS `gate-heberge-1` (familles 2, 8, 9) — implémentation de RÉFÉRENCE, À PART.
 *
 * Contrat : `gate-heberge-1.md` § 16. filarr-gate en est l'ORIGINE (les familles 1, 3, 4, 5, 7 viennent de
 * filarg, la 6 de `scripts/build-vectors.ts`). Ce script ne réutilise RIEN du dépôt : Node seul (`node:crypto`
 * pour X25519, Ed25519, HKDF, AES-GCM, SHA). Les essais (`test/hebergeGateVectors.test.ts`) rejouent le fichier
 * par le cœur (`packages/core/src/engine/gate/host.ts`, sous WebCrypto et sous le crypto de Node) et par la
 * vérification de la chaîne de publication (`scripts/release/tag-check.mjs`, `scripts/release/journal.mjs`).
 *
 *   2. le scellé du jeton (§ 2.1) : clair canonique `{ a, k, s?, t, v }`, scellé FIXE vers une paire `HOST_ENC`
 *      de test (éphémère et IV imposés), son ouverture ; refus d'un `a`, d'un `k`, d'une autre clé, d'un `t`
 *      d'un autre accès, d'un scellé altéré ;
 *   8. `K_box` = HKDF-SHA256(secret, sel = accessId (16 o), info "filarr/gate-host/v1|box", 32 o) et l'AAD de
 *      l'état `"filarr/gate-host/v1|state|" + accessId + "|" + clé`, avec un chiffré AES-256-GCM d'exemple ;
 *   9. l'étiquette de sécurité (§ 10.1) : objets d'étiquette git signés en SSH (SSHSIG, Ed25519, espace « git »),
 *      un correctif accepté, des correctifs ramenés à l'ordinaire (rôle, avis absent, lignes manquantes), des
 *      étiquettes refusées, et une entrée du journal public de chaque sorte.
 *
 * Toutes les clés sont des clés de TEST tirées de graines fixes. Sortie DÉTERMINISTE (X25519 et Ed25519 le sont,
 * l'aléa des scellés est imposé).
 *
 *   node scripts/gen-gate-heberge-1-gate-vectors.mjs      (écrit test/vectors/gate-heberge-1-gate.vectors.json)
 */

import {
  createCipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  sign,
} from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT = resolve(HERE, '../test/vectors/gate-heberge-1-gate.vectors.json');

// ── Octets ────────────────────────────────────────────────────────────────

const hex = (buf) => Buffer.from(buf).toString('hex');
const b64 = (buf) => Buffer.from(buf).toString('base64');
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const utf8 = (s) => Buffer.from(s, 'utf8');
const sha256 = (data) => createHash('sha256').update(data).digest();
/** Les graines fixes de filarg (`gen-gate-heberge-1-vectors.mjs`) : même jeton que la famille 4. */
const fixed = (seed, n) => Buffer.from(Array.from({ length: n }, (_, i) => (seed * 31 + i * 7 + 3) & 255));
const hkdf = (ikm, salt, info, n) => Buffer.from(hkdfSync('sha256', ikm, salt, utf8(info), n));

/** JSON canonique de db-store-1 § 5.2 : clés en ordre des unités de code, aucun espace. */
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

// X25519 et Ed25519 à partir de 32 octets bruts (PKCS#8 / SPKI), sans bibliothèque tierce
const PKCS8 = { x25519: '302e020100300506032b656e04220420', ed25519: '302e020100300506032b657004220420' };
const SPKI = { x25519: '302a300506032b656e032100', ed25519: '302a300506032b6570032100' };
function keyFromSeed(kind, seed) {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from(PKCS8[kind], 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return { privateKey, publicKey: Buffer.from(spki.subarray(spki.length - 32)) };
}
const x25519Public = (raw) => createPublicKey({ key: Buffer.concat([Buffer.from(SPKI.x25519, 'hex'), raw]), format: 'der', type: 'spki' });

function aesGcm(key, iv, plaintext, aad) {
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}

/** `sealToPublicKey` de `userKeypair` : base64std(éph_pub ‖ IV ‖ AES-256-GCM(KEK, IV, clair, AAD vide)). */
function seal(recipientPub, plaintext, ephSeed, iv) {
  const eph = keyFromSeed('x25519', ephSeed);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: x25519Public(recipientPub) });
  const kek = hkdf(shared, Buffer.concat([eph.publicKey, recipientPub]), 'filarr.userkey.seal.v1', 32);
  return b64(Buffer.concat([eph.publicKey, iv, aesGcm(kek, iv, utf8(plaintext), Buffer.alloc(0))]));
}

// ── Le jeton fixe (celui de la famille 4) ──────────────────────────────────

const accessIdBytes = fixed(21, 16);
const secret = fixed(22, 32);
const accessId = b64url(accessIdBytes);
const token = `flr_live_${accessId}_${b64url(secret)}`;
const otherAccessIdBytes = fixed(23, 16);
const otherSecret = fixed(24, 32);
const otherAccessId = b64url(otherAccessIdBytes);
const otherToken = `flr_live_${otherAccessId}_${b64url(otherSecret)}`;

// ── 2. Le scellé du jeton ──────────────────────────────────────────────────

function family2() {
  const hostSeed = fixed(31, 32);
  const host = keyFromSeed('x25519', hostSeed);
  const otherHostSeed = fixed(32, 32);
  const otherHost = keyFromSeed('x25519', otherHostSeed);
  const keyId = 'h-scelle-test';
  const randomness = { ephemeralPrivHex: hex(fixed(41, 32)), ivHex: hex(fixed(42, 12)) };
  const sealPlain = (plain, pub = host.publicKey) =>
    seal(pub, canonical(plain), Buffer.from(randomness.ephemeralPrivHex, 'hex'), Buffer.from(randomness.ivHex, 'hex'));
  const initialSettings = {
    v: 1,
    kind: 'filarr-gate/settings',
    accessId,
    createdAt: '2026-10-10T12:00:00.000Z',
    appKeys: [
      {
        id: '3b0e8f4a-6c2d-4e1f-9a7b-5d4c3b2a1f0e',
        name: 'Première clé',
        hash: hex(sha256(utf8('gk_live_cle-de-test-jamais-servie'))),
        scopes: [{ target: 'all', read: true }],
      },
    ],
    webhooks: [],
    queries: [],
    extdb: [],
    files: { filter: { deny: [], maxBytes: 104857600 } },
    settings: { cors: [], write: false },
  };
  const cases = [
    { why: 'création : s porte la première clé d’application (§ 6.1)', plain: { a: accessId, k: keyId, s: initialSettings, t: token, v: 1 } },
    { why: 'migration vers l’hébergée : s vide', plain: { a: accessId, k: keyId, s: {}, t: token, v: 1 } },
    { why: 's absent (facultatif)', plain: { a: accessId, k: keyId, t: token, v: 1 } },
  ].map((c) => ({ ...c, plaintext: canonical(c.plain), sealed: sealPlain(c.plain) }));
  const base = cases[2].plain;
  const altered = Buffer.from(cases[2].sealed, 'base64');
  altered[altered.length - 1] ^= 1;
  return {
    famille: 2,
    lecture:
      'Clair JSON UTF-8 canonique { a, k, s?, t, v: 1 } ; sealedToken = sealToPublicKey(clair, HOST_ENC.encPublicKey) = ' +
      'base64std(éph_pub (32) ‖ IV (12) ‖ AES-256-GCM(KEK, IV, clair, AAD vide)), KEK = HKDF-SHA256(X25519(éph, HOST_ENC), ' +
      'sel = éph_pub ‖ HOST_ENC_pub, info "filarr.userkey.seal.v1", 32 o). L’aléa (éphémère, IV) est imposé pour les vecteurs ; ' +
      'on vérifie l’ouverture, et que le scellement à aléa imposé redonne les mêmes octets. Le service attend { accessId, keyId } ' +
      'et refuse un a, un k, un t d’un autre accès, un scellé vers une autre clé ou altéré.',
    token,
    accessId,
    hostKey: { id: keyId, encPrivateKeyHex: hex(hostSeed), encPublicKey: b64(host.publicKey) },
    otherHostKey: { id: 'h-autre-test', encPrivateKeyHex: hex(otherHostSeed), encPublicKey: b64(otherHost.publicKey) },
    randomness,
    expected: { accessId, keyId },
    accepted: cases,
    refused: [
      { why: 'a d’un autre accès', sealed: sealPlain({ ...base, a: otherAccessId }) },
      { why: 'k d’une autre clé du service', sealed: sealPlain({ ...base, k: 'h-autre-test' }) },
      { why: 't : le jeton d’un autre accès', sealed: sealPlain({ ...base, t: otherToken }) },
      { why: 'v inconnu', sealed: sealPlain({ ...base, v: 2 }) },
      { why: 'scellé vers une autre clé du service', sealed: sealPlain(base, otherHost.publicKey) },
      { why: 'scellé altéré (dernier octet de l’étiquette GCM)', sealed: b64(altered) },
    ],
  };
}

// ── 8. K_box et l'AAD de l'état ────────────────────────────────────────────

function family8() {
  const derive = (id, s) => hkdf(s, id, 'filarr/gate-host/v1|box', 32);
  const kBox = derive(accessIdBytes, secret);
  const aad = (id, key) => `filarr/gate-host/v1|state|${id}|${key}`;
  const keys = ['appKeys', 'webhooks', 'queries', 'extdb/3b0e8f4a', 'blocks/AAAAAAAAAAAAAAAAAAAAAA/0'];
  const plaintext = canonical([{ id: '6c1f0a9e', secret: 'whsec_' + 'b'.repeat(43), url: 'https://erp.example.test/hooks/filarr' }]);
  const iv = fixed(51, 12);
  return {
    famille: 8,
    lecture:
      'K_box = HKDF-SHA256(ikm = secret du jeton (32 o), sel = accessId (16 o, décodé du base64url), info = "filarr/gate-host/v1|box", 32 o). ' +
      'AAD d’une entrée de l’état = UTF-8("filarr/gate-host/v1|state|" + accessId (base64url, 22 car.) + "|" + clé). ' +
      'L’exemple chiffre une entrée par AES-256-GCM sous K_box (chiffré ‖ étiquette de 16 o) ; l’enveloppe de stockage (où va l’IV) n’est pas gelée.',
    token,
    accessId,
    secretHex: hex(secret),
    kBoxHex: hex(kBox),
    otherToken,
    otherKBoxHex: hex(derive(otherAccessIdBytes, otherSecret)),
    aad: keys.map((key) => ({ key, aad: aad(accessId, key), aadHex: hex(utf8(aad(accessId, key))) })),
    state: { key: 'webhooks', ivHex: hex(iv), plaintext, ciphertextHex: hex(aesGcm(kBox, iv, utf8(plaintext), utf8(aad(accessId, 'webhooks')))) },
    refused: [
      { why: 'AAD d’une autre clé de l’état', aad: aad(accessId, 'queries') },
      { why: 'AAD d’un autre accès', aad: aad(otherAccessId, 'webhooks') },
      { why: 'K_box d’un autre jeton', kBoxHex: hex(derive(otherAccessIdBytes, otherSecret)) },
    ],
  };
}

// ── 9. L'étiquette de sécurité et le journal public ────────────────────────

const sshString = (data) => {
  const b = Buffer.from(data);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length, 0);
  return Buffer.concat([len, b]);
};
const sshEd25519Blob = (pub) => Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);

/** `ssh-keygen -Y sign -n git` (PROTOCOL.sshsig), Ed25519, SHA-512, armuré à 70 colonnes. */
function sshsig(key, message) {
  const digest = createHash('sha512').update(utf8(message)).digest();
  const signed = Buffer.concat([Buffer.from('SSHSIG'), sshString('git'), sshString(''), sshString('sha512'), sshString(digest)]);
  const sig = sign(null, signed, key.privateKey);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1, 0);
  const blob = Buffer.concat([
    Buffer.from('SSHSIG'),
    version,
    sshString(sshEd25519Blob(key.publicKey)),
    sshString('git'),
    sshString(''),
    sshString('sha512'),
    sshString(Buffer.concat([sshString('ssh-ed25519'), sshString(sig)])),
  ]);
  const body = b64(blob).match(/.{1,70}/g).join('\n');
  return `-----BEGIN SSH SIGNATURE-----\n${body}\n-----END SSH SIGNATURE-----\n`;
}

function family9() {
  const roles = {
    release: { principal: 'release:essai', seed: fixed(61, 32) },
    security: { principal: 'security:essai', seed: fixed(62, 32) },
    intrus: { principal: null, seed: fixed(63, 32) },
  };
  const keys = Object.fromEntries(Object.entries(roles).map(([r, v]) => [r, keyFromSeed('ed25519', v.seed)]));
  const openssh = (r) => `ssh-ed25519 ${b64(sshEd25519Blob(keys[r].publicKey))}`;
  const signersFile =
    '# Signataires de TEST (graines fixes des vecteurs gate-heberge-1, famille 9) — jamais une vraie clé.\n' +
    `release:essai namespaces="git" ${openssh('release')}\n` +
    `security:essai namespaces="git" ${openssh('security')}\n`;
  const commit = '1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c';
  const advisory = 'GHSA-2f9x-4c7m-q8vr';
  const unknownAdvisory = 'GHSA-7hj3-xv2p-9wqc';
  const T = 1792195200; // 2026-10-17T00:00:00Z
  const tagObject = ({ tag, message, by = 'security', signedName, signer, sign: doSign = true, alter }) => {
    const who = by === 'release' ? 'Filarr Release Test <release@example.test>' : 'Filarr Security Test <security@example.test>';
    const payload = `object ${commit}\ntype commit\ntag ${signedName ?? tag}\ntagger ${who} ${T} +0000\n\n${message}`;
    if (!doSign) return payload;
    const signature = sshsig(keys[signer ?? by], payload);
    return (alter ? alter(payload) : payload) + signature;
  };
  const fix = 'Filarr Gate 0.2.1 : correctif de sécurité\n\n';
  const trailersOk = `Filarr-Release-Kind: security\nFilarr-Advisory: ${advisory}\n`;
  const t = (why, input, expected) => ({ why, tag: input.tag, raw: tagObject(input), expected });
  const ok = (tag, extra) => ({ ok: true, tag, version: tag.slice(1).replace('-security', ''), commit, ...extra });
  const sec = 'v0.2.1-security';
  const security = [
    t('correctif de sécurité accepté', { tag: sec, message: fix + trailersOk }, ok(sec, { principal: 'security:essai', role: 'security', kind: 'security', security: { advisory } })),
  ];
  const fallback = (why, input, refused) =>
    t(why, { tag: sec, ...input }, ok(sec, { principal: `${input.signer ?? input.by ?? 'security'}:essai`, role: input.signer ?? input.by ?? 'security', kind: 'release', security: { refused } }));
  const securityRefused = [
    fallback('rôle ordinaire : signée par la clé de publication', { by: 'release', message: fix + trailersOk }, 'role'),
    fallback('avis absent du dépôt', { message: fix + `Filarr-Release-Kind: security\nFilarr-Advisory: ${unknownAdvisory}\n` }, 'advisory-unknown'),
    fallback('ligne manquante : Filarr-Release-Kind', { message: fix + `Filarr-Advisory: ${advisory}\n` }, 'kind-line-missing'),
    fallback('ligne manquante : Filarr-Advisory', { message: fix + 'Filarr-Release-Kind: security\n' }, 'advisory-line-missing'),
    fallback('lignes hors du dernier paragraphe', { message: `Filarr Gate 0.2.1\n\n${trailersOk}\nNotes de version.\n` }, 'kind-line-missing'),
  ];
  const ordinary = [
    t('publication ordinaire', { tag: 'v0.2.0', by: 'release', message: 'Filarr Gate 0.2.0\n' }, ok('v0.2.0', { principal: 'release:essai', role: 'release', kind: 'release' })),
  ];
  const refused = [
    t('non signée', { tag: 'v0.2.0', by: 'release', message: 'Filarr Gate 0.2.0\n', sign: false }, { ok: false, tag: 'v0.2.0', refused: 'unsigned' }),
    t('message modifié après signature', { tag: 'v0.2.0', by: 'release', message: 'Filarr Gate 0.2.0\n', alter: (p) => p.replace('Filarr Gate 0.2.0', 'Filarr Gate 0.2.9') }, { ok: false, tag: 'v0.2.0', refused: 'signature-invalid' }),
    t('clé absente de release-signers', { tag: 'v0.2.0', by: 'release', signer: 'intrus', message: 'Filarr Gate 0.2.0\n' }, { ok: false, tag: 'v0.2.0', refused: 'signer-unknown' }),
    t('objet signé sous un autre nom', { tag: 'v0.2.0', by: 'release', signedName: 'v0.1.9', message: 'Filarr Gate 0.1.9\n' }, { ok: false, tag: 'v0.2.0', refused: 'tag-mismatch' }),
    t('nom hors de vX.Y.Z', { tag: 'v0.2.0-rc.1', by: 'release', message: 'Filarr Gate 0.2.0-rc.1\n' }, { ok: false, tag: 'v0.2.0-rc.1', refused: 'tag-name' }),
  ];
  const sums = `${'d2'.repeat(32)}  library/filarr-gate-0.2.0.tgz\n${'c1'.repeat(32)}  cli/filarr-gate-0.2.0.tgz\n`;
  const codeHash = `sha256:${hex(sha256(utf8(sums)))}`;
  const entry = (e) => ({ entry: e, line: canonical(e) });
  return {
    famille: 9,
    lecture:
      'Étiquette = objet d’étiquette git annoté, signé en SSH par git (gpg.format ssh) : la signature SSHSIG (Ed25519, espace « git », SHA-512, ' +
      'armurée à 70 colonnes) porte sur l’objet sans elle et lui est collée. release-signers = allowed_signers d’OpenSSH, principal « release:<nom> » ' +
      'ou « security:<nom> ». Correctif : nom vX.Y.Z-security, rôle security, dernier paragraphe du message avec Filarr-Release-Kind: security et ' +
      'Filarr-Advisory: <GHSA>, avis existant (knownAdvisories). Une condition manque : publication ordinaire (security.refused). Journal : une entrée ' +
      'par ligne en JSON canonique ; codeHash = "sha256:" + hex(SHA-256(SHA256SUMS)) ; deployed au moins 7 j après publishedAt ; security : publishedAt = deployedAt.',
    namespace: 'git',
    hashAlgorithm: 'sha512',
    signers: Object.fromEntries(Object.entries(roles).map(([r, v]) => [r, { principal: v.principal, seedHex: hex(v.seed), publicKey: openssh(r) }])),
    signersFile,
    sha256sums: sums,
    knownAdvisories: [advisory],
    tags: { security, ordinary, securityRefused, refused },
    journal: {
      published: entry({ codeHash, commit, kind: 'published', publishedAt: '2026-10-17T00:05:12.000Z', tag: 'v0.2.0', version: '0.2.0' }),
      deployed: entry({ codeHash, commit, deployedAt: '2026-10-24T09:00:00.000Z', kind: 'deployed', publishedAt: '2026-10-17T00:05:12.000Z', tag: 'v0.2.0', version: '0.2.0' }),
      security: entry({
        advisory,
        codeHash,
        commit,
        deployedAt: '2026-10-18T14:30:00.000Z',
        kind: 'security',
        note: 'correctif de sécurité, délai de sept jours levé',
        publishedAt: '2026-10-18T14:30:00.000Z',
        severity: 'high',
        tag: sec,
        version: '0.2.1',
      }),
      refused: [
        { why: 'mise en service six jours après la publication', entry: { codeHash, commit, deployedAt: '2026-10-23T00:05:12.000Z', kind: 'deployed', publishedAt: '2026-10-17T00:05:12.000Z', tag: 'v0.2.0', version: '0.2.0' } },
        { why: 'correctif sans avis', entry: { codeHash, commit, deployedAt: '2026-10-18T14:30:00.000Z', kind: 'security', note: 'correctif de sécurité, délai de sept jours levé', publishedAt: '2026-10-18T14:30:00.000Z', severity: 'high', tag: sec, version: '0.2.1' } },
        { why: 'correctif publié sous une étiquette ordinaire', entry: { advisory, codeHash, commit, deployedAt: '2026-10-18T14:30:00.000Z', kind: 'security', note: 'correctif de sécurité, délai de sept jours levé', publishedAt: '2026-10-18T14:30:00.000Z', severity: 'high', tag: 'v0.2.1', version: '0.2.1' } },
      ],
    },
  };
}

export function buildHebergeGateVectors() {
  return {
    contrat: 'gate-heberge-1 § 16 (familles 2, 8, 9)',
    origine: 'filarr-gate',
    lecture:
      'Produit par scripts/gen-gate-heberge-1-gate-vectors.mjs (référence en Node seul). Familles 1, 3, 4, 5, 7 : gate-heberge-1.vectors.json (origine filarg) ; ' +
      'famille 6 : gate-settings-1.vectors.json. Le jeton est celui de la famille 4. Clés de TEST seulement.',
    sealedToken: family2(),
    box: family8(),
    securityTag: family9(),
  };
}

export const formatHebergeGateVectors = (v) => JSON.stringify(v, null, 2) + '\n';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(OUT, formatHebergeGateVectors(buildHebergeGateVectors()), 'utf8');
  process.stdout.write(`vecteurs écrits : ${OUT}\n`);
}
