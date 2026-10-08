// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/__tests__/helpers/nodeCryptoStore.ts @ 189ef234 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Un fournisseur de chiffrement SANS WebCrypto, sur le module `crypto` de
 * Node : il tient lieu de fournisseur tiers, comme celui du mobile, pour
 * rejouer les vecteurs dorés sous deux implémentations indépendantes.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'crypto';
import type { StoreCrypto } from '../../src/core/engine/store/crypto';

export const nodeCryptoStore: StoreCrypto = {
  async hkdf(ikm, salt, info, length) {
    return new Uint8Array(hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), length));
  },
  async hmacSha256(key, data) {
    return new Uint8Array(createHmac('sha256', key).update(data).digest());
  },
  async sha256(data) {
    return new Uint8Array(createHash('sha256').update(data).digest());
  },
  async aesGcmEncrypt(key, iv, plaintext, aad) {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    return new Uint8Array(
      Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
    );
  },
  async aesGcmDecrypt(key, iv, data, aad) {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(data.subarray(data.length - 16));
    return new Uint8Array(
      Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()])
    );
  },
  randomBytes(length) {
    return new Uint8Array(randomBytes(length));
  },
};
