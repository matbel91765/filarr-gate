/**
 * Le jeton d'un accès (contrat `api-base-1` § 1, et § 1 bis de la révision 3).
 *
 * `flr_live_<accessId>_<secret>` : la boîte noire en dérive, sur place,
 *  - `A_auth` (la preuve présentée au serveur, qui n'en garde que l'empreinte) ;
 *  - `A_enc` (la clé privée X25519 qui ouvre les droits scellés) ;
 *  - `A_mac` (révision 3 : elle vérifie l'étiquette qui authentifie la clé de
 *    signature du créateur) ;
 *  - `A_notify` (révision 3 : elle vérifie les réveils poussés) ;
 *  - `A_local` (propre à la boîte, hors contrat) : elle chiffre au repos ce que
 *    la boîte garde de secret (clés des bases externes, ombres) ; changer de
 *    jeton rend ces fichiers illisibles, ce qui est voulu.
 * Le `secret` est effacé de la mémoire dès les dérivations faites ; il ne part
 * jamais vers Filarr.
 */

import { accessAuthorization, deriveAccessKeys, parseAccessToken } from '../../../core/src/engine/store/apiAccess';
import { deriveAccessKeys3 } from '../../../core/src/engine/gate/access3';
import { curves, storeCrypto } from '../crypto/providers';
import { sha256Hex } from '../util/bytes';

export interface AccessIdentity {
  /** `accessId` en base64url, tel que le serveur le connaît. */
  accessId: string;
  accessIdBytes: Uint8Array;
  aAuth: Uint8Array;
  aEnc: Uint8Array;
  /** Clé publique X25519 de l'accès (base64 standard). */
  aPub: string;
  /** Révision 3 : clé de l'étiquette du créateur. */
  aMac: Uint8Array;
  /** Révision 3 : clé des réveils poussés. */
  aNotify: Uint8Array;
  /** Chiffrement au repos des secrets locaux de la boîte (hors contrat). */
  aLocal: Uint8Array;
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
  const keys3 = await deriveAccessKeys3(storeCrypto, parsed.accessIdBytes, parsed.secret);
  const aLocal = await storeCrypto.hkdf(parsed.secret, parsed.accessIdBytes, 'filarr-gate/v1|local', 32);
  const digest = sha256Hex(token.trim());
  parsed.secret.fill(0);
  return {
    accessId: parsed.accessId,
    accessIdBytes: parsed.accessIdBytes,
    aAuth: keys.aAuth,
    aEnc: keys.aEnc,
    aPub: keys.aPub,
    aMac: keys3.aMac,
    aNotify: keys3.aNotify,
    aLocal,
    authorization: accessAuthorization(parsed.accessId, keys.aAuth),
    hint: `flr_live_${parsed.accessId.slice(0, 4)}…${parsed.accessId.slice(-4)}`,
    fingerprint: `${digest.slice(0, 4)}…${digest.slice(-2)}`,
  };
}

/** Efface les clés dérivées (révocation, oubli de la machine). */
export function wipeIdentity(identity: AccessIdentity): void {
  identity.aAuth.fill(0);
  identity.aEnc.fill(0);
  identity.aMac.fill(0);
  identity.aNotify.fill(0);
  identity.aLocal.fill(0);
}
