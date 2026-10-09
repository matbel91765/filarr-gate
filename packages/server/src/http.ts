/**
 * HTTP sans moteur : des `Request` et des `Response` (API Fetch), que Node
 * (adaptateur de `filarr-gate`) et un Worker Cloudflare servent tels quels.
 */

import { ApiError } from '../../gate/src/data/query';

/** Ce que l'hôte sait de la connexion (l'adresse vue par la socket). */
export interface ConnInfo {
  /** Adresse de l'autre bout de la connexion (avant tout mandataire). */
  remoteAddress: string;
}

export const MAX_JSON_BODY = 4 * 1024 * 1024;

const BASE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...BASE_HEADERS, ...headers },
  });
}

export function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...BASE_HEADERS, ...headers } });
}

export function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

/** Lit le corps entier, borné : au-delà, `413 body_too_large`. */
export async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new ApiError(413, 'body_too_large', 'Corps trop lourd');
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError(413, 'body_too_large', 'Corps trop lourd');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Un corps JSON (vide : `undefined`) ; `400 bad_json` s'il est illisible. */
export async function readJson(request: Request, limit = MAX_JSON_BODY): Promise<unknown> {
  const bytes = await readBody(request, limit);
  const body = new TextDecoder().decode(bytes);
  if (body.trim() === '') return undefined;
  try {
    return JSON.parse(body);
  } catch {
    throw new ApiError(400, 'bad_json', 'JSON illisible');
  }
}

/** L'adresse d'une requête : celle de la socket, ou `X-Forwarded-For` derrière un mandataire de confiance. */
export function clientIp(request: Request, conn: ConnInfo, trusted: readonly string[], inRange: (ip: string, cidr: string) => boolean): string {
  const remote = conn.remoteAddress ?? '';
  if (trusted.some((t) => inRange(remote, t))) {
    const fwd = String(request.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim();
    if (fwd) return fwd;
  }
  return remote.replace(/^::ffff:/, '');
}

export const isLoopback = (ip: string): boolean => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.');

/** Un refus de l'API en réponse JSON (`{ error, code, … }`, `Retry-After` sur un 429). */
export function errorResponse(err: unknown, extraHeaders: Record<string, string> = {}): { response: Response; error: ApiError } {
  const e = err instanceof ApiError ? err : new ApiError(500, 'internal', (err as Error)?.message ?? String(err));
  const headers: Record<string, string> = { ...extraHeaders };
  if (e.status === 429 && typeof e.extra.retryAfter === 'number') headers['Retry-After'] = String(e.extra.retryAfter);
  return { response: json(e.status, { error: e.message, code: e.code, ...e.extra }, headers), error: e };
}
