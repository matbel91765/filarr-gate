// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/store/crypto.ts @ 189ef234 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Chiffrement du magasin des bases — contrat `db-store-1`, § 3.
 *
 * Tout passe par un FOURNISSEUR injecté : le bureau et le web prennent
 * WebCrypto (`crypto.subtle`), le mobile son `CryptoProvider` (sans
 * `crypto.subtle`). Le reste du cœur n'appelle jamais une API de plateforme :
 * il ne manipule que des `Uint8Array`, ce qui le rend portable tel quel.
 *
 * Le source passe sous `strict` ET `noUncheckedIndexedAccess` : il se recopie
 * sans retouche dans un projet qui active ce réglage.
 */

export interface StoreCrypto {
  hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Promise<Uint8Array>;
  hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
  sha256(data: Uint8Array): Promise<Uint8Array>;
  /** AES-256-GCM : rend `chiffré ‖ tag` (tag de 16 octets). */
  aesGcmEncrypt(
    key: Uint8Array,
    iv: Uint8Array,
    plaintext: Uint8Array,
    aad: Uint8Array
  ): Promise<Uint8Array>;
  /** Lève si le tag ne correspond pas (clé, IV, AAD ou corps altérés). */
  aesGcmDecrypt(
    key: Uint8Array,
    iv: Uint8Array,
    data: Uint8Array,
    aad: Uint8Array
  ): Promise<Uint8Array>;
  randomBytes(length: number): Uint8Array;
}

// ==================== UTF-8, octet pour octet celui de TextEncoder / TextDecoder ====================

/**
 * Encodage pur, identique à `TextEncoder` : une moitié de paire isolée devient
 * U+FFFD. Le repli de `strToU8` (fflate 0.8, sans TextEncoder) code mal tout
 * caractère hors du plan de base : `😀` y donne `f0 9d a8 80` au lieu de
 * `f0 9f 98 80` (vérifié le 2026-10-04).
 */
export function utf8EncodePure(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      const d = c <= 0xdbff && i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i += 1;
      } else {
        c = 0xfffd;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/**
 * Décodage pur, identique à `TextDecoder('utf-8')` (mode remplacement, BOM
 * initial retiré), Y COMPRIS sur une entrée malformée : chaque sous-partie
 * maximale invalide devient UN U+FFFD (algorithme du WHATWG), et rien n'est
 * jamais lu au-delà de la fin.
 */
export function utf8DecodePure(bytes: Uint8Array): string {
  const units: number[] = [];
  let out = '';
  const emit = (cp: number): void => {
    if (cp >= 0x10000) {
      const v = cp - 0x10000;
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 1023));
    } else {
      units.push(cp);
    }
    if (units.length >= 0x1000) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  };
  let codePoint = 0;
  let needed = 0;
  let seen = 0;
  let lower = 0x80;
  let upper = 0xbf;
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (needed === 0) {
      i += 1;
      if (b <= 0x7f) emit(b);
      else if (b >= 0xc2 && b <= 0xdf) {
        needed = 1;
        codePoint = b & 0x1f;
      } else if (b >= 0xe0 && b <= 0xef) {
        if (b === 0xe0) lower = 0xa0;
        if (b === 0xed) upper = 0x9f;
        needed = 2;
        codePoint = b & 0xf;
      } else if (b >= 0xf0 && b <= 0xf4) {
        if (b === 0xf0) lower = 0x90;
        if (b === 0xf4) upper = 0x8f;
        needed = 3;
        codePoint = b & 0x7;
      } else {
        emit(0xfffd);
      }
      continue;
    }
    if (b < lower || b > upper) {
      // Sous-partie invalide : un U+FFFD, et l'octet est RELU comme un début
      codePoint = 0;
      needed = 0;
      seen = 0;
      lower = 0x80;
      upper = 0xbf;
      emit(0xfffd);
      continue;
    }
    i += 1;
    lower = 0x80;
    upper = 0xbf;
    codePoint = (codePoint << 6) | (b & 0x3f);
    seen += 1;
    if (seen === needed) {
      emit(codePoint);
      codePoint = 0;
      needed = 0;
      seen = 0;
    }
  }
  if (needed !== 0) emit(0xfffd);
  out += String.fromCharCode(...units);
  return out.charCodeAt(0) === 0xfeff ? out.slice(1) : out;
}

const nativeEncoder: TextEncoder | null =
  typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const nativeDecoder: TextDecoder | null =
  typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

/** UTF-8 : le natif quand il existe (identique par définition), sinon l'implémentation pure. */
export function utf8Encode(text: string): Uint8Array {
  return nativeEncoder ? nativeEncoder.encode(text) : utf8EncodePure(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return nativeDecoder ? nativeDecoder.decode(bytes) : utf8DecodePure(bytes);
}

// ==================== base64url, sans API de plateforme ====================

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url sans remplissage. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  if (i < bytes.length) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[n >> 18]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  if (clean.length % 4 === 1) throw new Error('base64url invalide');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean.charAt(i));
    const b = B64.indexOf(clean.charAt(i + 1));
    const c = i + 2 < clean.length ? B64.indexOf(clean.charAt(i + 2)) : 0;
    const d = i + 3 < clean.length ? B64.indexOf(clean.charAt(i + 3)) : 0;
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('base64url invalide');
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = n >> 16;
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length) out[o++] = n & 255;
  }
  return out.slice(0, o);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ==================== Fournisseur WebCrypto (bureau, web, tests) ====================

/** Recopie vers un ArrayBuffer propre : WebCrypto n'aime pas les vues décalées. */
const buf = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
};

