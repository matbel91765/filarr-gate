/**
 * Ce que partagent les essais d'examples/ : lancer un script comme une personne le lance (node,
 * python, bash), trouver les interprètes, un port libre, et un mandataire qui répond UN 429 avant
 * de tout transmettre (le traitement de `Retry-After` de chaque client tourne donc pour de vrai).
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer as createHttp, type Server } from 'node:http';
import { createServer as createNet, type AddressInfo } from 'node:net';
import { join } from 'node:path';

export const repo = join(__dirname, '..', '..');

export interface Run {
  code: number | null;
  lines: string[];
  child: ChildProcess;
  done: Promise<{ code: number | null; lines: string[] }>;
}

/** Lance une commande ; `onLine` voit chaque ligne de sa sortie au fil de l'eau. */
export function start(cmd: string, args: string[], env: Record<string, string>, onLine?: (line: string, all: string[]) => void, cwd = repo): Run {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', ...env } });
  const lines: string[] = [];
  const feed = (prefix: string) => {
    let buf = '';
    return (c: Buffer) => {
      buf += c.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        lines.push(prefix + line);
        onLine?.(prefix + line, lines);
      }
    };
  };
  child.stdout!.on('data', feed(''));
  child.stderr!.on('data', feed('[stderr] '));
  const run: Run = {
    code: null,
    lines,
    child,
    done: new Promise((resolve) => child.on('exit', (code) => resolve({ code: (run.code = code), lines }))),
  };
  return run;
}

/** Lance une commande jusqu'au bout. */
export function run(cmd: string, args: string[], env: Record<string, string>, onLine?: (line: string, all: string[]) => void, cwd = repo) {
  return start(cmd, args, env, onLine, cwd).done;
}

/** Un interprète Python 3, ou null (les exemples Python sont alors sautés, et le disent). */
export const python: string | null = (() => {
  for (const cmd of ['python3', 'python']) {
    try {
      const out = execFileSync(cmd, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (/Python 3\.(1[0-9]|[89])/.test(out)) return cmd;
    } catch {
      /* le suivant */
    }
  }
  return null;
})();

/** bash avec curl (Git Bash sous Windows, jamais celui de WSL), ou null. */
export const bash: string | null = (() => {
  const candidates = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'] : ['/bin/bash', '/usr/bin/bash'];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      execFileSync(c, ['-c', 'curl --version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* pas de curl */
    }
  }
  return null;
})();

export const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const srv = createNet();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });

/**
 * Un mandataire devant la boîte : la PREMIÈRE requête reçoit `429` avec `Retry-After: 1` (comme
 * une clé dont le débit est épuisé), toutes les autres passent telles quelles à la boîte.
 */
export async function proxyWithOne429(target: string): Promise<{ url: string; refused: () => number; close: () => Promise<void> }> {
  let refused = 0;
  let first = true;
  const server: Server = createHttp((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      if (first) {
        first = false;
        refused += 1;
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
        res.end(JSON.stringify({ error: 'Débit de la clé atteint', code: 'key_rate', retryAfter: 1 }));
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'host' && k !== 'content-length') headers[k] = v;
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const upstream = await fetch(`${target}${req.url}`, { method: req.method, headers, ...(body && req.method !== 'GET' ? { body } : {}) });
      const out: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        if (k !== 'content-encoding' && k !== 'content-length' && k !== 'transfer-encoding') out[k] = v;
      });
      res.writeHead(upstream.status, out);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    refused: () => refused,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
