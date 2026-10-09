// Écrit dans filarr-gate (origine) — cœur pur, à recopier tel quel par filarg (lot B2) et le mobile.
/**
 * L'accès API, révision 3 — contrat `api-base-1-rev3.md` § 1 bis et § 5 bis.
 *
 * Deux clés de plus tirées du `secret` du jeton (HKDF-SHA256, sel = `accessId`) :
 *  - `A_mac` (`filarr/api/v1|creator`) : l'ÉTIQUETTE DU CRÉATEUR. L'appareil du
 *    créateur la calcule pendant que le jeton existe en mémoire ; seule une
 *    boîte noire qui tient le jeton peut la vérifier, et le serveur ne peut pas
 *    la forger. Elle authentifie la clé de signature du créateur que le serveur
 *    sert dans `/self`, avant que la boîte n'en croie aucun objet signé
 *    (boîte de dépôt, définitions de synchro, ordres d'export) ;
 *  - `A_notify` (`filarr/api/v1|notify`) : la clé des RÉVEILS POUSSÉS. Le
 *    serveur la garde (c'est une clé de réveil, sans pouvoir de lecture) et
 *    signe chaque réveil ; la boîte vérifie la signature et l'horodatage.
 *
 * Cœur portable : le hachage passe par le `StoreCrypto` du magasin, comme le
 * reste du cœur. Le source passe sous `strict` ET `noUncheckedIndexedAccess`.
 */

import { toBase64Std } from '../store/apiAccess';
import { toBase64Url, utf8Encode, type StoreCrypto } from '../store/crypto';

const API_INFO = 'filarr/api/v1';
const KEY_BYTES = 32;

/** Écart admis entre l'horodatage d'un réveil et l'horloge de la boîte (§ 5 bis). */
export const NOTIFY_TOLERANCE_S = 300;

export interface AccessKeys3 {
  /** Clé de l'étiquette du créateur (jamais vue du serveur). */
  aMac: Uint8Array;
  /** Clé des réveils poussés (le serveur en garde une copie, base64 standard). */
  aNotify: Uint8Array;
}

/** `A_mac` et `A_notify`, à partir du `secret` et de `accessId` (16 octets). */
export async function deriveAccessKeys3(
  c: StoreCrypto,
  accessIdBytes: Uint8Array,
  secret: Uint8Array
): Promise<AccessKeys3> {
  const aMac = await c.hkdf(secret, accessIdBytes, `${API_INFO}|creator`, KEY_BYTES);
  const aNotify = await c.hkdf(secret, accessIdBytes, `${API_INFO}|notify`, KEY_BYTES);
  return { aMac, aNotify };
}

/** `notifyKey` tel que le créateur l'envoie au serveur : `A_notify` en base64 standard. */
export const notifyKeyOf = (aNotify: Uint8Array): string => toBase64Std(aNotify);

/** Le message de l'étiquette : `filarr/api/v1|creator|<accessId>|<clé de signature, base64 standard>`. */
export function creatorTagMessage(accessId: string, signingPublicKey: string): Uint8Array {
  return utf8Encode(`${API_INFO}|creator|${accessId}|${signingPublicKey}`);
}

/** `creatorTag` : base64url de HMAC-SHA256(A_mac, message), 43 caractères. */
export async function computeCreatorTag(
  c: StoreCrypto,
  aMac: Uint8Array,
  accessId: string,
  signingPublicKey: string
): Promise<string> {
  return toBase64Url(await c.hmacSha256(aMac, creatorTagMessage(accessId, signingPublicKey)));
}

/** Comparaison en temps constant de deux chaînes (même longueur exigée). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Vrai si `tag` est bien l'étiquette de `signingPublicKey` pour cet accès : la
 * clé de signature servie par le serveur est alors celle du créateur.
 */
export async function verifyCreatorTag(
  c: StoreCrypto,
  aMac: Uint8Array,
  accessId: string,
  signingPublicKey: string,
  tag: string
): Promise<boolean> {
  if (typeof tag !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(tag)) return false;
  const expected = await computeCreatorTag(c, aMac, accessId, signingPublicKey);
  return constantTimeEqual(expected, tag);
}

// ==================== Les réveils poussés (§ 5 bis) ====================

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** `v1` d'un réveil : hex de HMAC-SHA256(A_notify, `<t>.<corps brut>`). */
export async function notifySignature(
  c: StoreCrypto,
  aNotify: Uint8Array,
  t: number,
  rawBody: string
): Promise<string> {
  return toHex(await c.hmacSha256(aNotify, utf8Encode(`${t}.${rawBody}`)));
}

/** L'en-tête `Filarr-Notify: t=<secondes>,v1=<hex>` d'un corps. */
export async function notifyHeader(
  c: StoreCrypto,
  aNotify: Uint8Array,
  rawBody: string,
  t: number
): Promise<string> {
  return `t=${t},v1=${await notifySignature(c, aNotify, t, rawBody)}`;
}

export type NotifyVerdict = 'ok' | 'malformed' | 'stale' | 'bad_signature';

/**
 * Vérifie un réveil : en-tête lisible, horodatage à moins de 5 minutes, et
 * signature exacte sur le corps BRUT (avant tout analyseur JSON).
 */
export async function verifyNotify(
  c: StoreCrypto,
  aNotify: Uint8Array,
  header: string | null | undefined,
  rawBody: string,
  nowS: number
): Promise<NotifyVerdict> {
  if (typeof header !== 'string') return 'malformed';
  const m = /^\s*t=(\d{1,12})\s*,\s*v1=([0-9a-f]{64})\s*$/.exec(header);
  if (!m || m[1] === undefined || m[2] === undefined) return 'malformed';
  const t = Number(m[1]);
  if (!Number.isSafeInteger(t)) return 'malformed';
  if (Math.abs(nowS - t) > NOTIFY_TOLERANCE_S) return 'stale';
  const expected = await notifySignature(c, aNotify, t, rawBody);
  return constantTimeEqual(expected, m[2]) ? 'ok' : 'bad_signature';
}

/** Le corps d'un réveil, tel que le serveur l'envoie (aucun contenu : « relis »). */
export interface NotifyBody {
  a: string;
  t: string;
  storeId?: string;
  seq?: number;
  state?: string;
  at: string;
}

/** Lit un corps de réveil déjà vérifié ; `null` s'il ne nomme pas cet accès. */
export function readNotifyBody(rawBody: string, accessId: string): NotifyBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o.a !== accessId || typeof o.t !== 'string' || typeof o.at !== 'string') return null;
  return {
    a: o.a,
    t: o.t,
    at: o.at,
    ...(typeof o.storeId === 'string' ? { storeId: o.storeId } : {}),
    ...(typeof o.seq === 'number' && Number.isSafeInteger(o.seq) ? { seq: o.seq } : {}),
    ...(typeof o.state === 'string' ? { state: o.state } : {}),
  };
}
