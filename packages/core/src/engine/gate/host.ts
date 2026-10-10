// Écrit dans filarr-gate (origine) — cœur pur, à recopier tel quel par filarg (lot B2) et le service hébergé.
/**
 * La boîte hébergée par Filarr — contrat `gate-heberge-1` § 2.1 et § 7.1.
 *
 * - Le scellé du jeton (§ 2.1) : clair JSON canonique `{ a, k, s?, t, v: 1 }`,
 *   scellé vers `HOST_ENC` par `sealToPublicKey` (le scellé de `userKeypair`,
 *   `sealToKey` d'`apiAccess`, sans changement). Le service refuse un scellé
 *   dont `a` n'est pas l'accès qu'il sert ou dont `k` n'est pas la clé qui l'ouvre.
 * - `K_box` (§ 7.1) : HKDF-SHA256(ikm = secret du jeton, sel = accessId (16 o),
 *   info `filarr/gate-host/v1|box`, 32 o), et l'AAD de l'état au repos :
 *   `"filarr/gate-host/v1|state|" + accessId + "|" + clé` ; l'enveloppe d'une entrée stockée est
 *   `IV (12 o) ‖ chiffré ‖ étiquette GCM (16 o)` (§ 16 bis, PH3).
 *
 * Vecteurs : `test/vectors/gate-heberge-1-gate.vectors.json` (familles 2 et 8),
 * écrits par une référence en Node seul (`scripts/gen-gate-heberge-1-gate-vectors.mjs`).
 * Cœur portable : hachage, HKDF et AES-GCM par le `StoreCrypto` du magasin,
 * courbes par `AccessCurves`. Le source passe sous `strict`.
 */

import { openSealedBox, parseAccessToken, sealToKey, type AccessCurves } from '../store/apiAccess';
import { canonicalJson } from '../store/canonical';
import { concatBytes, utf8Decode, utf8Encode, type StoreCrypto } from '../store/crypto';

const HOST_INFO = 'filarr/gate-host/v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Le clair du jeton scellé. `s` : le paquet `gate-settings-1` initial (§ 8.6), facultatif. */
export interface SealedTokenPlain {
  a: string;
  k: string;
  s?: Record<string, unknown>;
  t: string;
  v: 1;
}

/** JSON UTF-8 canonique (clés triées, sans espace) du clair. */
export function sealedTokenPlaintext(plain: SealedTokenPlain): string {
  return canonicalJson(plain);
}

/** `sealedToken` : le clair scellé vers la clé publique `HOST_ENC` (base64 standard). */
export function sealToken(
  c: StoreCrypto,
  curves: AccessCurves,
  plain: SealedTokenPlain,
  hostEncPublicKey: string,
  fixed?: { ephemeralPriv: Uint8Array; iv: Uint8Array }
): Promise<string> {
  return sealToKey(c, curves, hostEncPublicKey, utf8Encode(sealedTokenPlaintext(plain)), fixed);
}

/**
 * Ouvre un jeton scellé avec la clé privée `HOST_ENC` d'identifiant `expected.keyId`,
 * pour l'accès `expected.accessId`. Lève si le scellé ne s'ouvre pas, si ce n'est pas
 * un clair de version 1, si `a` ou `k` ne sont pas ceux attendus, ou si `t` n'est pas
 * un jeton de cet accès.
 */
export async function openSealedToken(
  c: StoreCrypto,
  curves: AccessCurves,
  hostEncPriv: Uint8Array,
  sealed: string,
  expected: { accessId: string; keyId: string }
): Promise<SealedTokenPlain> {
  const parsed: unknown = JSON.parse(utf8Decode(await openSealedBox(c, curves, hostEncPriv, sealed)));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('jeton scellé illisible');
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) throw new Error(`jeton scellé de version inconnue (${String(p.v)})`);
  if (p.a !== expected.accessId) throw new Error('jeton scellé d’un autre accès');
  if (p.k !== expected.keyId) throw new Error('jeton scellé pour une autre clé du service');
  if (typeof p.t !== 'string' || parseAccessToken(p.t)?.accessId !== expected.accessId) {
    throw new Error('le jeton scellé n’est pas un jeton de cet accès');
  }
  if (p.s !== undefined && (typeof p.s !== 'object' || p.s === null || Array.isArray(p.s))) {
    throw new Error('réglages initiaux illisibles');
  }
  return p as unknown as SealedTokenPlain;
}

/** `K_box` : la clé de l'état de la boîte, tirée du secret du jeton. N'existe qu'en mémoire. */
export function deriveBoxKey(c: StoreCrypto, accessIdBytes: Uint8Array, secret: Uint8Array): Promise<Uint8Array> {
  return c.hkdf(secret, accessIdBytes, `${HOST_INFO}|box`, KEY_BYTES);
}

/** L'AAD d'une entrée de l'état au repos (AES-256-GCM sous `K_box`). */
export function stateAad(accessId: string, key: string): Uint8Array {
  return utf8Encode(`${HOST_INFO}|state|${accessId}|${key}`);
}

/** Chiffre une entrée de l'état sous `K_box` : l'enveloppe `IV ‖ chiffré ‖ étiquette`. L'IV n'est imposable que pour les vecteurs. */
export async function sealState(
  c: StoreCrypto,
  kBox: Uint8Array,
  accessId: string,
  key: string,
  plaintext: Uint8Array,
  fixedIv?: Uint8Array
): Promise<Uint8Array> {
  const iv = fixedIv ?? c.randomBytes(IV_BYTES);
  return concatBytes(iv, await c.aesGcmEncrypt(kBox, iv, plaintext, stateAad(accessId, key)));
}

/** Ouvre une enveloppe de l'état ; lève si elle est tronquée, altérée, ou d'une autre clé ou d'un autre accès. */
export function openState(c: StoreCrypto, kBox: Uint8Array, accessId: string, key: string, envelope: Uint8Array): Promise<Uint8Array> {
  if (envelope.length < IV_BYTES + TAG_BYTES) throw new Error('entrée d’état tronquée');
  return c.aesGcmDecrypt(kBox, envelope.slice(0, IV_BYTES), envelope.slice(IV_BYTES), stateAad(accessId, key));
}
