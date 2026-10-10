// Écrit dans filarr-gate (origine) — à recopier par filarg (lot B2), avec le fichier de vecteurs.
/**
 * Les vecteurs de `gate-fichiers-1` (§ 14) que porte la boîte noire, et leur
 * rejoueur :
 *  4. manifeste : un dépôt `gate` FIXE (clé de boîte de test, K_file, IV et
 *     éphémère imposés) et son clair ; le lecteur d'avant ce contrat le lit
 *     (champs requis seuls) ;
 *  5. `boxSig` : message, signature vérifiable, refus d'une autre clé de boîte ;
 *  6. `outcome` : un scellé fixe et son clair ;
 *  + le filtre (§ 3) : extensions, signatures d'exécutables, taille.
 * Les familles 1 (placement), 2 (chemins), 3 (nettoyage) et 7 (trousseau) sont
 * celles de l'appli qui range : elles vivent dans filarg.
 */

import {
  DEPOSIT_CHUNK_SIZE,
  boxSigMessage,
  checkFile,
  DEFAULT_FILE_FILTER,
  manifestJson,
  openDeposit,
  openOutcome,
  sealDeposit,
  sealOutcome,
  verifyBoxSig,
  type GateOutcome,
} from '../../packages/core/src/engine/gate/files';
import { toBase64Std, type AccessCurves } from '../../packages/core/src/engine/store/apiAccess';
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode, type StoreCrypto } from '../../packages/core/src/engine/store/crypto';

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string): Uint8Array => new Uint8Array((s.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const fill = (n: number, len: number) => hex(new Uint8Array(len).fill(n));

const BOX_PRIV = fill(0x21, 32);
const OTHER_BOX_PRIV = fill(0x22, 32);
const CREATOR_SIGNING = fill(0x31, 32);
const ACCESS_ID = 'acc_AAAAAAAAAAAAAAAAAAAAAA';
const REQUEST_ID = 'req_BBBBBBBBBBBBBBBBBBBBBB';

export interface GateFilesVectors {
  contrat: 'gate-fichiers-1';
  origine: string;
  lecture: string;
  boite: { privateKeyHex: string; publicKey: string };
  manifeste: {
    fixed: { fileKeyHex: string; manifestIvHex: string; chunkIvsHex: string[]; ephemeralPrivHex: string; sealIvHex: string };
    contentUtf8: string;
    meta: { fileName: string; mimeType: string; path: string; tags: string[]; source: string; accessName: string; depositedAt: string };
    manifestJson: string;
    deposit: { sealedFileKey: string; encryptedManifest: string; encryptedManifestIv: string; totalChunks: number; sizeBytes: number; chunks: string[] };
    minimal: { meta: { fileName: string; mimeType: string; depositedAt: string }; manifestJson: string };
    requiredFields: string[];
  };
  boxSig: { creatorSigningKeyHex: string; creatorPublicKey: string; accessId: string; requestId: string; message: string; boxSig: string; otherBoxPublicKey: string; verifyOther: boolean };
  outcome: { ephemeralPrivHex: string; ivHex: string; plain: GateOutcome; sealed: string };
  filtre: Array<{ name: string; headHex: string; size: number; refusal: unknown }>;
}

export async function buildGateFilesVectors(c: StoreCrypto, curves: AccessCurves): Promise<GateFilesVectors> {
  const boxPub = toBase64Url(curves.x25519PublicKey(unhex(BOX_PRIV)));
  const fixed = { fileKeyHex: fill(0x41, 32), manifestIvHex: fill(0x51, 12), chunkIvsHex: [fill(0x61, 12)], ephemeralPrivHex: fill(0x71, 32), sealIvHex: fill(0x81, 12) };
  const content = 'Facture 2291 — 1 250,00 €\n';
  const meta = { fileName: 'facture-2291.pdf', mimeType: 'application/pdf', path: 'Factures/2026', tags: ['fournisseur', 'urgent'], source: 'erp', accessName: 'ERP Atelier', depositedAt: '2026-10-10T12:00:00.000Z' };
  const dep = await sealDeposit(c, curves, utf8Encode(content), meta, boxPub, {
    fileKey: unhex(fixed.fileKeyHex),
    manifestIv: unhex(fixed.manifestIvHex),
    chunkIvs: fixed.chunkIvsHex.map(unhex),
    ephemeralPriv: unhex(fixed.ephemeralPrivHex),
    sealIv: unhex(fixed.sealIvHex),
  });
  const minimalMeta = { fileName: 'note.txt', mimeType: 'text/plain', depositedAt: '2026-10-10T12:00:00.000Z' };
  const minimal = await sealDeposit(c, curves, utf8Encode('x'), minimalMeta, boxPub, {
    fileKey: unhex(fixed.fileKeyHex),
    manifestIv: unhex(fixed.manifestIvHex),
    chunkIvs: fixed.chunkIvsHex.map(unhex),
    ephemeralPriv: unhex(fixed.ephemeralPrivHex),
    sealIv: unhex(fixed.sealIvHex),
  });

  const signing = unhex(CREATOR_SIGNING);
  const message = boxSigMessage(ACCESS_ID, REQUEST_ID, boxPub);
  const boxSig = toBase64Url(curves.ed25519Sign(signing, message));
  const otherBoxPub = toBase64Url(curves.x25519PublicKey(unhex(OTHER_BOX_PRIV)));
  const creatorPublicKey = toBase64Std(curves.ed25519PublicKey(signing));

  const outcome: GateOutcome = { v: 1, result: 'filed', folder: 'Factures/2026', name: 'facture-2291.pdf', rule: 'r_factures', by: 'PC-Atelier', filedAt: '2026-10-10T12:00:05.000Z', sha256Verified: true };
  const oFixed = { ephemeralPrivHex: fill(0x91, 32), ivHex: fill(0xa1, 12) };
  const sealedOutcome = await sealOutcome(c, curves, boxPub, outcome, { ephemeralPriv: unhex(oFixed.ephemeralPrivHex), iv: unhex(oFixed.ivHex) });

  const filtre = [
    { name: 'rapport.pdf', head: utf8Encode('%PDF-1.7'), size: 8 },
    { name: 'outil.exe', head: new Uint8Array([1, 2, 3]), size: 3 },
    { name: 'Setup.MSI', head: new Uint8Array([1]), size: 1 },
    { name: 'archive.tar.gz', head: new Uint8Array([0x1f, 0x8b]), size: 2 },
    { name: 'rapport.pdf', head: new Uint8Array([0x4d, 0x5a, 0x90, 0]), size: 4 },
    { name: 'image.png', head: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), size: 4 },
    { name: 'binaire', head: new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]), size: 4 },
    { name: 'script.txt', head: utf8Encode('#!/bin/sh\n'), size: 10 },
    { name: 'gros.pdf', head: utf8Encode('%PDF'), size: 100 * 1024 * 1024 + 1 },
  ].map((f) => ({ name: f.name, headHex: hex(f.head), size: f.size, refusal: checkFile(f.name, f.size, f.head, DEFAULT_FILE_FILTER) }));

  return {
    contrat: 'gate-fichiers-1',
    origine: 'filarr-gate (packages/core/src/engine/gate/files.ts), à défaut d’une implémentation dans filarg',
    lecture:
      'Familles 4, 5, 6 du § 14 et le filtre du § 3. Clés et IV en hexadécimal ; clés publiques de boîte en base64url, clé de signature du créateur en base64 standard ; ' +
      `scellés en base64 standard (éphémère ‖ IV ‖ AES-256-GCM) ; morceaux de ${DEPOSIT_CHUNK_SIZE} octets, chacun IV ‖ chiffré ‖ étiquette, en base64url.`,
    boite: { privateKeyHex: BOX_PRIV, publicKey: boxPub },
    manifeste: {
      fixed,
      contentUtf8: content,
      meta,
      manifestJson: manifestJson(dep.manifest),
      deposit: { sealedFileKey: dep.sealedFileKey, encryptedManifest: dep.encryptedManifest, encryptedManifestIv: dep.encryptedManifestIv, totalChunks: dep.totalChunks, sizeBytes: dep.sizeBytes, chunks: dep.chunks.map(toBase64Url) },
      minimal: { meta: minimalMeta, manifestJson: manifestJson(minimal.manifest) },
      requiredFields: ['fileName', 'mimeType', 'size', 'totalChunks'],
    },
    boxSig: { creatorSigningKeyHex: CREATOR_SIGNING, creatorPublicKey, accessId: ACCESS_ID, requestId: REQUEST_ID, message: utf8Decode(message), boxSig, otherBoxPublicKey: otherBoxPub, verifyOther: verifyBoxSig(curves, creatorPublicKey, ACCESS_ID, REQUEST_ID, otherBoxPub, boxSig) },
    outcome: { ...oFixed, plain: outcome, sealed: sealedOutcome },
    filtre,
  };
}