export function webCryptoStore(subtle: SubtleCrypto = globalThis.crypto.subtle): StoreCrypto {
  return {
    async hkdf(ikm, salt, info, length) {
      const key = await subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
      const bits = await subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(utf8Encode(info)) },
        key,
        length * 8
      );
      return new Uint8Array(bits);
    },
    async hmacSha256(key, data) {
      const k = await subtle.importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
      ]);
      return new Uint8Array(await subtle.sign('HMAC', k, buf(data)));
    },
    async sha256(data) {
      return new Uint8Array(await subtle.digest('SHA-256', buf(data)));
    },
    async aesGcmEncrypt(key, iv, plaintext, aad) {
      const k = await subtle.importKey('raw', buf(key), 'AES-GCM', false, ['encrypt']);
      return new Uint8Array(
        await subtle.encrypt(
          { name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) },
          k,
          buf(plaintext)
        )
      );
    },
    async aesGcmDecrypt(key, iv, data, aad) {
      const k = await subtle.importKey('raw', buf(key), 'AES-GCM', false, ['decrypt']);
      return new Uint8Array(
        await subtle.decrypt(
          { name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) },
          k,
          buf(data)
        )
      );
    },
    randomBytes(length) {
      return globalThis.crypto.getRandomValues(new Uint8Array(length));
    },
  };
}

// ==================== Dérivations (§ 2 et § 3) ====================

const INFO = 'filarr/dbstore/v1';
const EMPTY = new Uint8Array(0);

/**
 * Les clés d'un magasin à UNE époque : `K_db` (FEK, ou K_vault de l'époque) et
 * `K_head`, qui scelle la tête. Le placement et les empreintes n'en dépendent
 * PAS (précision 3.3) : leurs clés sont tirées au hasard à la création et
 * portées dans la tête (`head.keys`), pour qu'une rotation de K_vault ne
 * déplace aucune ligne.
 */
export interface StoreKeys {
  storeId: string;
  epoch: number;
  /** Génération du magasin (précision 3.9) : 0 tant qu'aucun accès API n'a été retiré. */
  generation: number;
  kDb: Uint8Array;
  kHead: Uint8Array;
}

/** Les clés de placement et d'empreinte, portées par la tête (base64url de 32 octets). */
export interface HeadKeys {
  mac: string;
  place: string;
}

/** Tirées UNE fois, par le premier rédacteur du magasin ; chaque rédacteur les recopie. */
export function newHeadKeys(c: StoreCrypto): HeadKeys {
  return { mac: toBase64Url(c.randomBytes(32)), place: toBase64Url(c.randomBytes(32)) };
}

/** `storeId` d'une base PERSONNELLE : HMAC sur une clé dérivée de la FEK. */
export async function personalStoreId(
  c: StoreCrypto,
  fek: Uint8Array,
  dbId: string
): Promise<string> {
  const kIdent = await c.hkdf(fek, EMPTY, `${INFO}|ident`, 32);
  const mac = await c.hmacSha256(kIdent, utf8Encode(`${INFO}|id|${dbId}`));
  return toBase64Url(mac.slice(0, 16));
}

/** `storeId` d'une base de COFFRE : stable à travers les rotations de K_vault. */
export async function vaultStoreId(c: StoreCrypto, vaultId: string, dbId: string): Promise<string> {
  const digest = await c.sha256(utf8Encode(`${INFO}|id|v:${vaultId}|${dbId}`));
  return toBase64Url(digest.slice(0, 16));
}

/**
 * L'`info` de `K_db(e, g)` (précision 3.9, contrat `api-base-1` § 2). À la
 * génération 0, c'est celle d'avant, octet pour octet : les magasins existants
 * et les vecteurs 3.3 ne bougent pas. Une génération plus haute n'est
 * dérivable que depuis la racine, jamais depuis une `K_db` confiée à un accès.
 */
export function dbKeyInfo(epoch: number, generation: number): string {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error(`époque invalide : ${epoch}`);
  if (!Number.isSafeInteger(generation) || generation < 0)
    throw new Error(`génération invalide : ${generation}`);
  return generation === 0 ? `${INFO}|db|${epoch}` : `${INFO}|db|${epoch}|g${generation}`;
}

/** Les clés d'un magasin à une époque (FEK, ou K_vault de cette époque) et une génération. */
export async function storeKeys(
  c: StoreCrypto,
  ikm: Uint8Array,
  storeId: string,
  epoch: number,
  generation = 0
): Promise<StoreKeys> {
  const kDb = await c.hkdf(ikm, fromBase64Url(storeId), dbKeyInfo(epoch, generation), 32);
  const kHead = await c.hkdf(kDb, EMPTY, `${INFO}|head`, 32);
  return { storeId, epoch, generation, kDb, kHead };
}

export function slotKey(c: StoreCrypto, keys: StoreKeys, prefix: string): Promise<Uint8Array> {
  return c.hkdf(keys.kDb, EMPTY, `${INFO}|slot|${prefix}`, 32);
}

export const slotAad = (storeId: string, prefix: string, ver: number): Uint8Array =>
  utf8Encode(`${INFO}|slot|${storeId}|${prefix}|${ver}`);

export const headAad = (storeId: string, seq: number): Uint8Array =>
  utf8Encode(`${INFO}|head|${storeId}|${seq}`);

/** Chiffre : `iv ‖ chiffré ‖ tag`, IV imposable (vecteurs dorés). */
export async function seal(
  c: StoreCrypto,
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
  iv: Uint8Array = c.randomBytes(12)
): Promise<Uint8Array> {
  return concatBytes(iv, await c.aesGcmEncrypt(key, iv, plaintext, aad));
}

export async function open(
  c: StoreCrypto,
  key: Uint8Array,
  body: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  if (body.length < 12 + 16) throw new Error('corps chiffré tronqué');
  return c.aesGcmDecrypt(key, body.slice(0, 12), body.slice(12), aad);
}
