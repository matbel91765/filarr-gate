/**
 * Octets, empreintes et hasard, sans API propre à Node : la bibliothèque tourne
 * aussi dans un Worker Cloudflare, sous Deno et sous Bun.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { toBase64Url, utf8Encode } from '../../../core/src/engine/store/crypto';

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error('hexadécimal invalide');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** SHA-256 synchrone (noble), en hexadécimal. */
export const sha256Hex = (data: Uint8Array | string): string => toHex(sha256(typeof data === 'string' ? utf8Encode(data) : data));

export const randomBytes = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** Un jeton aléatoire en base64url (`n` octets). */
export const randomToken = (n: number): string => toBase64Url(randomBytes(n));

export const randomUUID = (): string => globalThis.crypto.randomUUID();

/** Comparaison en temps constant (chaînes ou octets de même longueur). */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  return timingSafeEqualBytes(utf8Encode(a), utf8Encode(b));
}