export async function replayGateFilesVectors(c: StoreCrypto, curves: AccessCurves, v: GateFilesVectors): Promise<string[]> {
  const bad: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) bad.push(name);
  };
  const boxPriv = unhex(v.boite.privateKeyHex);
  check('clé publique de la boîte', toBase64Url(curves.x25519PublicKey(boxPriv)) === v.boite.publicKey);

  // 4. Le manifeste : refait à l'identique, puis ouvert par la boîte
  const m = v.manifeste;
  const fixed = { fileKey: unhex(m.fixed.fileKeyHex), manifestIv: unhex(m.fixed.manifestIvHex), chunkIvs: m.fixed.chunkIvsHex.map(unhex), ephemeralPriv: unhex(m.fixed.ephemeralPrivHex), sealIv: unhex(m.fixed.sealIvHex) };
  const dep = await sealDeposit(c, curves, utf8Encode(m.contentUtf8), m.meta, v.boite.publicKey, fixed);
  check('manifeste : JSON dans l’ordre du contrat', manifestJson(dep.manifest) === m.manifestJson);
  check('manifeste : K_file scellé à l’identique', dep.sealedFileKey === m.deposit.sealedFileKey);
  check('manifeste : chiffré à l’identique', dep.encryptedManifest === m.deposit.encryptedManifest && dep.encryptedManifestIv === m.deposit.encryptedManifestIv);
  check('manifeste : morceaux à l’identique', JSON.stringify(dep.chunks.map(toBase64Url)) === JSON.stringify(m.deposit.chunks));
  const opened = await openDeposit(c, curves, boxPriv, m.deposit, m.deposit.chunks.map(fromBase64Url)).catch(() => ({ manifest: {} as Record<string, unknown>, bytes: new Uint8Array(0) }));
  check('manifeste : la boîte l’ouvre', utf8Decode(opened.bytes) === m.contentUtf8 && JSON.stringify(opened.manifest) === m.manifestJson);
  // Un lecteur d'avant ce contrat ne lit que les champs requis
  const old = Object.fromEntries(m.requiredFields.map((k) => [k, opened.manifest[k]]));
  check('manifeste : lecteur d’avant (champs requis seuls)', old.fileName === m.meta.fileName && old.size === utf8Encode(m.contentUtf8).length && old.totalChunks === 1);
  const minimal = await sealDeposit(c, curves, utf8Encode('x'), m.minimal.meta, v.boite.publicKey, fixed);
  check('manifeste minimal : facultatifs omis', manifestJson(minimal.manifest) === m.minimal.manifestJson);

  // 5. boxSig
  const b = v.boxSig;
  const signing = unhex(b.creatorSigningKeyHex);
  check('boxSig : clé du créateur', toBase64Std(curves.ed25519PublicKey(signing)) === b.creatorPublicKey);
  check('boxSig : message', utf8Decode(boxSigMessage(b.accessId, b.requestId, v.boite.publicKey)) === b.message);
  check('boxSig : signature à l’identique (Ed25519 déterministe)', toBase64Url(curves.ed25519Sign(signing, boxSigMessage(b.accessId, b.requestId, v.boite.publicKey))) === b.boxSig);
  check('boxSig : vérifiée', verifyBoxSig(curves, b.creatorPublicKey, b.accessId, b.requestId, v.boite.publicKey, b.boxSig));
  check('boxSig : autre clé de boîte refusée', !verifyBoxSig(curves, b.creatorPublicKey, b.accessId, b.requestId, b.otherBoxPublicKey, b.boxSig) && b.verifyOther === false);
  check('boxSig : autre accès refusé', !verifyBoxSig(curves, b.creatorPublicKey, `${b.accessId}x`, b.requestId, v.boite.publicKey, b.boxSig));

  // 6. outcome
  const o = v.outcome;
  check('outcome : scellé à l’identique', (await sealOutcome(c, curves, v.boite.publicKey, o.plain, { ephemeralPriv: unhex(o.ephemeralPrivHex), iv: unhex(o.ivHex) })) === o.sealed);
  check('outcome : la boîte l’ouvre', JSON.stringify(await openOutcome(c, curves, boxPriv, o.sealed).catch(() => null)) === JSON.stringify(o.plain));

  // Le filtre
  for (const f of v.filtre) check(`filtre ${f.name} (${f.headHex})`, JSON.stringify(checkFile(f.name, f.size, unhex(f.headHex), DEFAULT_FILE_FILTER)) === JSON.stringify(f.refusal));
  return bad;
}
