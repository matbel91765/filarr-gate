/**
 * Les fournisseurs de cryptographie de la boîte noire.
 *
 * - `storeCrypto` : HKDF, HMAC, SHA-256 et AES-256-GCM du magasin, par WebCrypto
 *   (`globalThis.crypto.subtle`, présent dans Node ≥ 20), avec le fournisseur du
 *   cœur recopié de Filarr (`webCryptoStore`), sans retouche.
 * - `curves` : X25519 et Ed25519 par `@noble/curves`, comme l'application.
 */

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { webCryptoStore, type StoreCrypto } from '../../../core/src/engine/store/crypto';
import type { AccessCurves } from '../../../core/src/engine/store/apiAccess';

export const storeCrypto: StoreCrypto = webCryptoStore(globalThis.crypto.subtle);

export const curves: AccessCurves = {
  x25519PublicKey: (priv) => x25519.getPublicKey(priv),
  x25519Shared: (priv, pub) => x25519.getSharedSecret(priv, pub),
  ed25519PublicKey: (priv) => ed25519.getPublicKey(priv),
  ed25519Sign: (priv, message) => ed25519.sign(message, priv),
  ed25519Verify: (signature, message, pub) => {
    try {
      return ed25519.verify(signature, message, pub);
    } catch {
      return false;
    }
  },
};
