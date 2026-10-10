/**
 * Ce que le service hébergé SIGNE et VÉRIFIE — contrat `gate-heberge-1` § 2.2, § 7.2, § 7.4,
 * § 8.5 (vecteurs : familles 3, 4, 5 de `test/vectors/gate-heberge-1.vectors.json`).
 *
 *  - requête vers l'API : `Filarr-Gate-Host: k=<keyId>,t=<secondes>,s=<b64url Ed25519>` sur
 *    `"filarr/gate-host/v1|req|" + méthode + "|" + chemin avec requête + "|" + t + "|" + hex(SHA-256(corps))` ;
 *  - reçu d'effacement : `sig = b64url(Ed25519(HOST_SIG, "filarr/gate-host/v1|receipt|" + JSON canonique))` ;
 *  - annonce de version : `sig = b64url(Ed25519(HOST_SIG, "filarr/gate-host/v1|version|" + JSON canonique sans sig))` ;
 *  - canal de gestion : `Filarr-Creator: t=<secondes>,s=<b64url Ed25519>` sur
 *    `"filarr/gate-host/v1|admin|" + méthode + "|" + chemin + "|" + t + "|" + hex(SHA-256(corps))`,
 *    vérifié avec la clé de signature du créateur authentifiée par `creatorTag`.
 *
 * Fonctions pures : Ed25519 par `@noble/curves` (le `crypto.subtle` de Workers n'a pas Ed25519 partout),
 * SHA-256 par `@noble/hashes`.
 */

import { canonicalJson } from '../../core/src/engine/store/canonical';
import { fromBase64Url, toBase64Url, utf8Encode } from '../../core/src/engine/store/crypto';
import { curves } from '../../gate/src/crypto/providers';
import { sha256Hex } from '../../gate/src/util/bytes';

export const HOST_INFO = 'filarr/gate-host/v1';
export const GATE_HOST_HEADER = 'Filarr-Gate-Host';
export const CREATOR_HEADER = 'Filarr-Creator';
/** Écart d'horloge admis (requêtes signées, canal de gestion), en secondes. */
export const SKEW_SECONDS = 300;

export const bodyHashHex = (body: Uint8Array | string): string => sha256Hex(typeof body === 'string' ? utf8Encode(body) : body);

// ==================== Requêtes du service vers l'API (§ 2.2) ====================

export const hostRequestMessage = (method: string, pathWithQuery: string, t: number, bodySha256Hex: string): string =>
  `${HOST_INFO}|req|${method.toUpperCase()}|${pathWithQuery}|${t}|${bodySha256Hex}`;

/** L'en-tête `Filarr-Gate-Host` d'une requête, signé par la clé privée Ed25519 `HOST_SIG`. */
export function hostRequestHeader(signKey: { id: string; privateKey: Uint8Array }, method: string, pathWithQuery: string, t: number, body: Uint8Array | string): string {
  const message = hostRequestMessage(method, pathWithQuery, t, bodyHashHex(body));
  const sig = toBase64Url(curves.ed25519Sign(signKey.privateKey, utf8Encode(message)));
  return `k=${signKey.id},t=${t},s=${sig}`;
}

export type HostRequestVerdict = { ok: true; keyId: string } | { ok: false; reason: 'missing' | 'malformed' | 'key' | 'clock' | 'signature' };

/**
 * Ce que fait l'API à la réception (worker `gateCrypto.ts`, `verifyHostRequest`) — ici pour le Filarr
 * en mémoire des essais et le rejeu des vecteurs : en-tête lisible, clé connue et valide, horloge à
 * 300 s près, signature sur la méthode, le chemin avec sa requête, l'heure et le corps.
 */
