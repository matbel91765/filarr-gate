/**
 * Le jeton d'un accès (contrat `api-base-1` § 1).
 *
 * `flr_live_<accessId>_<secret>` : la boîte noire en dérive, sur place,
 * `A_auth` (la preuve présentée au serveur, qui n'en garde que l'empreinte) et
 * `A_enc` (la clé privée X25519 qui ouvre les droits scellés). Le `secret` est
 * effacé de la mémoire dès les dérivations faites ; il ne part jamais vers Filarr.
 */

import { createHash } from 'node:crypto';
import {
  accessAuthorization,
  deriveAccessKeys,
  parseAccessToken,
} from '../core/engine/store/apiAccess';
import { curves, storeCrypto } from '../crypto/providers';

export interface AccessIdentity {
  /** `accessId` en base64url, tel que le serveur le connaît. */
  accessId: string;
  aAuth: Uint8Array;
  aEnc: Uint8Array;
  /** Clé publique X25519 de l'accès (base64 standard). */
  aPub: string;
  /** La valeur de l'en-tête `Authorization`. */
  authorization: string;
  /** Pour l'affichage seulement, tiré de `accessId` (jamais un caractère du secret) : `flr_live_EBES…Hw`. */
  hint: string;
  /** Empreinte courte du jeton (SHA-256), pour le reconnaître sans le montrer. */
  fingerprint: string;
}

export class InvalidTokenError extends Error {
  constructor() {
    super('Ce n’est pas un jeton Filarr : il commence par flr_live_ et fait 75 caractères.');
    this.name = 'InvalidTokenError';
  }
}

export async function openToken(token: string): Promise<AccessIdentity> {
  const parsed = parseAccessToken(token);
  if (!parsed) throw new InvalidTokenError();
  const keys = await deriveAccessKeys(storeCrypto, curves, parsed.accessIdBytes, parsed.secret);
  const trimmed = token.trim();
  const digest = createHash('sha256').update(trimmed).digest('hex');
  parsed.secret.fill(0);
  return {
    accessId: parsed.accessId,
    aAuth: keys.aAuth,
    aEnc: keys.aEnc,
    aPub: keys.aPub,
    authorization: accessAuthorization(parsed.accessId, keys.aAuth),
    hint: `flr_live_${parsed.accessId.slice(0, 4)}…${parsed.accessId.slice(-4)}`,
    fingerprint: `${digest.slice(0, 4)}…${digest.slice(-2)}`,
  };
}

/** Efface les clés dérivées (révocation, oubli de la machine). */
export function wipeIdentity(identity: AccessIdentity): void {
  identity.aAuth.fill(0);
  identity.aEnc.fill(0);
}
