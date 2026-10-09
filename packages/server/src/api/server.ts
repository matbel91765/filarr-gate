/**
 * L'API LOCALE de la boîte noire : HTTP(S), servie depuis la copie en mémoire.
 *
 *   GET    /health                  santé (sans clé)
 *   GET    /metrics                 Prometheus (si activé)
 *   GET    /openapi.json, /docs     description (publique si « docs » est activé, sinon avec une clé)
 *   POST   /mcp                     serveur MCP (si activé ; clé avec le droit MCP)
 *   POST   /_filarr/notify          réveil poussé de Filarr (signé sous A_notify, api-base-1 rév. 3 § 5 bis)
 *   POST   /v1/sql                  SELECT en lecture seule
 *   GET    /v1/q/<requête>          une requête enregistrée
 *   POST   /v1/files                déposer un fichier (portée « files », gate-fichiers-1 § 12)
 *   GET    /v1/files/<id>           le statut d'un dépôt (jamais où ni sous quel nom)
 *   GET    /v1/<base>               les lignes (filtres, tri, champs, pages)
 *   GET    /v1/<base>/<vue>         la vue rejouée par le moteur de Filarr
 *   GET    /v1/<base>/rows/<id>     une ligne
 *   POST   /v1/<base>[/rows]        ajouter (écriture allumée, droit rw, clé autorisée)
 *   PATCH  /v1/<base>[/rows]/<id>   modifier
 *   DELETE /v1/<base>[/rows]/<id>   supprimer
 *
 * Sans moteur : une `Request` entre, une `Response` sort (Node et Workers).
 */

import { rowJson } from '../../../gate/src/data/fields';
import type { BaseInfo } from '../../../gate/src/data/model';
import { ApiError, listRows, runSql, sqlPage, viewPage } from '../../../gate/src/data/query';
import { MAX_FILE_BYTES } from '../../../core/src/engine/gate/files';
import type { GateCore } from '../core';
import { readFileUpload } from '../files';
import { clientIp, empty, errorResponse, json, readJson, text, type ConnInfo } from '../http';
import type { JournalKind } from '../journal';
import type { AppKeyRecord } from '../state';
import { canDeposit, canReadBase, canReadQuery, canReadView, canWrite, ipInRange, type WriteOp } from './keys';
import { buildOpenApi, docsHtml } from './openapi';

interface Idem {
  at: number;
  status: number;
  body: unknown;
}

interface Ctx {
  route: string;
  key: AppKeyRecord | null;
  kind: JournalKind;
  note: string;
  ip: string;
  cors: Record<string, string>;
}

export class ApiServer {
  private idempotency = new Map<string, Idem>();

  constructor(private readonly g: GateCore) {}

  /** Le point d'entrée HTTP. */
  async handle(request: Request, conn: ConnInfo): Promise<Response> {
    const started = performance.now();
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const ctx: Ctx = {
      route: 'other',
      key: null,
      kind: 'read',
      note: '',
      ip: clientIp(request, conn, this.g.settings.trustProxy, ipInRange),
      cors: {},
    };
    let response: Response;
    try {
      response = await this.route(request, url, method, ctx);
    } catch (err) {
      const { response: r, error } = errorResponse(err, ctx.cors);
      ctx.note = error.status >= 500 ? error.message : error.code;
      response = r;
    }
    const ms = performance.now() - started;
    const status = response.status;
    this.g.metrics.inc('filarr_gate_requests_total', { route: ctx.route, code: String(status) });
    this.g.metrics.observe('filarr_gate_request_duration_seconds', ms / 1000, { route: ctx.route });
    if (ctx.route !== 'health' && ctx.route !== 'metrics' && ctx.route !== 'notify') {
      this.g.metrics.served(ms);
      this.g.journal.add({
        kind: status >= 400 ? 'error' : ctx.kind,
        who: ctx.key ? ctx.key.name : `inconnu · ${ctx.ip}`,
        what: `${method} ${url.pathname}${url.search}`,
        code: String(status),
        ms: Math.round(ms * 100) / 100,
        ...(ctx.note ? { note: ctx.note } : {}),
      });
    }
    return response;
  }

  private cors(request: Request, ctx: Ctx): void {
    const origin = request.headers.get('origin');
    if (!origin) return;
    const allowed = this.g.settings.corsOrigins;
    if (!allowed.includes(origin) && !allowed.includes('*')) {
      throw new ApiError(403, 'origin_forbidden', `Les requêtes de la page ${origin} sont refusées (CORS fermé)`);
    }
    ctx.cors = {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, X-Gate-Key, X-File-Name, Mcp-Session-Id, Mcp-Protocol-Version',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Max-Age': '600',
    };
  }

  private auth(request: Request, ip: string): AppKeyRecord {
    const check = this.g.keys.check(request.headers.get('authorization') ?? undefined, request.headers.get('x-gate-key') ?? undefined, ip);
    if (check.refusal) {
      throw new ApiError(check.refusal.status, check.refusal.code, check.refusal.message, check.refusal.retryAfter ? { retryAfter: check.refusal.retryAfter } : {});
    }
    return check.key!;
  }

