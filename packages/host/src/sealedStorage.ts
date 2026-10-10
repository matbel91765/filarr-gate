/**
 * L'ÉTAT DE LA BOÎTE AU REPOS, CHIFFRÉ SOUS `K_box` — contrat `gate-heberge-1` § 7.1 et § 16 bis (PH2, PH3).
 *
 * Une enveloppe autour du stockage de l'objet durable, de la même forme (`DoStorage`) : tout ce que la
 * boîte écrit (état, empreintes des clés d'application, secrets des webhooks, requêtes enregistrées,
 * clés et ombres des synchros externes, journal de la boîte, cache des blocs déjà chiffrés par Filarr)
 * passe par elle. Chaque valeur est rangée en `IV (12 o) ‖ chiffré ‖ étiquette (16 o)`, AES-256-GCM sous
 * `K_box`, AAD `"filarr/gate-host/v1|state|" + accessId + "|" + clé` (la clé de stockage) : une valeur
 * recopiée sous une autre clé, ou d'une autre boîte, ne s'ouvre pas.
 *
 * `K_box` n'existe qu'en mémoire, tirée du jeton à chaque réveil : effacer le jeton scellé chez l'API
 * rend ce stockage illisible, même si une copie en subsistait.
 *
 * Les noms des clés de stockage restent lisibles (ils désignent, ils ne contiennent rien : `state#0`,
 * `kv:blk:<magasin>:…`, `jl:<jour>:…`) ; la liste des clés d'état est propre au service (PH3).
 * Les clés `host:*` sont celles du service lui-même (métadonnées sans contenu), jamais servies ici.
 */

import { openState, sealState } from '../../core/src/engine/gate/host';
import { concatBytes, utf8Decode, utf8Encode, type StoreCrypto } from '../../core/src/engine/store/crypto';
import type { DoStorage } from '../../cloudflare/src/storage';

/**
 * Le clair d'une entrée : une valeur JSON est rangée TELLE QUELLE (son texte UTF-8, comme dans les
 * vecteurs de la famille 8) ; des octets bruts (blocs, morceaux d'état) sont précédés de l'octet 0x01,
 * qui ne commence jamais un texte JSON.
 */
const TAG_BYTES = 1;
export const HOST_PREFIX = 'host:';

export function encodeEntry(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return concatBytes(Uint8Array.of(TAG_BYTES), value);
  if (value instanceof ArrayBuffer) return concatBytes(Uint8Array.of(TAG_BYTES), new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return concatBytes(Uint8Array.of(TAG_BYTES), new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return utf8Encode(JSON.stringify(value === undefined ? null : value));
}

export function decodeEntry(bytes: Uint8Array): unknown {
  if (bytes.length === 0) throw new Error('entrée d’état vide');
  if (bytes[0] === TAG_BYTES) return bytes.slice(1);
  return JSON.parse(utf8Decode(bytes));
}

const asBytes = (v: unknown): Uint8Array | null => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null);

export interface SealedStorageOptions {
  crypto: StoreCrypto;
  kBox: Uint8Array;
  accessId: string;
  /** L'IV imposé d'une entrée : vecteurs seulement (sinon 12 octets aléatoires à chaque écriture). */
  fixedIv?: (key: string) => Uint8Array;
}

/** Le stockage de l'objet durable, vu à travers `K_box`. */
export class SealedStorage implements DoStorage {
  /** Sa propre copie de `K_box` : `close()` l'efface sans toucher aux autres vues. */
  private readonly kBox: Uint8Array;
  private closed = false;

  constructor(
    private readonly raw: DoStorage,
    private readonly opts: SealedStorageOptions
  ) {
    this.kBox = opts.kBox.slice();
  }

  /**
   * Ferme la vue : la clé est effacée de la mémoire, et toute lecture ou écriture qui arriverait
   * encore (une tâche de la boîte qui finit après le sommeil ou l'effacement) est REFUSÉE, jamais
   * faite sous une clé effacée.
   */
  close(): void {
    this.closed = true;
    this.kBox.fill(0);
  }

  private check(key: string): void {
    if (this.closed) throw new Error('état fermé');
    if (key.startsWith(HOST_PREFIX)) throw new Error('clé réservée au service');
  }

  private seal(key: string, value: unknown): Promise<Uint8Array> {
    return sealState(this.opts.crypto, this.kBox, this.opts.accessId, key, encodeEntry(value), this.opts.fixedIv?.(key));
  }

  private async open(key: string, stored: unknown): Promise<unknown> {
    const env = asBytes(stored);
    if (!env) throw new Error(`entrée d’état non chiffrée : ${key}`);
    if (this.closed) throw new Error('état fermé');
    return decodeEntry(await openState(this.opts.crypto, this.kBox, this.opts.accessId, key, env));
  }

  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(keyOrKeys)) {
      keyOrKeys.forEach((k) => this.check(k));
      const got = await this.raw.get<unknown>(keyOrKeys);
      const out = new Map<string, T>();
      for (const [k, v] of got) out.set(k, (await this.open(k, v)) as T);
      return out;
    }
    this.check(keyOrKeys);
    const v = await this.raw.get<unknown>(keyOrKeys);
    return v === undefined ? undefined : ((await this.open(keyOrKeys, v)) as T);
  }

  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof keyOrEntries === 'string') {
      this.check(keyOrEntries);
      await this.raw.put(keyOrEntries, await this.seal(keyOrEntries, value));
      return;
    }
    const sealed: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(keyOrEntries)) {
      this.check(k);
      sealed[k] = await this.seal(k, v);
    }
    await this.raw.put(sealed);
  }

  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (Array.isArray(keyOrKeys)) {
      keyOrKeys.forEach((k) => this.check(k));
      return this.raw.delete(keyOrKeys);
    }
    this.check(keyOrKeys);
    return this.raw.delete(keyOrKeys);
  }

  async list<T = unknown>(options: { prefix?: string; start?: string; end?: string; limit?: number } = {}): Promise<Map<string, T>> {
    if (this.closed) throw new Error('état fermé');
    const got = await this.raw.list<unknown>(options);
    const out = new Map<string, T>();
    // Le cache des blocs (`kv:`) n'est listé que pour ses CLÉS (élagage, effacement d'une base) :
    // ses valeurs (jusqu'à 256 Kio chacune) ne sont pas déchiffrées pour rien, elles valent `null`.
    const keysOnly = typeof options.prefix === 'string' && options.prefix.startsWith('kv:');
    for (const [k, v] of got) {
      if (k.startsWith(HOST_PREFIX)) continue;
      out.set(k, (keysOnly ? null : await this.open(k, v)) as T);
    }
    return out;
  }
}
