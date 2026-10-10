/**
 * Les clés des bases externes, DANS la boîte (contrat `source-externe-1` § 7.2) :
 * - saisies dans l'interface (écran « Sources »), par `filarr-gate sources key`,
 *   par la variable `FILARR_GATE_EXTDB_<ID>` (`ID` = les 8 premiers caractères de
 *   `defId` après `xs_`, en majuscules), ou dans `gate.toml`
 *   (`[extdb."xs_…"] secret = "…"`) ;
 * - JAMAIS transmises par Filarr ;
 * - rangées dans l'état (fichier 0600), CHIFFRÉES sous `A_local`, une clé tirée
 *   du jeton : changer de jeton les rend illisibles (la boîte redemande la clé) ;
 * - jamais journalisées.
 */

import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode, concatBytes } from '../../../core/src/engine/store/crypto';
import { storeCrypto } from '../../../gate/src/crypto/providers';
import type { GateCore } from '../core';

export const envNameFor = (defId: string): string => `FILARR_GATE_EXTDB_${defId.replace(/^xs_/, '').slice(0, 8).toUpperCase()}`;

const aad = (defId: string) => utf8Encode(`filarr-gate/v1|extdb|${defId}`);

export class SecretStore {
  constructor(
    private readonly core: GateCore,
    /** Clés venues de l'hôte : environnement, `gate.toml` (prioritaires, non modifiables ici). */
    private readonly external: (defId: string) => string | null
  ) {}

  /** D'où vient la clé d'une définition (`null` : manquante). */
  source(defId: string): 'env' | 'state' | null {
    if (this.external(defId)) return 'env';
    return this.core.state.data.extdbKeys[defId] ? 'state' : null;
  }

  async get(defId: string): Promise<string | null> {
    const ext = this.external(defId);
    if (ext) return ext;
    const sealed = this.core.state.data.extdbKeys[defId];
    const identity = this.core.replicator.identity;
    if (!sealed || !identity) return null;
    try {
      const blob = fromBase64Url(sealed);
      return utf8Decode(await storeCrypto.aesGcmDecrypt(identity.aLocal, blob.slice(0, 12), blob.slice(12), aad(defId)));
    } catch {
      // Chiffrée sous un autre jeton : illisible, la boîte redemande la clé
      return null;
    }
  }

  async set(defId: string, secret: string | null): Promise<void> {
    if (secret === null || secret === '') {
      delete this.core.state.data.extdbKeys[defId];
    } else {
      const identity = this.core.replicator.identity;
      if (!identity) throw new Error('aucun jeton en service : la clé ne peut pas être chiffrée');
      const iv = storeCrypto.randomBytes(12);
      const ct = await storeCrypto.aesGcmEncrypt(identity.aLocal, iv, utf8Encode(secret), aad(defId));
      this.core.state.data.extdbKeys[defId] = toBase64Url(concatBytes(iv, ct));
    }
    this.core.state.saveNow();
  }
}
