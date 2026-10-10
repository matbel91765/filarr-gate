// Écrit dans filarr-gate (origine) — cœur pur, à recopier tel quel par filarg (lot B2).
/**
 * Les scellés d'une synchro externe — contrat `source-externe-1` § 6.1, § 6.12, § 9.2.
 *
 * - État et file publiés, décisions : sous `K_xs(e, g) = HKDF(K_db(e, g), sel =
 *   storeId, info = "filarr/extsrc/v1|status")`, lisible par TOUT lecteur de la
 *   base (membres, boîte), jamais par le serveur ;
 * - ombre (et file) chez l'exécutant : sous `K_shadow = HKDF(K_db(e, g), sel =
 *   storeId, info = "filarr/extsrc/v1|shadow|" + defId)`.
 *
 * Forme d'un scellé : base64url de `IV(12) ‖ AES-256-GCM(JSON, AAD)`, avec `e` et
 * `g` en clair à côté. AAD :
 *  - état : `filarr/extsrc/v1|status|<storeId>|<runnerId>|<rev>` (§ 9.2) ;
 *  - décision : `filarr/extsrc/v1|resolve|<storeId>|<runnerId>` (§ 6.12) ;
 *  - file publiée : `filarr/extsrc/v1|queue|<storeId>|<runnerId>|<rev>` (le contrat dit
 *    « sous K_xs » sans nommer l'AAD : précision prise ici, sur le modèle de l'état) ;
 *  - ombre : `filarr/extsrc/v1|shadow|<storeId>|<defId>` (§ 6.1).
 */

import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode, concatBytes, type StoreCrypto } from '../store/crypto';

const IV = 12;

export async function statusKey(c: StoreCrypto, kDb: Uint8Array, storeId: string): Promise<Uint8Array> {
  return c.hkdf(kDb, utf8Encode(storeId), 'filarr/extsrc/v1|status', 32);
}

export async function shadowKey(c: StoreCrypto, kDb: Uint8Array, storeId: string, defId: string): Promise<Uint8Array> {
  return c.hkdf(kDb, utf8Encode(storeId), `filarr/extsrc/v1|shadow|${defId}`, 32);
}

export const statusAad = (storeId: string, runnerId: string, rev: number): string => `filarr/extsrc/v1|status|${storeId}|${runnerId}|${rev}`;
export const queueAad = (storeId: string, runnerId: string, rev: number): string => `filarr/extsrc/v1|queue|${storeId}|${runnerId}|${rev}`;
export const resolveAad = (storeId: string, runnerId: string): string => `filarr/extsrc/v1|resolve|${storeId}|${runnerId}`;
export const shadowAad = (storeId: string, defId: string): string => `filarr/extsrc/v1|shadow|${storeId}|${defId}`;

/** Scelle un JSON sous une clé et une AAD : base64url de `IV ‖ chiffré ‖ étiquette`. `iv` imposable (vecteurs). */
export async function sealJson(c: StoreCrypto, key: Uint8Array, value: unknown, aad: string, iv?: Uint8Array): Promise<string> {
  const nonce = iv ?? c.randomBytes(IV);
  const ct = await c.aesGcmEncrypt(key, nonce, utf8Encode(JSON.stringify(value)), utf8Encode(aad));
  return toBase64Url(concatBytes(nonce, ct));
}

/** Ouvre un scellé ; lève si la clé, l'AAD ou le corps ne correspondent pas. */
export async function openJson<T = unknown>(c: StoreCrypto, key: Uint8Array, sealed: string, aad: string): Promise<T> {
  const blob = fromBase64Url(sealed);
  if (blob.length < IV + 16) throw new Error('scellé trop court');
  const plain = await c.aesGcmDecrypt(key, blob.slice(0, IV), blob.slice(IV), utf8Encode(aad));
  return JSON.parse(utf8Decode(plain)) as T;
}