  private base(slug: string): BaseInfo {
    const info = this.g.model.base(slug);
    if (!info) throw new ApiError(404, 'base_not_found', `Base inconnue : ${slug}`);
    if (!info.base.mirror.loaded) {
      const p = info.base.mirror.problem;
      throw new ApiError(503, p?.code ?? 'base_loading', p ? `Base indisponible : ${p.message}` : 'Base en cours de chargement', p?.keys ? { keys: p.keys } : {});
    }
    return info;
  }

  private headersFor(info: BaseInfo, ctx: Ctx): Record<string, string> {
    const h: Record<string, string> = { ...ctx.cors, 'X-Filarr-Version': String(info.version) };
    if (info.status !== 'ready') h['X-Gate-Base-Status'] = info.status;
    return h;
  }

  private async route(request: Request, url: URL, method: string, ctx: Ctx): Promise<Response> {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const settings = this.g.settings;

    // Le réveil de Filarr : authentifié par sa signature, jamais par une clé d'application ni par CORS
    if (path === '/_filarr/notify' || path.startsWith('/_filarr/notify/')) {
      ctx.route = 'notify';
      if (method !== 'POST') return empty(405, { Allow: 'POST' });
      return this.g.handleNotify(request);
    }

    this.cors(request, ctx);
    if (method === 'OPTIONS') {
      ctx.route = 'preflight';
      return empty(204, ctx.cors);
    }

    if (path === '/health' && method === 'GET') {
      ctx.route = 'health';
      const r = this.g.replicator;
      const bases = [...r.bases.values()];
      return json(
        200,
        {
          status: ['live', 'polling', 'connecting'].includes(r.link) && bases.every((b) => b.mirror.status === 'ready') ? 'ok' : 'degraded',
          link: r.link,
          version: this.g.version,
          bases: bases.map((b) => ({ slug: b.manifest?.slug ?? null, status: b.mirror.status, version: b.mirror.seq })),
        },
        ctx.cors
      );
    }
    if (path === '/metrics' && method === 'GET') {
      ctx.route = 'metrics';
      if (!settings.metrics) throw new ApiError(404, 'not_found', 'Métriques éteintes');
      return text(200, this.g.metrics.render(), { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    }
    if ((path === '/openapi.json' || path === '/docs') && method === 'GET') {
      ctx.route = path.slice(1);
      if (!settings.docs) ctx.key = this.auth(request, ctx.ip);
      const spec = buildOpenApi({
        bases: this.g.model.bases(),
        queries: this.g.state.data.queries,
        serverUrl: this.g.publicUrl(),
        version: this.g.version,
        write: settings.write,
        files: this.g.replicator.files !== null,
      });
      if (path === '/docs') {
        return text(200, docsHtml(spec), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", ...ctx.cors });
      }
      return json(200, spec, ctx.cors);
    }
    if (path === '/mcp') {
      ctx.route = 'mcp';
      if (!settings.mcp) throw new ApiError(404, 'not_found', 'Serveur MCP éteint (réglage « mcp »)');
      if (method !== 'POST') return empty(405, { Allow: 'POST', ...ctx.cors });
      const key = (ctx.key = this.auth(request, ctx.ip));
      if (!key.mcp) throw new ApiError(403, 'forbidden', 'Cette clé n’a pas le droit MCP');
      const out = await this.g.mcp.handle(await readJson(request), key);
      if (!out) return empty(202, ctx.cors);
      return json(200, out.body, { ...ctx.cors, ...(out.sessionId ? { 'Mcp-Session-Id': out.sessionId } : {}) });
    }

    if (!path.startsWith('/v1/')) throw new ApiError(404, 'not_found', `Chemin inconnu : ${path}`);
    const key = (ctx.key = this.auth(request, ctx.ip));
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
      const body = (await readJson(request)) as { sql?: unknown } | undefined;
      const readable = new Set(this.g.model.bases().filter((b) => canReadBase(key, b.storeId)).map((b) => b.storeId));
      const out = runSql(this.g.model.sql(readable).catalog, String(body?.sql ?? ''));
      ctx.note = `${out.rows.length} ligne(s) · ${out.scanned} parcourue(s)`;
      return json(200, out, ctx.cors);
    }
    if (parts[0] === 'q' && parts.length === 2) {
      ctx.route = '/v1/q/:query';
      if (method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'GET attendu');
      const q = this.g.state.data.queries.find((x) => x.slug === parts[1]);
      if (!q) throw new ApiError(404, 'query_not_found', `Requête inconnue : ${parts[1]}`);
      if (!canReadQuery(key, q.id)) throw new ApiError(403, 'forbidden', 'Cette clé ne lit pas cette requête');
      const out = runSql(this.g.model.sql().catalog, q.sql);
      const page = sqlPage(out, url.searchParams);
      ctx.note = `${page.rows.length} ligne(s)`;
      return json(200, { ...page, query: { slug: q.slug, name: q.name }, ms: out.ms }, ctx.cors);
    }

    // La fente à fichiers (révision 3)
    if (parts[0] === 'files') {
      if (!canDeposit(key)) throw new ApiError(403, 'scope_files', 'Cette clé ne peut pas déposer de fichiers (portée « files »).');
      if (parts.length === 1 && method === 'POST') {
        ctx.route = '/v1/files';
        ctx.kind = 'write';
        const limit = Math.min(MAX_FILE_BYTES, this.g.settings.filesMaxBytes);
        const { content, input } = await readFileUpload(request, limit);
        const record = await this.g.files.deposit(content, input, key);
        ctx.note = `déposé · ${record.sizeBytes} octets`;
        return json(202, { id: record.id, status: record.status, depositedAt: record.depositedAt, ...(record.seq !== null ? { seq: record.seq } : {}) }, ctx.cors);
      }
      if (parts.length === 2 && method === 'GET') {
        ctx.route = '/v1/files/:id';
        const record = await this.g.files.status(parts[1]!);
        // Jamais où ni sous quel nom (gate-fichiers-1 § 5)
        return json(200, { id: record.id, status: record.status, depositedAt: record.depositedAt, filedAt: record.filedAt }, ctx.cors);
      }
      throw new ApiError(405, 'method_not_allowed', 'POST /v1/files ou GET /v1/files/<id>');
    }

    const info = this.base(parts[0] ?? '');
    const headers = this.headersFor(info, ctx);
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
      const idemKey = request.headers.get('idempotency-key');
      const idemId = idemKey ? `${key.id}|${method}|${path}|${idemKey}` : null;
      this.pruneIdempotency();
      if (idemId) {
        const seen = this.idempotency.get(idemId);
        if (seen) {
          ctx.note = 'rejouée (Idempotency-Key)';
          return json(seen.status, seen.body, { ...headers, 'Idempotency-Replayed': 'true' });
        }
      }
      const body = method === 'DELETE' ? undefined : await readJson(request);
      let status = 200;
      let out: unknown;
      if (op! === 'create') {
        const r = await this.g.writer.create(info, body);
        status = 201;
        out = Array.isArray(body) ? { rows: r.rows, version: r.version, validated: true } : { id: r.rows[0]?.id, row: r.rows[0], version: r.version, validated: true };
      } else if (op! === 'update') {
        const r = await this.g.writer.update(info, rowId!, body);
        out = { id: rowId, row: r.rows[0], version: r.version, validated: true };
      } else {
        const r = await this.g.writer.remove(info, rowId!);
        out = { id: rowId, deleted: true, version: r.version, validated: true };
      }
      ctx.note = `acceptée par Filarr · v${(out as { version: number }).version}`;
      if (idemId) this.idempotency.set(idemId, { at: Date.now(), status, body: out });
      return json(status, out, { ...headers, 'X-Filarr-Version': String((out as { version: number }).version) });
    }
    if (method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'Méthode non prise en charge');

    // Lectures
    if (parts.length === 1) {
      ctx.route = '/v1/:base';
      if (!canReadBase(key, info.storeId)) throw new ApiError(403, 'forbidden', `Cette clé ne lit pas ${info.slug}`);
      const page = listRows(this.g.model, info, url.searchParams);
      ctx.note = `${page.rows.length} ligne(s)`;
      return json(200, page, headers);
    }
    const view = parts.length === 2 ? info.views.find((v) => v.slug === second) : undefined;
    if (view) {
      ctx.route = '/v1/:base/:view';
      if (!canReadView(key, info.storeId, view.view.id)) throw new ApiError(403, 'forbidden', `Cette clé ne lit pas ${info.slug}/${view.slug}`);
      const page = viewPage(this.g.model, info, view, url.searchParams);
      ctx.note = `${page.rows.length} ligne(s)`;
      return json(200, page, headers);
    }
    if (parts.length === 2 && second === 'rows') {
      ctx.route = '/v1/:base';
      if (!canReadBase(key, info.storeId)) throw new ApiError(403, 'forbidden', `Cette clé ne lit pas ${info.slug}`);
      return json(200, listRows(this.g.model, info, url.searchParams), headers);
    }
    if (parts.length === 3 && second === 'rows') {
      ctx.route = '/v1/:base/rows/:id';
      if (!canReadBase(key, info.storeId)) throw new ApiError(403, 'forbidden', `Cette clé ne lit pas ${info.slug}`);
      const row = info.base.mirror.rowById(third!);
      if (!row) throw new ApiError(404, 'row_not_found', `Ligne introuvable : ${third}`);
      const unresolved = new Set<string>();
      const obj = rowJson(info.fields, row, this.g.model.env(info), unresolved);
      return json(200, { row: obj, version: info.version, ...(unresolved.size ? { unresolved: [...unresolved] } : {}) }, headers);
    }
    throw new ApiError(404, 'view_not_found', `Vue inconnue : ${parts.slice(1).join('/')}`);
  }

  private pruneIdempotency(): void {
    const limit = Date.now() - 86_400_000;
    for (const [k, v] of this.idempotency) if (v.at < limit) this.idempotency.delete(k);
  }
}
