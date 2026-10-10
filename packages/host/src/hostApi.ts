/**
 * Le service parle à l'API principale — contrat `gate-heberge-1` § 2.2 et § 11.
 *
 *  - `signedFetch` : le `fetch` donné à la boîte (`CloudflareGate`) ; toute requête vers l'API
 *    principale (et seulement vers elle : jamais vers une base externe ni un webhook) porte, EN
 *    PLUS de `Filarr-Access`, l'en-tête `Filarr-Gate-Host` signé par `HOST_SIG`. Sans lui, l'API
 *    refuse le jeton d'une boîte hébergée (`401 hosted_origin_required`) ;
 *  - `HostApi` : les routes du service (`/api-access/hosted/*`), signées, sans jeton d'accès.
 *
 * Jamais un contenu ici : un jeton scellé (que l'API ne peut pas ouvrir), un paquet scellé, un
 * reçu, une annonce de version, des nombres d'appels.
 */

import type { HostPrivateKey } from './keys';
import { GATE_HOST_HEADER, hostRequestHeader, type ErasureReceipt, type VersionAnnouncement } from './wire';

export type SigningKeyFn = () => HostPrivateKey | null;

function bodyBytes(body: unknown): Uint8Array | null {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return null; // flux ou formulaire : la boîte n'en envoie jamais à l'API
}

/**
 * Un `fetch` qui signe les requêtes vers `apiUrl` (même origine). Une requête vers l'API dont le
 * corps ne se lit pas d'un bloc, ou sans clé de signature, n'est PAS envoyée : l'API la
 * refuserait de toute façon, et rien ne part sans la signature du service.
 */
export function signedFetch(apiUrl: string, key: SigningKeyFn, base: typeof fetch = (i, n) => fetch(i, n), now: () => number = () => Date.now()): typeof fetch {
  const origin = new URL(apiUrl).origin;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.origin !== origin) return base(input, init);
    const signer = key();
    if (!signer) throw new Error('host_key_missing');
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const bytes = bodyBytes(init?.body);
    if (!bytes) throw new Error('corps non signable');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(GATE_HOST_HEADER, hostRequestHeader(signer, method, url.pathname + url.search, Math.floor(now() / 1000), bytes));
    return base(url, { ...init, method, headers, body: bytes.length > 0 ? (bytes as unknown as BodyInit) : null });
  };
}

export class HostApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(`API principale : ${status} ${code}`);
    this.name = 'HostApiError';
  }
}

/** Ce que rend `GET /api-access/hosted/:id/token`. */
export interface HostedToken {
  accessId: string;
  hostName: string;
  keyId: string;
  sealedToken: string | null;
  state: 'running' | 'asleep' | 'erasing' | 'erased';
  sleepReason: string | null;
  sleepUntil: string | null;
  redirectTo: string | null;
  redirectUntil: string | null;
  exportPending: boolean;
  /** PH9 : la raison et l'heure de l'effacement demandé, quand `state = "erasing"` (absents d'une API d'avant). */
  eraseReason?: string | null;
  eraseRequestedAt?: string | null;
}

/** Ce que rend `GET /api-access/hosted/:id/pending`. */
export interface HostedPending {
  encPublicKey: string;
  bindSig: string;
  creatorTag: string;
  createdAt: string;
  expiresAt: string;
}

export class HostApi {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly apiUrl: string,
    key: SigningKeyFn,
    private readonly userAgent: string,
    base?: typeof fetch,
    now?: () => number
  ) {
    this.fetchImpl = signedFetch(apiUrl, key, base, now);
  }

  private url(path: string): URL {
    const b = this.apiUrl.endsWith('/') ? this.apiUrl : `${this.apiUrl}/`;
    return new URL(path.replace(/^\//, ''), b);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.url(path), {
      method,
      headers: { Accept: 'application/json', 'User-Agent': this.userAgent, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    let parsed: { success?: boolean; data?: T; code?: string } = {};
    try {
      parsed = (await res.json()) as typeof parsed;
    } catch {
      /* le statut suffit */
    }
    if (!res.ok || parsed.success === false) throw new HostApiError(res.status, typeof parsed.code === 'string' ? parsed.code : `http_${res.status}`);
    return (parsed.data ?? (parsed as unknown)) as T;
  }

  token(accessId: string): Promise<HostedToken> {
    return this.call('GET', `api-access/hosted/${accessId}/token`);
  }

  pending(accessId: string): Promise<HostedPending> {
    return this.call('GET', `api-access/hosted/${accessId}/pending`);
  }

  putExport(accessId: string, sealed: string): Promise<{ size: number }> {
    return this.call('PUT', `api-access/hosted/${accessId}/export`, { sealed });
  }

  receipt(accessId: string, receipt: ErasureReceipt, sig: string): Promise<{ state: string }> {
    return this.call('POST', `api-access/hosted/${accessId}/receipt`, { receipt, sig });
  }

  version(announcement: VersionAnnouncement & { sig: string }): Promise<{ accesses: number }> {
    return this.call('POST', 'api-access/hosted/version', announcement);
  }

  usage(items: Array<{ accessId: string; period: string; calls: number }>): Promise<{ recorded: number }> {
    return this.call('POST', 'api-access/hosted/usage', { items });
  }
}
