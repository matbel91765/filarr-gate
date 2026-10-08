// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/store/apiAccess.ts @ 01e4cb5e — relicencié Apache-2.0 par le titulaire des droits.
/**
 * L'accès API d'une base — contrat `api-base-1` (§ 1, § 3, § 4).
 *
 * Cœur portable, recopié tel quel par le mobile et par la boîte noire
 * (`filarr-gate`). Le hachage, HKDF et AES-GCM passent par le `StoreCrypto` du
 * magasin ; les courbes (X25519, Ed25519) par `AccessCurves`, injecté :
 * `@noble/curves` au bureau, le fournisseur de chacun ailleurs.
 *
 * Le scellé est CELUI de `userKeypair.sealToPublicKey`, octet pour octet :
 * `éphémère (32) ‖ IV (12) ‖ chiffré ‖ tag`, KEK = HKDF-SHA256(secret partagé,
 * sel = éphémère ‖ destinataire, info `filarr.userkey.seal.v1`), AES-256-GCM
 * sans AAD, le tout en base64 STANDARD. L'éphémère et l'IV sont imposables
 * pour les vecteurs dorés seulement.
 *
 * Le source passe sous `strict` ET `noUncheckedIndexedAccess`.
 */

import {
  concatBytes,
  fromBase64Url,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type StoreCrypto,
} from './crypto';

export interface AccessCurves {
  x25519PublicKey(priv: Uint8Array): Uint8Array;
  x25519Shared(priv: Uint8Array, pub: Uint8Array): Uint8Array;
  ed25519PublicKey(priv: Uint8Array): Uint8Array;
  ed25519Sign(priv: Uint8Array, message: Uint8Array): Uint8Array;
  ed25519Verify(signature: Uint8Array, message: Uint8Array, pub: Uint8Array): boolean;
}

const API_INFO = 'filarr/api/v1';
const SEAL_INFO = 'filarr.userkey.seal.v1';
export const TOKEN_PREFIX = 'flr_live_';
const ACCESS_ID_BYTES = 16;
const SECRET_BYTES = 32;
const KEY_BYTES = 32;
const IV_BYTES = 12;

// ==================== base64 standard (clés publiques, scellés) ====================

/** base64 standard avec remplissage, celui de `userKeypair`. */
export function toBase64Std(bytes: Uint8Array): string {
  const url = toBase64Url(bytes).replace(/-/g, '+').replace(/_/g, '/');
  return url + '='.repeat((4 - (url.length % 4)) % 4);
}

