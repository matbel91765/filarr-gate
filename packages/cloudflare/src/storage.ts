/**
 * Le stockage de l'objet durable (API clé-valeur d'un objet durable SQLite),
 * derrière les interfaces portables de la boîte noire :
 *  - l'état (`StateBackend`) et les ombres des synchros (`BlobStore`) en morceaux
 *    de 1 Mio (une valeur d'objet durable est bornée) ;
 *  - le cache des blocs CHIFFRÉS (`KvStore` pour `KvBlockCache`) ;
 *  - le journal (`JournalSink`), tamponné et versé en une écriture par requête.
 * Tout y reste chiffré comme sur un disque : blocs et ombres sous les clés de
 * Filarr, clés des bases externes sous la clé locale tirée du jeton.
 */

import type { KvStore } from '../../gate/src/replica/blockCache';
import type { JournalSink } from '../../server/src/journal';
import type { StateBackend } from '../../server/src/state';
import type { BlobStore } from '../../server/src/sync/runner';

const CHUNK = 1024 * 1024;

/** Ce que la boîte demande au stockage d'un objet durable (sous-ensemble de `DurableObjectStorage`). */
export interface DoStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list<T = unknown>(options?: { prefix?: string; start?: string; end?: string; limit?: number }): Promise<Map<string, T>>;
}

const toBytes = (v: unknown): Uint8Array | null => {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
};

/** Une valeur en morceaux : `<nom>` porte le nombre de morceaux, `<nom>#<i>` chaque morceau. */
export async function putChunked(storage: DoStorage, name: string, data: Uint8Array): Promise<void> {
  const n = Math.max(1, Math.ceil(data.length / CHUNK));
  const old = (await storage.get<number>(name)) ?? 0;
  const entries: Record<string, unknown> = { [name]: n };
  for (let i = 0; i < n; i += 1) entries[`${name}#${i}`] = data.slice(i * CHUNK, (i + 1) * CHUNK);
  await storage.put(entries);
  if (old > n) await storage.delete(Array.from({ length: old - n }, (_, k) => `${name}#${n + k}`));
}

export async function getChunked(storage: DoStorage, name: string): Promise<Uint8Array | null> {
  const n = await storage.get<number>(name);
  if (typeof n !== 'number' || n < 1) return null;
  const keys = Array.from({ length: n }, (_, i) => `${name}#${i}`);
  const parts = await storage.get<Uint8Array>(keys);
  const chunks: Uint8Array[] = [];
  for (const k of keys) {
    const part = toBytes(parts.get(k));
    if (!part) return null;
    chunks.push(part);
  }
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export async function deleteChunked(storage: DoStorage, name: string): Promise<void> {
  const n = (await storage.get<number>(name)) ?? 0;
  await storage.delete([name, ...Array.from({ length: n }, (_, i) => `${name}#${i}`)]);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function readState(storage: DoStorage): Promise<string | null> {
  const bytes = await getChunked(storage, 'state');
  return bytes ? dec.decode(bytes) : null;
}

/** L'état : chaque sauvegarde part tout de suite ; `flushed()` attend la dernière. */
export function doStateBackend(storage: DoStorage): StateBackend & { flushed(): Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  return {
    location: null,
    save(json) {
      chain = chain.then(() => putChunked(storage, 'state', enc.encode(json))).catch(() => undefined);
      return chain;
    },
    async wipe() {
      await chain;
      await deleteChunked(storage, 'state');
    },
    flushed: () => chain,
  };
}

/** Le cache des blocs chiffrés : une valeur par bloc (un bloc pèse au plus 256 Kio). */
export function doKvStore(storage: DoStorage, prefix = 'kv:'): KvStore {
  return {
    async get(key) {
      const v = await storage.get(prefix + key);
      return typeof v === 'string' ? v : (toBytes(v) ?? null);
    },
    async put(key, value) {
      await storage.put(prefix + key, value);
    },
    async delete(key) {
      await storage.delete(prefix + key);
    },
    async list(p) {
      return [...(await storage.list({ prefix: prefix + p })).keys()].map((k) => k.slice(prefix.length));
    },
  };
}

/** Les ombres chiffrées des synchros externes. */
export function doBlobs(storage: DoStorage): BlobStore {
  const key = (name: string) => {
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(name)) throw new Error('nom refusé');
    return `blob:${name}`;
  };
  return {
    get: (name) => getChunked(storage, key(name)),
    put: (name, data) => putChunked(storage, key(name), data),
    delete: (name) => deleteChunked(storage, key(name)),
  };
}

/**
 * Le journal : les lignes s'accumulent en mémoire et partent en UNE écriture
 * (`jl:<jour>:<horodatage>`) quand l'hôte appelle `flush()` — à la fin de
 * chaque requête et de chaque alarme.
 */
export function doJournalSink(storage: DoStorage): JournalSink & { flush(): Promise<void> } {
  const pending = new Map<string, string>();
  let seq = 0;
  const flush = async () => {
    if (pending.size === 0) return;
    const entries: Record<string, string> = {};
    for (const [day, lines] of pending) entries[`jl:${day}:${String(Date.now()).padStart(15, '0')}-${String((seq += 1)).padStart(6, '0')}`] = lines;
    pending.clear();
    await storage.put(entries);
  };
  return {
    async append(day, line) {
      pending.set(day, (pending.get(day) ?? '') + line);
    },
    async exportAll() {
      await flush();
      return [...(await storage.list<string>({ prefix: 'jl:' })).values()].join('');
    },
    async prune(beforeDay) {
      await flush();
      const old = [...(await storage.list({ prefix: 'jl:', end: `jl:${beforeDay}` })).keys()];
      for (let i = 0; i < old.length; i += 128) await storage.delete(old.slice(i, i + 128));
    },
    async clear() {
      pending.clear();
      const all = [...(await storage.list({ prefix: 'jl:' })).keys()];
      for (let i = 0; i < all.length; i += 128) await storage.delete(all.slice(i, i + 128));
    },
    flush,
  };
}
