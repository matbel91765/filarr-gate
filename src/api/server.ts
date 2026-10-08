/**
 * L'API LOCALE de la boîte noire : HTTP(S), servie depuis la copie en mémoire.
 *
 *   GET    /health                  santé (sans clé)
 *   GET    /metrics                 Prometheus (si activé)
 *   GET    /openapi.json, /docs     description (publique si « docs » est activé, sinon avec une clé)
 *   POST   /mcp                     serveur MCP (si activé ; clé avec le droit MCP)
 *   POST   /v1/sql                  SELECT en lecture seule
 *   GET    /v1/q/<requête>          une requête enregistrée
 *   GET    /v1/<base>               les lignes (filtres, tri, champs, pages)
 *   GET    /v1/<base>/<vue>         la vue rejouée par le moteur de Filarr
 *   GET    /v1/<base>/rows/<id>     une ligne
 *   POST   /v1/<base>[/rows]        ajouter (écriture allumée, droit rw, clé autorisée)
 *   PATCH  /v1/<base>[/rows]/<id>   modifier
 *   DELETE /v1/<base>[/rows]/<id>   supprimer
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Journal, JournalKind } from '../journal';
import type { Metrics } from '../metrics';
import type { Replicator } from '../replica/replicator';
import type { AppKeyRecord, StateStore } from '../state';
import type { Settings } from '../config';
import { canReadBase, canReadQuery, canReadView, canWrite, ipInRange, type KeyRegistry, type WriteOp } from './keys';
import type { McpServer } from './mcp';
import type { BaseInfo, GateModel } from './model';
import { buildOpenApi, docsHtml } from './openapi';
import { ApiError, listRows, runSql, sqlPage, viewPage } from './query';
import { rowJson } from './fields';
import type { Writer } from './write';

export interface ApiDeps {
  model: GateModel;
  replicator: Replicator;
  keys: KeyRegistry;
  journal: Journal;
  metrics: Metrics;
  state: StateStore;
  mcp: McpServer;
  writer: Writer;
  version: string;
  settings: () => Settings;
  /** L'adresse publique de l'API, pour la description OpenAPI. */
  publicUrl: () => string;
}

const MAX_BODY = 4 * 1024 * 1024;

export function clientIp(req: IncomingMessage, trusted: readonly string[]): string {
  const remote = req.socket.remoteAddress ?? '';
  if (trusted.some((t) => ipInRange(remote, t))) {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    if (fwd) return fwd;
  }
  return remote.replace(/^::ffff:/, '');
}

