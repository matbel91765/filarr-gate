/**
 * Le client HTTP de l'API Filarr, vu par un ACCÈS (contrat `api-base-1` § 5 et § 6).
 *
 * Chaque requête porte la preuve de l'accès (`Authorization: Filarr-Access …`),
 * jamais le jeton : le `secret` ne quitte pas la boîte noire. Les en-têtes de
 * quota de chaque réponse sont relevés (`RateLimit-*`, `X-Filarr-Quota`).
 *
 * Trois sortes d'échecs, comme `db-store-1` § 9 bis :
 *  - INJOIGNABLE (`UnreachableError`) : pas de réponse, délai dépassé, `5xx` ;
 *  - DÉBIT ou QUOTA (`RateLimitError`) : `429`, avec son code et `Retry-After` ;
 *  - REFUSÉ (`FilarrError`) : toute autre réponse en erreur, avec son code.
 */

export const SYNC_CAPS = 'db-store-1, api-base-1';

export class UnreachableError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'UnreachableError';
  }
}

export class RateLimitError extends Error {
  readonly status = 429;
  constructor(
    readonly code: string,
    /** Délai demandé par le serveur, en millisecondes (`Retry-After`), sinon une minute. */
    readonly retryAfterMs: number
  ) {
    super(`Filarr limite cet accès (${code}), nouvel essai dans ${Math.ceil(retryAfterMs / 1000)} s`);
    this.name = 'RateLimitError';
  }
}

export class FilarrError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown>
  ) {
    super(`Filarr a refusé (${status} ${code})`);
    this.name = 'FilarrError';
  }
}

export interface QuotaCounter {
  used: number;
  max: number;
}

/** Ce que disent les en-têtes de la dernière réponse (§ 6). */
export interface QuotaSnapshot {
  sync?: QuotaCounter;
  bytes?: QuotaCounter;
  writes?: QuotaCounter;
  rate?: { limit: number; remaining: number; resetSeconds: number };
  at: string;
}

export interface ClientStats {
  requests: number;
  bytesIn: number;
  failures: number;
  lastAt: string | null;
  /** Pointe de requêtes vers Filarr sur une minute (débit, § 6). */
  peakPerMinute: number;
}

export interface ExchangeInfo {
  method: string;
  path: string;
  status: number;
  ms: number;
  bytes: number;
  code?: string;
}

export interface FilarrClientOptions {
  baseUrl: string;
  authorization: string;
  version: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Appelé après chaque réponse (journal, métriques). */
  onExchange?: (info: ExchangeInfo) => void;
}

/** `Retry-After` en millisecondes : des secondes, ou une date HTTP. */
export function parseRetryAfter(value: string | null, fallbackMs = 60_000): number {
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return fallbackMs;
}

type QuotaName = 'sync' | 'bytes' | 'writes';

/** `X-Filarr-Quota: sync=<n>/<max>; bytes=<n>/<max>; writes=<n>/<max>` */
export function parseQuotaHeader(value: string | null): Partial<Record<QuotaName, QuotaCounter>> {
  const out: Partial<Record<QuotaName, QuotaCounter>> = {};
  if (!value) return out;
  for (const part of value.split(';')) {
    const m = /^\s*(sync|bytes|writes)\s*=\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(part);
    if (m) out[m[1] as QuotaName] = { used: Number(m[2]), max: Number(m[3]) };
  }
  return out;
}

