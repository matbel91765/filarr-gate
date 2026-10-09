/**
 * Le cache des blocs CHIFFRÉS sur le disque (Node seulement) : corps adressés par
 * leur contenu (SHA-256), index `p|ver → empreinte` par magasin. Chargé à la
 * demande par la bibliothèque (`cache: { dir }`) et par le serveur.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { refOf, sha256, type BlockCache } from '../replica/blockCache';

const STORE_DIR_RE = /^[A-Za-z0-9_-]{22}$/;

export class DiskBlockCache implements BlockCache {
  readonly kind = 'disk' as const;
  private indexes = new Map<string, Record<string, string>>();
  private writes = new Map<string, Promise<void>>();

  constructor(readonly location: string) {}

  private dir(storeId: string): string {
    if (!STORE_DIR_RE.test(storeId)) throw new Error('identifiant de magasin invalide');
    return join(this.location, storeId);
  }

  private async index(storeId: string): Promise<Record<string, string>> {
    const known = this.indexes.get(storeId);
    if (known) return known;
    let index: Record<string, string> = {};
    try {
      const parsed = JSON.parse(await readFile(join(this.dir(storeId), 'index.json'), 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object') index = parsed as Record<string, string>;
    } catch {
      /* pas encore d'index */
    }
    this.indexes.set(storeId, index);
    return index;
  }

  /** Les écritures d'un magasin passent l'une après l'autre (l'index est un seul fichier). */
  private serial(storeId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(storeId) ?? Promise.resolve();
    const next = previous.then(task, task).catch(() => undefined);
    this.writes.set(storeId, next);
    return next;
  }

  private async saveIndex(storeId: string): Promise<void> {
    const index = await this.index(storeId);
    await mkdir(this.dir(storeId), { recursive: true });
    await writeFile(join(this.dir(storeId), 'index.json'), JSON.stringify(index), { mode: 0o600 });
  }

  async get(storeId: string, p: string, ver: number): Promise<Uint8Array | null> {
    try {
      const hash = (await this.index(storeId))[refOf(p, ver)];
      if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
      const body = new Uint8Array(await readFile(join(this.dir(storeId), hash)));
      // Un fichier abîmé sur le disque ne ressort jamais : son empreinte ne correspondrait plus
      return sha256(body) === hash ? body : null;
    } catch {
      return null;
    }
  }

  put(storeId: string, p: string, ver: number, body: Uint8Array): Promise<void> {
    return this.serial(storeId, async () => {
      const hash = sha256(body);
      await mkdir(this.dir(storeId), { recursive: true });
      await writeFile(join(this.dir(storeId), hash), body, { mode: 0o600 });
      (await this.index(storeId))[refOf(p, ver)] = hash;
      await this.saveIndex(storeId);
    });
  }

  prune(storeId: string, keep: ReadonlySet<string>): Promise<void> {
    return this.serial(storeId, async () => {
      const index = await this.index(storeId);
      for (const ref of Object.keys(index)) if (!keep.has(ref)) delete index[ref];
      await this.saveIndex(storeId);
      const live = new Set(Object.values(index));
      for (const name of await readdir(this.dir(storeId)).catch(() => [] as string[])) {
        if (/^[0-9a-f]{64}$/.test(name) && !live.has(name)) await rm(join(this.dir(storeId), name), { force: true });
      }
    });
  }

  async drop(storeId: string): Promise<void> {
    await this.serial(storeId, async () => {
      this.indexes.delete(storeId);
      await rm(this.dir(storeId), { recursive: true, force: true });
    });
  }

  async clear(): Promise<void> {
    await Promise.all([...this.writes.values()]);
    this.indexes.clear();
    await rm(this.location, { recursive: true, force: true });
  }

  async size(): Promise<number> {
    let total = 0;
    for (const store of await readdir(this.location).catch(() => [] as string[])) {
      for (const name of await readdir(join(this.location, store)).catch(() => [] as string[])) {
        total += (await stat(join(this.location, store, name)).catch(() => ({ size: 0 }))).size;
      }
    }
    return total;
  }
}