export function readJson(req: IncomingMessage, limit = MAX_BODY): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ApiError(413, 'body_too_large', 'Corps trop lourd'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new ApiError(400, 'bad_json', 'JSON illisible'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' && !headers['Content-Type'] ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

interface Idem {
  at: number;
  status: number;
  body: unknown;
}

export class ApiServer {
  private idempotency = new Map<string, Idem>();

  constructor(private readonly d: ApiDeps) {}

  /** Le point d'entrée HTTP. */
  handle = (req: IncomingMessage, res: ServerResponse): void => {
    const started = performance.now();
    const url = new URL(req.url ?? '/', 'http://gate.local');
    const method = (req.method ?? 'GET').toUpperCase();
    const ctx = {
      route: 'other',
      key: null as AppKeyRecord | null,
      kind: 'read' as JournalKind,
      note: '' as string,
      ip: clientIp(req, this.d.settings().trustProxy),
    };
    const finish = (status: number) => {
      const ms = performance.now() - started;
      this.d.metrics.inc('filarr_gate_requests_total', { route: ctx.route, code: String(status) });
      this.d.metrics.observe('filarr_gate_request_duration_seconds', ms / 1000, { route: ctx.route });
      if (ctx.route === 'health' || ctx.route === 'metrics') return;
      this.d.metrics.served(ms);
      this.d.journal.add({
        kind: status >= 400 ? 'error' : ctx.kind,
        who: ctx.key ? ctx.key.name : `inconnu · ${ctx.ip}`,
        what: `${method} ${url.pathname}${url.search}`,
        code: String(status),
        ms: Math.round(ms * 100) / 100,
        ...(ctx.note ? { note: ctx.note } : {}),
      });
    };
    void this.route(req, res, url, method, ctx)
      .then((status) => finish(status))
      .catch((err) => {
        const e = err instanceof ApiError ? err : new ApiError(500, 'internal', (err as Error).message);
        if (e.status >= 500) ctx.note = e.message;
        else ctx.note = e.code;
        const headers: Record<string, string> = {};
        if (e.status === 429 && typeof e.extra.retryAfter === 'number') headers['Retry-After'] = String(e.extra.retryAfter);
        if (!res.headersSent) send(res, e.status, { error: e.message, code: e.code, ...e.extra }, headers);
        finish(e.status);
      });
  };

  private cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (!origin) return;
    const allowed = this.d.settings().corsOrigins;
    if (!allowed.includes(origin) && !allowed.includes('*')) {
      throw new ApiError(403, 'origin_forbidden', `Les requêtes de la page ${origin} sont refusées (CORS fermé)`);
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Gate-Key, Mcp-Session-Id, Mcp-Protocol-Version');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  private auth(req: IncomingMessage, ip: string): AppKeyRecord {
    const check = this.d.keys.check(req.headers.authorization, req.headers['x-gate-key'] as string | undefined, ip);
    if (check.refusal) {
      throw new ApiError(check.refusal.status, check.refusal.code, check.refusal.message, check.refusal.retryAfter ? { retryAfter: check.refusal.retryAfter } : {});
    }
    return check.key!;
  }

  private base(slug: string): BaseInfo {
    const info = this.d.model.base(slug);
    if (!info) throw new ApiError(404, 'base_not_found', `Base inconnue : ${slug}`);
    if (!info.base.mirror.loaded) {
      const p = info.base.mirror.problem;
      throw new ApiError(503, p?.code ?? 'base_loading', p ? `Base indisponible : ${p.message}` : 'Base en cours de chargement', p?.keys ? { keys: p.keys } : {});
    }
    return info;
  }

  private headersFor(info: BaseInfo): Record<string, string> {
    const h: Record<string, string> = { 'X-Filarr-Version': String(info.version) };
    if (info.status !== 'ready') h['X-Gate-Base-Status'] = info.status;
    return h;
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    ctx: { route: string; key: AppKeyRecord | null; kind: JournalKind; note: string; ip: string }
  ): Promise<number> {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const settings = this.d.settings();
    this.cors(req, res);
    if (method === 'OPTIONS') {
      ctx.route = 'preflight';
      res.writeHead(204);
      res.end();
      return 204;
    }

    if (path === '/health' && method === 'GET') {
      ctx.route = 'health';
      const r = this.d.replicator;
      const bases = [...r.bases.values()];
      send(res, 200, {
        status: ['live', 'polling', 'connecting'].includes(r.link) && bases.every((b) => b.mirror.status === 'ready') ? 'ok' : 'degraded',
        link: r.link,
        version: this.d.version,
        bases: bases.map((b) => ({ slug: b.manifest?.slug ?? null, status: b.mirror.status, version: b.mirror.seq })),
      });
      return 200;
    }
    if (path === '/metrics' && method === 'GET') {
      ctx.route = 'metrics';
      if (!settings.metrics) throw new ApiError(404, 'not_found', 'Métriques éteintes');
      send(res, 200, this.d.metrics.render(), { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      return 200;
    }
    if ((path === '/openapi.json' || path === '/docs') && method === 'GET') {
      ctx.route = path.slice(1);
      if (!settings.docs) ctx.key = this.auth(req, ctx.ip);
      const spec = buildOpenApi({
        bases: this.d.model.bases(),
        queries: this.d.state.data.queries,
        serverUrl: this.d.publicUrl(),
        version: this.d.version,
        write: settings.write,
      });
      if (path === '/docs') send(res, 200, docsHtml(spec), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      else send(res, 200, spec);
      return 200;
    }
    if (path === '/mcp') {
      ctx.route = 'mcp';
      if (!settings.mcp) throw new ApiError(404, 'not_found', 'Serveur MCP éteint (réglage « mcp »)');
      if (method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' });
        res.end();
        return 405;
      }
      const key = (ctx.key = this.auth(req, ctx.ip));
      if (!key.mcp) throw new ApiError(403, 'forbidden', 'Cette clé n’a pas le droit MCP');
      const out = await this.d.mcp.handle(await readJson(req), key);
      if (!out) {
        res.writeHead(202);
        res.end();
        return 202;
      }
      send(res, 200, out.body, out.sessionId ? { 'Mcp-Session-Id': out.sessionId } : {});
      return 200;
    }

    if (!path.startsWith('/v1/')) throw new ApiError(404, 'not_found', `Chemin inconnu : ${path}`);
    const key = (ctx.key = this.auth(req, ctx.ip));
    let parts: string[];
    try {
      parts = path.slice(4).split('/').map(decodeURIComponent);
    } catch {
      throw new ApiError(400, 'bad_path', 'Chemin illisible');
    }

    if (parts[0] === 'sql' && parts.length === 1) {
      ctx.route = '/v1/sql';
      if (method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'POST attendu');
      if (!key.sql) throw new ApiError(403, 'forbidden', 'Cette clé n’a pas le droit SQL');
      const body = (await readJson(req)) as { sql?: unknown } | undefined;
      const readable = new Set(this.d.model.bases().filter((b) => canReadBase(key, b.storeId)).map((b) => b.storeId));
      const out = runSql(this.d.model.sql(readable).catalog, String(body?.sql ?? ''));
      ctx.note = `${out.rows.length} ligne(s) · ${out.scanned} parcourue(s)`;
      send(res, 200, out);
      return 200;
    }
    if (parts[0] === 'q' && parts.length === 2) {
      ctx.route = '/v1/q/:query';
      if (method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'GET attendu');
      const q = this.d.state.data.queries.find((x) => x.slug === parts[1]);
      if (!q) throw new ApiError(404, 'query_not_found', `Requête inconnue : ${parts[1]}`);
      if (!canReadQuery(key, q.id)) throw new ApiError(403, 'forbidden', 'Cette clé ne lit pas cette requête');
      const out = runSql(this.d.model.sql().catalog, q.sql);
      const page = sqlPage(out, url.searchParams);
      ctx.note = `${page.rows.length} ligne(s)`;
      send(res, 200, { ...page, query: { slug: q.slug, name: q.name }, ms: out.ms });
      return 200;
    }

    const info = this.base(parts[0] ?? '');
    const headers = this.headersFor(info);
    const second = parts[1];
    const third = parts[2];

    // Écritures
    if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
      ctx.kind = 'write';
      let op: WriteOp;
      let rowId: string | null = null;
      if (method === 'POST' && (parts.length === 1 || (parts.length === 2 && second === 'rows'))) op = 'create';
      else if (parts.length === 3 && second === 'rows') rowId = third!;
      else if (parts.length === 2 && method !== 'POST') rowId = second!;
      else throw new ApiError(405, 'method_not_allowed', 'Les vues se lisent seulement');
      if (rowId !== null) op = method === 'PATCH' ? 'update' : 'delete';
      ctx.route = rowId === null ? '/v1/:base' : '/v1/:base/rows/:id';
      if (!canWrite(key, info.storeId, op!)) throw new ApiError(403, 'forbidden', `Cette clé ne peut pas ${op! === 'create' ? 'ajouter' : op! === 'update' ? 'modifier' : 'supprimer'} dans ${info.slug}`);
      const idemKey = req.headers['idempotency-key'];
      const idemId = typeof idemKey === 'string' && idemKey !== '' ? `${key.id}|${method}|${path}|${idemKey}` : null;
      this.pruneIdempotency();
      if (idemId) {
        const seen = this.idempotency.get(idemId);
        if (seen) {
          ctx.note = 'rejouée (Idempotency-Key)';
          send(res, seen.status, seen.body, { ...headers, 'Idempotency-Replayed': 'true' });
          return seen.status;
        }
      }
      const body = method === 'DELETE' ? undefined : await readJson(req);
      let status = 200;
      let out: unknown;
      if (op! === 'create') {
        const r = await this.d.writer.create(info, body);
        status = 201;
        out = Array.isArray(body) ? { rows: r.rows, version: r.version, validated: true } : { id: r.rows[0]?.id, row: r.rows[0], version: r.version, validated: true };
        ctx.note = `acceptée par Filarr · v${r.version}`;
      } else if (op! === 'update') {
        const r = await this.d.writer.update(info, rowId!, body);
        out = { id: rowId, row: r.rows[0], version: r.version, validated: true };
        ctx.note = `acceptée par Filarr · v${r.version}`;
      } else {
        const r = await this.d.writer.remove(info, rowId!);
        out = { id: rowId, deleted: true, version: r.version, validated: true };
        ctx.note = `acceptée par Filarr · v${r.version}`;
      }
      if (idemId) this.idempotency.set(idemId, { at: Date.now(), status, body: out });
      send(res, status, out, { ...headers, 'X-Filarr-Version': String((out as { version: number }).version) });
      return status;
    }
    if (method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'Méthode non prise en charge');

    // Lectures
    if (parts.length === 1) {
      ctx.route = '/v1/:base';
      if (!canReadBase(key, info.storeId)) throw new ApiError(403, 'forbidden', `Cette clé ne lit pas ${info.slug}`);
      const page = listRows(this.d.model, info, url.searchParams);
      ctx.note = `${page.rows.length} ligne(s)`;
      send(res, 200, page, headers);
      return 200;
    }
    const view = parts.length === 2 ? info.views.find((v) => v.slug === second) : undefined;
    if (view) {
      ctx.route = '/v1/:base/:view';
      if (!canReadView(key, info.storeId, view.view.id)) throw new ApiError(403, 'forbidden', `Cette clé ne lit pas ${info.slug}/${view.slug}`);
      const page = viewPage(this.d.model, info, view, url.searchParams);
      ctx.note = `${page.rows.length} ligne(s)`;
      send(res, 200, page, headers);
      return 200;
    }
    if (parts.length === 2 && second === 'rows') {
      ctx.route = '/v1/:base';
      if (!canReadBase(key, info.storeId)) throw new ApiError(403, 'forbidden', `Cette clé ne lit pas ${info.slug}`);
      send(res, 200, listRows(this.d.model, info, url.searchParams), headers);
      return 200;
    }
    if (parts.length === 3 && second === 'rows') {
      ctx.route = '/v1/:base/rows/:id';
      if (!canReadBase(key, info.storeId)) throw new ApiError(403, 'forbidden', `Cette clé ne lit pas ${info.slug}`);
      const row = info.base.mirror.rowById(third!);
      if (!row) throw new ApiError(404, 'row_not_found', `Ligne introuvable : ${third}`);
      const unresolved = new Set<string>();
      const obj = rowJson(info.fields, row, this.d.model.env(info), unresolved);
      send(res, 200, { row: obj, version: info.version, ...(unresolved.size ? { unresolved: [...unresolved] } : {}) }, headers);
      return 200;
    }
    throw new ApiError(404, 'view_not_found', `Vue inconnue : ${parts.slice(1).join('/')}`);
  }

  private pruneIdempotency(): void {
    const limit = Date.now() - 86_400_000;
    for (const [k, v] of this.idempotency) if (v.at < limit) this.idempotency.delete(k);
  }
}