export class FilarrClient {
  readonly quota: QuotaSnapshot = { at: new Date(0).toISOString() };
  readonly stats: ClientStats = { requests: 0, bytesIn: 0, failures: 0, lastAt: null, peakPerMinute: 0 };
  private minuteStart = 0;
  private minuteCount = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: FilarrClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  /** Les en-têtes de toute requête d'un accès. */
  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: this.opts.authorization,
      'X-Filarr-Gate': this.opts.version,
      'X-Filarr-Sync-Caps': SYNC_CAPS,
      'User-Agent': `filarr-gate/${this.opts.version}`,
      ...extra,
    };
  }

  /** L'adresse complète d'un chemin de l'API. */
  url(path: string): URL {
    const base = this.opts.baseUrl.endsWith('/') ? this.opts.baseUrl : `${this.opts.baseUrl}/`;
    return new URL(path.replace(/^\//, ''), base);
  }

  private countRequest(): void {
    const now = Date.now();
    if (now - this.minuteStart >= 60_000) {
      this.minuteStart = now;
      this.minuteCount = 0;
    }
    this.minuteCount += 1;
    if (this.minuteCount > this.stats.peakPerMinute) this.stats.peakPerMinute = this.minuteCount;
    this.stats.requests += 1;
  }

  private readHeaders(res: Response): void {
    const quota = parseQuotaHeader(res.headers.get('x-filarr-quota'));
    Object.assign(this.quota, quota);
    const limit = Number(res.headers.get('ratelimit-limit'));
    const remaining = Number(res.headers.get('ratelimit-remaining'));
    const reset = Number(res.headers.get('ratelimit-reset'));
    if (res.headers.has('ratelimit-limit') && Number.isFinite(limit)) {
      this.quota.rate = {
        limit,
        remaining: Number.isFinite(remaining) ? remaining : 0,
        resetSeconds: Number.isFinite(reset) ? reset : 60,
      };
    }
    if (Object.keys(quota).length > 0 || res.headers.has('ratelimit-limit'))
      this.quota.at = new Date().toISOString();
  }

  /** Une requête brute ; lève selon les trois sortes d'échecs. */
  async raw(
    method: string,
    path: string,
    init: { json?: unknown; body?: Uint8Array; accept?: string } = {}
  ): Promise<Response> {
    const headers = this.headers({ Accept: init.accept ?? 'application/json' });
    let body: string | Uint8Array | undefined;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.body) {
      headers['Content-Type'] = 'application/octet-stream';
      body = init.body;
    }
    const started = Date.now();
    this.countRequest();
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        method,
        headers,
        body: body as never,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      this.stats.failures += 1;
      this.opts.onExchange?.({ method, path, status: 0, ms: Date.now() - started, bytes: 0, code: 'unreachable' });
      throw new UnreachableError(`Filarr injoignable : ${(err as Error).message}`);
    }
    this.stats.lastAt = new Date().toISOString();
    this.readHeaders(res);
    if (res.ok) return res;

    this.stats.failures += 1;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      /* corps illisible : le statut suffit */
    }
    const data = (parsed.data && typeof parsed.data === 'object' ? parsed.data : {}) as Record<string, unknown>;
    const merged = { ...data, ...parsed };
    const code = typeof parsed.code === 'string' ? parsed.code : `http_${res.status}`;
    this.opts.onExchange?.({ method, path, status: res.status, ms: Date.now() - started, bytes: 0, code });
    if (res.status === 429) throw new RateLimitError(code, parseRetryAfter(res.headers.get('retry-after')));
    if (res.status >= 500) throw new UnreachableError(`Filarr indisponible (${res.status} ${code})`, res.status);
    throw new FilarrError(res.status, code, merged);
  }

  /** Une route à enveloppe `{ success, data }` : rend `data`. */
  async json<T>(method: string, path: string, json?: unknown): Promise<T> {
    const started = Date.now();
    const res = await this.raw(method, path, json === undefined ? {} : { json });
    const text = await res.text();
    this.stats.bytesIn += text.length;
    this.opts.onExchange?.({ method, path, status: res.status, ms: Date.now() - started, bytes: text.length });
    let parsed: { success?: boolean; data?: T; code?: string };
    try {
      parsed = JSON.parse(text) as { success?: boolean; data?: T; code?: string };
    } catch {
      throw new FilarrError(res.status, 'bad_json', {});
    }
    if (parsed.success === false)
      throw new FilarrError(res.status, parsed.code ?? 'refused', parsed as Record<string, unknown>);
    return (parsed.data ?? (parsed as unknown)) as T;
  }

  /** Une route d'octets bruts (`GET /dbstore/:id/slots/:p/:ver`). */
  async bytes(method: string, path: string): Promise<Uint8Array> {
    const started = Date.now();
    const res = await this.raw(method, path, { accept: 'application/octet-stream' });
    const out = new Uint8Array(await res.arrayBuffer());
    this.stats.bytesIn += out.length;
    this.opts.onExchange?.({ method, path, status: res.status, ms: Date.now() - started, bytes: out.length });
    return out;
  }

  /** Une route qui reçoit des octets et rend une enveloppe (`PUT /dbstore/:id/stage`). */
  async putBytes<T>(path: string, body: Uint8Array): Promise<T> {
    const res = await this.raw('PUT', path, { body });
    const parsed = (await res.json()) as { data?: T };
    return (parsed.data ?? (parsed as unknown)) as T;
  }
}
