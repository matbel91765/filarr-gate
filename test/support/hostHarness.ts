/**
 * LE SERVICE HÉBERGÉ EN MÉMOIRE, pour les essais : le Worker de devant (`handleFront`), l'annuaire
 * et une `BoxRuntime` par accès, chacun sur un stockage d'objet durable en mémoire, branchés sur le
 * Filarr en mémoire (`MockFilarr`). Les réveils de l'API arrivent par l'adresse de contrôle, comme en
 * production ; rien ne sort de ce processus.
 */

import { toBase64Std } from '../../packages/core/src/engine/store/apiAccess';
import { curves } from '../../packages/gate/src/crypto/providers';
import { BoxRuntime, type RawStorage } from '../../packages/host/src/box';
import { Directory } from '../../packages/host/src/directory';
import type { HostEnv } from '../../packages/host/src/env';
import { clearFrontCache, handleFront } from '../../packages/host/src/front';
import { loadKeyring, type PinnedHostKey } from '../../packages/host/src/keys';

type Opts = { prefix?: string; start?: string; end?: string; limit?: number };

const clone = (v: unknown): unknown => (v instanceof Uint8Array ? v.slice() : v === undefined ? undefined : structuredClone(v));

/** Le stockage clé-valeur d'un objet durable SQLite, en mémoire (copie à l'écriture comme à la lecture). */
export class MemoryDoStorage implements RawStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;

  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  async get<T>(k: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(k)) {
      const out = new Map<string, T>();
      for (const key of k) if (this.data.has(key)) out.set(key, clone(this.data.get(key)) as T);
      return out;
    }
    return clone(this.data.get(k)) as T | undefined;
  }

  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  async put<T>(k: string | Record<string, T>, v?: T): Promise<void> {
    if (typeof k === 'string') this.data.set(k, clone(v));
    else for (const [key, value] of Object.entries(k)) this.data.set(key, clone(value));
  }

  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  async delete(k: string | string[]): Promise<boolean | number> {
    if (Array.isArray(k)) return k.filter((key) => this.data.delete(key)).length;
    return this.data.delete(k);
  }

  async list<T = unknown>(o: Opts = {}): Promise<Map<string, T>> {
    const keys = [...this.data.keys()].filter((k) => (!o.prefix || k.startsWith(o.prefix)) && (!o.start || k >= o.start) && (!o.end || k < o.end)).sort();
    const out = new Map<string, T>();
    for (const k of keys.slice(0, o.limit ?? keys.length)) out.set(k, clone(this.data.get(k)) as T);
    return out;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  async deleteAll(): Promise<void> {
    this.data.clear();
  }
}

/** Une paire de clés du service, de TEST, et son entrée épinglée. */
export function testHostKey(id = 'h-banc', seed = 7): { pinned: PinnedHostKey; env: Record<string, string> } {
  const enc = Uint8Array.from({ length: 32 }, (_, i) => (seed * 13 + i * 5 + 1) & 255);
  const sig = Uint8Array.from({ length: 32 }, (_, i) => (seed * 17 + i * 3 + 9) & 255);
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
  return {
    pinned: {
      id,
      encPublicKey: toBase64Std(curves.x25519PublicKey(enc)),
      signPublicKey: toBase64Std(curves.ed25519PublicKey(sig)),
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2036-01-01T00:00:00.000Z',
    },
    env: {
      HOST_ENC: JSON.stringify({ id, privateKey: b64(enc) }),
      HOST_SIG: JSON.stringify({ id, privateKey: b64(sig) }),
    },
  };
}

export const TEST_DOMAIN = 'gate.example.test';

/** Le service en mémoire : `fetch(url)` comme un client, `boxes` pour regarder dedans. */
export class HostHarness {
  readonly directoryStorage = new MemoryDoStorage();
  readonly directory = new Directory(this.directoryStorage);
  readonly storages = new Map<string, MemoryDoStorage>();
  readonly boxes = new Map<string, BoxRuntime>();
  private pending: Array<Promise<unknown>> = [];
  readonly env: HostEnv;
  now: () => number = () => Date.now();
  timing: { checkEveryMs?: number; usageEveryMs?: number } = {};

  constructor(
    readonly apiUrl: string,
    readonly key = testHostKey(),
    vars: Record<string, string> = {}
  ) {
    this.env = {
      GATE_BOX: null as unknown as DurableObjectNamespace,
      GATE_DIRECTORY: null as unknown as DurableObjectNamespace,
      GATE_HOST_DOMAIN: TEST_DOMAIN,
      FILARR_API_URL: apiUrl,
      ...key.env,
      ...vars,
    };
    clearFrontCache();
  }

  private ring() {
    return loadKeyring(this.env, [this.key.pinned]);
  }

  box(accessId: string): BoxRuntime {
    let box = this.boxes.get(accessId);
    if (!box) {
      const storage = new MemoryDoStorage();
      this.storages.set(accessId, storage);
      box = new BoxRuntime({
        storage,
        waitUntil: (p) => void this.pending.push(p.catch(() => undefined)),
        env: this.env,
        directory: { register: (h, a) => this.directory.register(h, a), tombstone: (h, a, r) => this.directory.tombstone(h, a, r) },
        now: () => this.now(),
        ring: this.ring(),
        timing: this.timing,
      });
      this.boxes.set(accessId, box);
    }
    return box;
  }

  /** Une requête de client vers `https://<hôte>.<domaine>…` (ou n'importe quelle adresse). */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const res = await handleFront(new Request(url, init), this.env, {
      directory: { lookup: (h) => this.directory.lookup(h) },
      box: (accessId) => ({ fetch: (r) => this.box(accessId).fetch(r) }),
      now: this.now,
      ring: this.ring(),
      cache: false,
    });
    return res;
  }

  /** Le `fetch` qu'emprunte le Filarr en mémoire pour réveiller : l'adresse de contrôle de CE service. */
  readonly wakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => this.fetch(String(input), init)) as typeof fetch;

  /** Attend tout ce que les boîtes font après avoir répondu (réveils, relectures, reçus). */
  async settle(rounds = 6): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      const batch = this.pending;
      this.pending = [];
      if (batch.length === 0) {
        await new Promise((r) => setTimeout(r, 20));
        if (this.pending.length === 0) return;
        continue;
      }
      await Promise.all(batch);
    }
  }

  async dispose(): Promise<void> {
    await this.settle();
    for (const box of this.boxes.values()) await box.dispose();
  }
}