export function verifyHostRequestHeader(args: {
  header: string | null | undefined;
  method: string;
  pathWithQuery: string;
  body: Uint8Array | string;
  keys: Array<{ id: string; signPublicKey: Uint8Array; notBefore: string; notAfter: string }>;
  nowMs: number;
}): HostRequestVerdict {
  if (!args.header) return { ok: false, reason: 'missing' };
  if (args.header.length > 512) return { ok: false, reason: 'malformed' };
  const parts = new Map<string, string>();
  for (const piece of args.header.split(',')) {
    const eq = piece.indexOf('=');
    if (eq <= 0) return { ok: false, reason: 'malformed' };
    const name = piece.slice(0, eq).trim();
    if (parts.has(name)) return { ok: false, reason: 'malformed' };
    parts.set(name, piece.slice(eq + 1).trim());
  }
  const k = parts.get('k');
  const t = parts.get('t');
  const s = parts.get('s');
  if (!k || !/^[A-Za-z0-9_-]{1,32}$/.test(k) || !t || !/^\d{1,12}$/.test(t) || !s) return { ok: false, reason: 'malformed' };
  let sig: Uint8Array;
  try {
    sig = fromBase64Url(s);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (sig.length !== 64) return { ok: false, reason: 'malformed' };
  const key = args.keys.find((x) => x.id === k && Date.parse(x.notBefore) <= args.nowMs && args.nowMs < Date.parse(x.notAfter));
  if (!key) return { ok: false, reason: 'key' };
  if (Math.abs(Math.floor(args.nowMs / 1000) - Number(t)) > SKEW_SECONDS) return { ok: false, reason: 'clock' };
  const message = hostRequestMessage(args.method, args.pathWithQuery, Number(t), bodyHashHex(args.body));
  return curves.ed25519Verify(sig, utf8Encode(message), key.signPublicKey) ? { ok: true, keyId: key.id } : { ok: false, reason: 'signature' };
}

// ==================== Reçu d'effacement (§ 8.5) ====================

export type ReceiptReason = 'revoked' | 'migrated' | 'withdrawn' | 'billing' | 'tier' | 'policy' | 'consent';
export const RECEIPT_REASONS: readonly ReceiptReason[] = ['revoked', 'migrated', 'withdrawn', 'billing', 'tier', 'policy', 'consent'];
export const ERASED_ALL = ['token', 'dbKeys', 'copy', 'state', 'extdbKeys'] as const;

export interface ErasureReceipt {
  v: 1;
  kind: 'filarr-gate-host/erasure';
  keyId: string;
  accessId: string;
  hostName: string;
  reason: ReceiptReason;
  stores: Array<{ storeId: string; g: number }>;
  erased: string[];
  requestedAt: string;
  erasedAt: string;
  version: string;
  codeHash: string;
}

export const receiptMessage = (receipt: object): string => `${HOST_INFO}|receipt|${canonicalJson(receipt)}`;

export function signReceipt(signKey: { privateKey: Uint8Array }, receipt: ErasureReceipt): string {
  return toBase64Url(curves.ed25519Sign(signKey.privateKey, utf8Encode(receiptMessage(receipt))));
}

/** Vérifie une signature d'objet du service (reçu, annonce) avec une clé publique Ed25519 brute. */
export function verifyHostSignature(message: string, sigB64Url: string, signPublicKey: Uint8Array): boolean {
  try {
    const sig = fromBase64Url(sigB64Url);
    return sig.length === 64 && curves.ed25519Verify(sig, utf8Encode(message), signPublicKey);
  } catch {
    return false;
  }
}

// ==================== Annonce de version (§ 7.4) ====================

export interface VersionAnnouncement {
  version: string;
  codeHash: string;
  buildRef: string;
  deployedAt: string;
  keyId: string;
  /** Correctif de sécurité (§ 10.1, point 5) : `security: true` et l'avis. */
  security?: true;
  advisory?: string;
  [extra: string]: unknown;
}

export const versionMessage = (announcementWithoutSig: object): string => `${HOST_INFO}|version|${canonicalJson(announcementWithoutSig)}`;

export function signVersion(signKey: { privateKey: Uint8Array }, announcement: VersionAnnouncement): VersionAnnouncement & { sig: string } {
  const { sig: _drop, ...rest } = announcement as VersionAnnouncement & { sig?: string };
  return { ...rest, sig: toBase64Url(curves.ed25519Sign(signKey.privateKey, utf8Encode(versionMessage(rest)))) } as VersionAnnouncement & { sig: string };
}

// ==================== Canal de gestion (§ 7.2) ====================

export const adminMessage = (method: string, path: string, t: number, bodySha256Hex: string): string =>
  `${HOST_INFO}|admin|${method.toUpperCase()}|${path}|${t}|${bodySha256Hex}`;

/** `Filarr-Creator: t=<secondes>,s=<b64url>` ; l'ordre est libre, chacun une fois. */
export function parseCreatorHeader(header: string | null | undefined): { t: number; s: Uint8Array } | null {
  if (typeof header !== 'string' || header.length > 256) return null;
  const parts = new Map<string, string>();
  for (const piece of header.split(',')) {
    const eq = piece.indexOf('=');
    if (eq <= 0) return null;
    const name = piece.slice(0, eq).trim();
    if (parts.has(name)) return null;
    parts.set(name, piece.slice(eq + 1).trim());
  }
  const t = parts.get('t');
  const s = parts.get('s');
  if (parts.size !== 2 || !t || !/^\d{1,12}$/.test(t) || !s || !/^[A-Za-z0-9_-]{86}$/.test(s)) return null;
  let sig: Uint8Array;
  try {
    sig = fromBase64Url(s);
  } catch {
    return null;
  }
  return sig.length === 64 ? { t: Number(t), s: sig } : null;
}

export type AdminVerdict = 'ok' | 'missing' | 'malformed' | 'clock' | 'signature' | 'no_creator';

/** Vérifie une requête du canal de gestion contre la clé (Ed25519 brute) du créateur. */
export function verifyAdminRequest(args: {
  header: string | null | undefined;
  method: string;
  path: string;
  body: Uint8Array;
  creatorSigningPublicKey: Uint8Array | null;
  nowS: number;
}): AdminVerdict {
  if (!args.header) return 'missing';
  const h = parseCreatorHeader(args.header);
  if (!h) return 'malformed';
  if (Math.abs(args.nowS - h.t) > SKEW_SECONDS) return 'clock';
  if (!args.creatorSigningPublicKey) return 'no_creator';
  const message = adminMessage(args.method, args.path, h.t, bodyHashHex(args.body));
  return curves.ed25519Verify(h.s, utf8Encode(message), args.creatorSigningPublicKey) ? 'ok' : 'signature';
}