export function fromBase64Std(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0)
    throw new Error('base64 invalide');
  return fromBase64Url(text.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'));
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// ==================== Le jeton (§ 1) ====================

/** `flr_live_<accessId base64url>_<secret base64url>`, 75 caractères. */
export function formatAccessToken(accessId: Uint8Array, secret: Uint8Array): string {
  if (accessId.length !== ACCESS_ID_BYTES || secret.length !== SECRET_BYTES)
    throw new Error('accessId de 16 octets et secret de 32 octets attendus');
  return `${TOKEN_PREFIX}${toBase64Url(accessId)}_${toBase64Url(secret)}`;
}

export interface ParsedAccessToken {
  /** `accessId` en base64url, tel que le serveur le connaît. */
  accessId: string;
  accessIdBytes: Uint8Array;
  secret: Uint8Array;
}

/** Rend `null` pour tout ce qui n'est pas exactement un jeton (sans jamais lever). */
export function parseAccessToken(token: string): ParsedAccessToken | null {
  const m = /^flr_live_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/.exec(token.trim());
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  try {
    const accessIdBytes = fromBase64Url(m[1]);
    const secret = fromBase64Url(m[2]);
    if (accessIdBytes.length !== ACCESS_ID_BYTES || secret.length !== SECRET_BYTES) return null;
    // Une écriture non canonique (bits de bourrage non nuls) désignerait le même octet sous deux jetons.
    if (toBase64Url(accessIdBytes) !== m[1] || toBase64Url(secret) !== m[2]) return null;
    return { accessId: m[1], accessIdBytes, secret };
  } catch {
    return null;
  }
}

export interface AccessKeys {
  /** Preuve présentée au serveur, qui n'en garde que l'empreinte. */
  aAuth: Uint8Array;
  /** Clé privée X25519 de l'accès. */
  aEnc: Uint8Array;
  /** Sa clé publique, en base64 standard (`enc_public_key`). */
  aPub: string;
}

export async function deriveAccessKeys(
  c: StoreCrypto,
  curves: AccessCurves,
  accessIdBytes: Uint8Array,
  secret: Uint8Array
): Promise<AccessKeys> {
  const aAuth = await c.hkdf(secret, accessIdBytes, `${API_INFO}|auth`, KEY_BYTES);
  const aEnc = await c.hkdf(secret, accessIdBytes, `${API_INFO}|enc`, KEY_BYTES);
  return { aAuth, aEnc, aPub: toBase64Std(curves.x25519PublicKey(aEnc)) };
}

/** `auth_hash` : SHA-256 de la preuve, en hexadécimal minuscule. */
export async function accessAuthHash(c: StoreCrypto, aAuth: Uint8Array): Promise<string> {
  return toHex(await c.sha256(aAuth));
}

/** La valeur de l'en-tête `Authorization`. */
export function accessAuthorization(accessId: string, aAuth: Uint8Array): string {
  return `Filarr-Access ${accessId}.${toBase64Url(aAuth)}`;
}

/** Le message que signe le créateur (`bind_sig`), lié à l'accès ET à sa clé publique. */
export function bindMessage(accessId: string, encPublicKey: string): Uint8Array {
  return utf8Encode(`${API_INFO}|bind|${accessId}|${encPublicKey}`);
}

// ==================== Le scellé ====================

export async function sealToKey(
  c: StoreCrypto,
  curves: AccessCurves,
  recipientPub: string,
  plaintext: Uint8Array,
  fixed?: { ephemeralPriv: Uint8Array; iv: Uint8Array }
): Promise<string> {
  const recipient = fromBase64Std(recipientPub);
  const ephPriv = fixed ? fixed.ephemeralPriv : c.randomBytes(KEY_BYTES);
  const ephPub = curves.x25519PublicKey(ephPriv);
  const shared = curves.x25519Shared(ephPriv, recipient);
  const kek = await c.hkdf(shared, concatBytes(ephPub, recipient), SEAL_INFO, KEY_BYTES);
  const iv = fixed ? fixed.iv : c.randomBytes(IV_BYTES);
  const ct = await c.aesGcmEncrypt(kek, iv, plaintext, new Uint8Array(0));
  if (!fixed) ephPriv.fill(0);
  return toBase64Std(concatBytes(ephPub, iv, ct));
}

/** Lève si le scellé n'est pas pour cette clé, ou s'il a été altéré. */
export async function openSealedBox(
  c: StoreCrypto,
  curves: AccessCurves,
  recipientPriv: Uint8Array,
  sealed: string
): Promise<Uint8Array> {
  const blob = fromBase64Std(sealed);
  if (blob.length < KEY_BYTES + IV_BYTES + 16) throw new Error('scellé trop court');
  const ephPub = blob.slice(0, KEY_BYTES);
  const iv = blob.slice(KEY_BYTES, KEY_BYTES + IV_BYTES);
  const shared = curves.x25519Shared(recipientPriv, ephPub);
  const recipient = curves.x25519PublicKey(recipientPriv);
  const kek = await c.hkdf(shared, concatBytes(ephPub, recipient), SEAL_INFO, KEY_BYTES);
  return c.aesGcmDecrypt(kek, iv, blob.slice(KEY_BYTES + IV_BYTES), new Uint8Array(0));
}

// ==================== Le droit scellé (§ 3) ====================

export interface GrantPlace {
  /** `accessId` (base64url). */
  a: string;
  /** `storeId`. */
  s: string;
  e: number;
  g: number;
}

/** Le clair d'un droit, clés dans l'ordre `a, s, e, g, k`. */
export function grantPlaintext(place: GrantPlace, kDb: Uint8Array): string {
  return JSON.stringify({ a: place.a, s: place.s, e: place.e, g: place.g, k: toBase64Url(kDb) });
}

/**
 * Rend `K_db`, après avoir vérifié que le scellé est bien à SA place : un
 * scellé recopié sous un autre accès, une autre base ou un autre (e, g) est
 * refusé, jamais utilisé.
 */
export function readGrantPlaintext(text: string, expected: GrantPlace): Uint8Array {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('droit illisible');
  const o = parsed as Record<string, unknown>;
  if (o.a !== expected.a || o.s !== expected.s || o.e !== expected.e || o.g !== expected.g)
    throw new Error('droit scellé hors de sa place');
  if (typeof o.k !== 'string') throw new Error('droit sans clé');
  const kDb = fromBase64Url(o.k);
  if (kDb.length !== KEY_BYTES) throw new Error('clé de base de taille invalide');
  return kDb;
}

export async function openGrant(
  c: StoreCrypto,
  curves: AccessCurves,
  aEnc: Uint8Array,
  sealed: string,
  expected: GrantPlace
): Promise<Uint8Array> {
  return readGrantPlaintext(utf8Decode(await openSealedBox(c, curves, aEnc, sealed)), expected);
}

// ==================== Les slugs (§ 4) ====================

export type SlugKind = 'base' | 'vue';

/** Comptés comme déjà pris : ils nomment des chemins de la boîte noire. */
export const RESERVED_SLUGS: readonly string[] = [
  'q',
  'sql',
  'openapi',
  'docs',
  'health',
  'metrics',
  'self',
];

const MAX_SLUG = 48;

/** Le slug d'un titre, avant départage. */
export function slugBase(title: string, kind: SlugKind): string {
  const folded = title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let slug = folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  slug = slug.slice(0, MAX_SLUG).replace(/-+$/, '');
  return slug === '' ? kind : slug;
}

/**
 * Le slug suivant pour `title`, départagé contre `taken` (que l'appelant
 * complète). `taken` contient déjà les slugs gardés par la fiche du créateur.
 */
export function nextSlug(title: string, kind: SlugKind, taken: ReadonlySet<string>): string {
  const base = slugBase(title, kind);
  const isTaken = (s: string): boolean => taken.has(s) || RESERVED_SLUGS.includes(s);
  if (!isTaken(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
}

/** Les slugs d'une liste de titres, dans leur ordre, à partir de rien. */
export function assignSlugs(titles: readonly string[], kind: SlugKind): string[] {
  const taken = new Set<string>();
  return titles.map((title) => {
    const slug = nextSlug(title, kind, taken);
    taken.add(slug);
    return slug;
  });
}
