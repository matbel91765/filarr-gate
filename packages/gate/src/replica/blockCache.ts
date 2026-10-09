/**
 * Le cache des blocs CHIFFRÉS (contrat `db-store-1` § 9 bis, point 1).
 *
 * Un bloc `(storeId, p, ver)` est immuable : une réécriture change `ver`. Le cache
 * range les corps tels que le serveur les garde, chiffrés, adressés par leur
 * contenu (SHA-256 du corps), avec un index `p|ver → empreinte` par magasin. Il
 * ne contient jamais un clair ni une clé : un corps lu ici est vérifié contre le
 * `mac` de la tête avant d'être ouvert, comme s'il arrivait du serveur. Un cache
 * qui échoue ne fait jamais échouer la lecture : le bloc est redemandé.
 */

import { sha256Hex } from '../util/bytes';

export interface BlockCache {
  get(storeId: string, p: string, ver: number): Promise<Uint8Array | null>;
  put(storeId: string, p: string, ver: number, body: Uint8Array): Promise<void>;
  /** Oublie tout bloc du magasin que `keep` (`p|ver`) ne désigne plus. */
  prune(storeId: string, keep: ReadonlySet<string>): Promise<void>;
  /** Oublie un magasin entier (droit retiré). */
  drop(storeId: string): Promise<void>;
  /** Oublie tout (révocation, oubli de la machine). */
  clear(): Promise<void>;
  /** Octets rangés. */
  size(): Promise<number>;
  readonly kind: 'disk' | 'memory' | 'kv';
  readonly location: string | null;
}

export const refOf = (p: string, ver: number): string => `${p}|${ver}`;
export const sha256 = (body: Uint8Array): string => sha256Hex(body);

export class MemoryBlockCache implements BlockCache {
  readonly kind = 'memory' as const;
  readonly location = null;
  private stores = new Map<string, Map<string, Uint8Array>>();
  async get(storeId: string, p: string, ver: number) {
    return this.stores.get(storeId)?.get(refOf(p, ver)) ?? null;
  }
  async put(storeId: string, p: string, ver: number, body: Uint8Array) {
    let map = this.stores.get(storeId);
    if (!map) this.stores.set(storeId, (map = new Map()));
    map.set(refOf(p, ver), body);
  }
  async prune(storeId: string, keep: ReadonlySet<string>) {
    const map = this.stores.get(storeId);
    if (!map) return;
    for (const ref of [...map.keys()]) if (!keep.has(ref)) map.delete(ref);
  }
  async drop(storeId: string) {
    this.stores.delete(storeId);
  }
  async clear() {
    this.stores.clear();
  }
  async size() {
    let n = 0;
    for (const map of this.stores.values()) for (const b of map.values()) n += b.length;
    return n;
  }
}

/**
 * Un stockage clé-valeur asynchrone (le stockage d'un objet durable Cloudflare,
 * un KV, une Map) : de quoi ranger le cache des blocs chiffrés hors de Node.
 */
export interface KvStore {
  get(key: string): Promise<Uint8Array | string | null | undefined>;
  put(key: string, value: Uint8Array | string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/** Le cache des blocs CHIFFRÉS sur un stockage clé-valeur : `blk:<storeId>:<p>|<ver>`. */
export class KvBlockCache implements BlockCache {
  readonly kind = 'kv' as const;
  readonly location = null;
  constructor(private readonly kv: KvStore, private readonly prefix = 'blk:') {}
  private key(storeId: string, p: string, ver: number): string {
    return `${this.prefix}${storeId}:${refOf(p, ver)}`;
  }
  async get(storeId: string, p: string, ver: number) {
    try {
      const v = await this.kv.get(this.key(storeId, p, ver));
      return v instanceof Uint8Array ? v : null;
    } catch {
      return null;
    }
  }
  async put(storeId: string, p: string, ver: number, body: Uint8Array) {
    await this.kv.put(this.key(storeId, p, ver), body).catch(() => undefined);
  }
  async prune(storeId: string, keep: ReadonlySet<string>) {
    const base = `${this.prefix}${storeId}:`;
    for (const k of await this.kv.list(base).catch(() => [] as string[])) {
      if (!keep.has(k.slice(base.length))) await this.kv.delete(k).catch(() => undefined);
    }
  }
  async drop(storeId: string) {
    for (const k of await this.kv.list(`${this.prefix}${storeId}:`).catch(() => [] as string[])) await this.kv.delete(k).catch(() => undefined);
  }
  async clear() {
    for (const k of await this.kv.list(this.prefix).catch(() => [] as string[])) await this.kv.delete(k).catch(() => undefined);
  }
  async size() {
    let n = 0;
    for (const k of await this.kv.list(this.prefix).catch(() => [] as string[])) {
      const v = await this.kv.get(k).catch(() => null);
      if (v instanceof Uint8Array) n += v.length;
    }
    return n;
  }
}
