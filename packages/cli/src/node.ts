/**
 * Ce que Node apporte à la boîte noire : fichiers 0600 de l'état et du jeton,
 * journal par jour, fichiers de l'interface, et l'adaptateur HTTP qui traduit
 * `IncomingMessage` / `ServerResponse` en `Request` / `Response`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ConnInfo } from '../../server/src/http';
import type { JournalSink } from '../../server/src/journal';
import type { StateBackend } from '../../server/src/state';
import type { BlobStore } from '../../server/src/sync/runner';

/** Écriture atomique, droits 0600. */
export function writeSecret(path: string, content: string | Uint8Array): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows : les droits POSIX n'existent pas */
  }
  renameSync(tmp, path);
}

/**
 * Le répertoire d'état (`FILARR_GATE_STATE_DIR`) :
 * - `token` : le jeton Filarr, 0600, jamais journalisé (absent s'il vient de l'environnement) ;
 * - `state.json` (0600) : l'état (voir `server/src/state.ts`) ;
 * - `blocks/` : le cache des blocs CHIFFRÉS ; `journal/` : le journal local ;
 * - `sync/` : les ombres des synchros externes, CHIFFRÉES.
 */
export class StateDir {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  get blocksDir(): string {
    return join(this.dir, 'blocks');
  }

  get journalDir(): string {
    return join(this.dir, 'journal');
  }

  get syncDir(): string {
    return join(this.dir, 'sync');
  }

  readState(): string | null {
    const file = join(this.dir, 'state.json');
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }

  backend(): StateBackend {
    return {
      location: this.dir,
      save: (json) => writeSecret(join(this.dir, 'state.json'), json),
      wipe: () => {
        rmSync(join(this.dir, 'state.json'), { force: true });
      },
    };
  }

  readToken(): string | null {
    const file = join(this.dir, 'token');
    return existsSync(file) ? readFileSync(file, 'utf8').trim() || null : null;
  }

  writeToken(token: string): void {
    writeSecret(join(this.dir, 'token'), `${token.trim()}\n`);
  }

  deleteToken(): void {
    rmSync(join(this.dir, 'token'), { force: true });
  }

  /** Oublie cette machine (l'état se réécrit neuf ensuite). */
  wipe(): void {
    rmSync(join(this.dir, 'token'), { force: true });
    rmSync(this.blocksDir, { recursive: true, force: true });
    rmSync(this.journalDir, { recursive: true, force: true });
    rmSync(this.syncDir, { recursive: true, force: true });
  }
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Les ombres chiffrées des synchros externes, en fichiers 0600 (`sync/<nom>.bin`). */
export function fileBlobs(dir: string): BlobStore {
  const safe = (name: string): string => {
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(name)) throw new Error('nom de fichier refusé');
    return join(dir, `${name}.bin`);
  };
  return {
    async get(name) {
      try {
        return new Uint8Array(await readFile(safe(name)));
      } catch {
        return null;
      }
    },
    async put(name, data) {
      await mkdir(dir, { recursive: true });
      writeSecret(safe(name), data);
    },
    async delete(name) {
      await rm(safe(name), { force: true });
    },
  };
}

/** Le journal en fichiers JSON Lines par jour, 0600. */
export function fileJournalSink(dir: string): JournalSink {
  return {
    async append(day, line) {
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, `${day}.jsonl`), line, { mode: 0o600 });
    },
    async exportAll() {
      const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => DAY_FILE.test(f)).sort();
      let out = '';
      for (const f of files) out += await readFile(join(dir, f), 'utf8').catch(() => '');
      return out;
    },
    async prune(beforeDay) {
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        const m = DAY_FILE.exec(f);
        if (m && m[1]! < beforeDay) await rm(join(dir, f), { force: true });
      }
    },
    async clear() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// ==================== Les fichiers de l'interface ====================

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

/** Où sont les fichiers de l'interface : `dist/ui` à côté du paquet. */
export function uiRoot(): string | null {
  const here = fileURLToPath(new URL('.', import.meta.url));
  for (const candidate of [join(here, 'ui'), join(here, '..', 'dist', 'ui'), join(here, '..', '..', 'cli', 'dist', 'ui')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

/** Un fichier de l'interface (`null` : absent ou hors du dossier). */
export function serveUiFile(root: string | null, rel: string): Response | null {
  if (!root) return null;
  const file = resolve(root, normalize(rel || 'index.html'));
  if (!file.startsWith(resolve(root) + sep)) return null;
  if (!existsSync(file) || statSync(file).isDirectory()) return null;
  const ext = extname(file);
  return new Response(readFileSync(file), {
    status: 200,
    headers: {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    },
  });
}

// ==================== L'adaptateur HTTP ====================

export type FetchHandler = (request: Request, conn: ConnInfo) => Promise<Response>;

/** Un gestionnaire `(Request) → Response` servi par `node:http`. */
export function nodeListener(handler: FetchHandler, scheme: () => 'http' | 'https' = () => 'http') {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const host = req.headers.host ?? 'localhost';
    const url = `${scheme()}://${host}${req.url ?? '/'}`;
    const method = (req.method ?? 'GET').toUpperCase();
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const x of v) headers.append(k, x);
      else headers.set(k, v);
    }
    const hasBody = method !== 'GET' && method !== 'HEAD';
    let request: Request;
    try {
      request = new Request(url, {
        method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(req) as unknown as BodyInit, duplex: 'half' } : {}),
      } as RequestInit);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const conn: ConnInfo = { remoteAddress: req.socket.remoteAddress ?? '' };
    void handler(request, conn)
      .then(async (response) => {
        const out: Record<string, string | string[]> = {};
        response.headers.forEach((value, key) => {
          if (key === 'set-cookie') {
            const prev = out[key];
            out[key] = prev ? [...(Array.isArray(prev) ? prev : [prev]), value] : value;
          } else out[key] = value;
        });
        res.writeHead(response.status, out);
        if (!response.body || method === 'HEAD') {
          res.end();
          return;
        }
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) await new Promise((r) => res.once('drain', r));
        }
        res.end();
      })
      .catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: (err as Error).message, code: 'internal' }));
        } else res.destroy();
      });
  };
}
