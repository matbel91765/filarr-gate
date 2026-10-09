/**
 * L'interface de gestion : les fichiers de l'application (`/admin/`) et son API
 * (`/admin/api/*`), sur un port à part, local d'office.
 *
 * - Mise en route : tant que le mot de passe d'administration n'est pas posé,
 *   les routes `setup/*` sont ouvertes à CETTE machine ; depuis une autre, elles
 *   demandent le code de mise en route affiché dans la console.
 * - Ensuite : une session (cookie `HttpOnly`, `SameSite=Strict`) ouverte par le
 *   mot de passe, et l'en-tête `X-Gate-Admin: 1` sur toute écriture (une page
 *   d'un autre site ne peut pas le poser sans une pré-vérification CORS, refusée).
 * Qui entre ici lit les données en clair : la machine se protège comme toute
 * machine qui détient les données.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignSlugs } from '../../../core/src/engine/store/apiAccess';
import { orderedVisibleProperties } from '../../../core/src/viewEngine';
import { canReadBase, canReadQuery, canReadView, canWrite, validRange } from '../api/keys';
import { buildOpenApi } from '../api/openapi';
import { ApiError, runSql, viewPage, listRows } from '../../../gate/src/data/query';
import { readJson } from '../api/server';
import { compileFilter } from '../api/webhooks';
import type { BaseInfo } from '../../../gate/src/data/model';
import { ENV_NAMES, type SettingKey } from '../../../cli/src/config';
import type { Gate } from '../../../cli/src/gate';
import type { JournalKind } from '../journal';
import { StateStore, type KeyScope, type SavedQuery, type WebhookEvent } from '../state';
import { log } from '../../../cli/src/log';

const SESSION_COOKIE = 'gate_admin';
const SESSION_MS = 12 * 3_600_000;

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
function uiRoot(): string | null {
  const here = fileURLToPath(new URL('.', import.meta.url));
  for (const candidate of [join(here, 'ui'), join(here, '..', '..', 'dist', 'ui'), join(here, '..', 'dist', 'ui')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

const isLoopback = (ip: string): boolean => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.');

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

export class AdminApi {
  private sessions = new Map<string, number>();
  private loginFailures: number[] = [];
  private publicLimits: { at: number; data: unknown } | null = null;
  private readonly root = uiRoot();

  constructor(private readonly gate: Gate) {}

  /** La mise en route est faite quand un mot de passe d'administration existe. */
  get setupDone(): boolean {
    return this.gate.state.data.admin.passwordHash !== null || this.gate.config.adminPasswordFromEnv !== null;
  }

  private async passwordOk(password: string): Promise<boolean> {
    const fromEnv = this.gate.config.adminPasswordFromEnv;
    if (fromEnv !== null) {
      const a = Buffer.from(password);
      const b = Buffer.from(fromEnv);
      return a.length === b.length && timingSafeEqual(a, b);
    }
    return StateStore.verifyPassword(password, this.gate.state.data.admin.passwordHash);
  }

  private session(req: IncomingMessage): string | null {
    const cookie = String(req.headers.cookie ?? '');
    const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([A-Za-z0-9_-]+)`).exec(cookie);
    if (!m) return null;
    const exp = this.sessions.get(m[1]!);
    if (!exp || exp < Date.now()) {
      if (exp) this.sessions.delete(m[1]!);
      return null;
    }
    this.sessions.set(m[1]!, Date.now() + SESSION_MS);
    return m[1]!;
  }

  private openSession(res: ServerResponse): void {
    const id = randomBytes(24).toString('base64url');
    this.sessions.set(id, Date.now() + SESSION_MS);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${SESSION_MS / 1000}`);
  }

  handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://admin.local');
    const method = (req.method ?? 'GET').toUpperCase();
    if (!url.pathname.startsWith('/admin/api/')) {
      this.serveStatic(url.pathname, res);
      return;
    }
    void this.api(req, res, url, method).catch((err) => {
      const status = err instanceof ApiError ? err.status : 400;
      const code = err instanceof ApiError ? err.code : 'bad_request';
      if (!(err instanceof ApiError)) log.debug(`administration : ${(err as Error).message}`);
      if (!res.headersSent) send(res, status, { error: (err as Error).message, code, ...(err instanceof ApiError ? err.extra : {}) });
    });
  };

  private serveStatic(pathname: string, res: ServerResponse): void {
    if (pathname === '/' || pathname === '/admin') {
      res.writeHead(302, { Location: '/admin/' });
      res.end();
      return;
    }
    if (!pathname.startsWith('/admin/')) {
      res.writeHead(404, SECURITY_HEADERS);
      res.end('Not found');
      return;
    }
    if (!this.root) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end("L'interface n'est pas construite : npm run build:ui");
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname.slice('/admin/'.length));
    } catch {
      res.writeHead(400, SECURITY_HEADERS);
      res.end();
      return;
    }
    const rel = normalize(decoded || 'index.html');
    let file = resolve(this.root, rel);
    if (!file.startsWith(resolve(this.root) + sep) && file !== resolve(this.root)) {
      res.writeHead(403, SECURITY_HEADERS);
      res.end();
      return;
    }
    // Application d'une page : tout chemin inconnu rend index.html
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(this.root, 'index.html');
    const ext = extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      ...SECURITY_HEADERS,
    });
    res.end(readFileSync(file));
  }

  private requireSetupAllowed(req: IncomingMessage, code: unknown): void {
    if (this.setupDone) throw new ApiError(409, 'setup_done', 'La mise en route est déjà faite : connectez-vous.');
    const ip = req.socket.remoteAddress ?? '';
    if (!isLoopback(ip) && String(code ?? '') !== this.gate.setupCode) {
      throw new ApiError(403, 'setup_code_required', 'Depuis une autre machine, saisissez le code de mise en route affiché dans la console de la boîte noire.');
    }
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const path = url.pathname.slice('/admin/api'.length).replace(/\/+$/, '') || '/';
    const g = this.gate;
    const authed = this.session(req) !== null;
    // Écriture : en-tête maison (contre une page d'un autre site)
    if (method !== 'GET' && req.headers['x-gate-admin'] !== '1') throw new ApiError(403, 'csrf', 'En-tête X-Gate-Admin manquant');

    if (path === '/state' && method === 'GET') {
      const ip = req.socket.remoteAddress ?? '';
      return send(res, 200, {
        version: g.version,
        authenticated: authed,
        setup: { done: this.setupDone, hasToken: g.hasToken, needsCode: !this.setupDone && !isLoopback(ip) },
        // Le résumé (liaison, accès, compteurs) : à une session, ou à CETTE machine pendant la mise en route
        ...(authed || (!this.setupDone && isLoopback(ip)) ? this.summary() : {}),
      });
    }
    if (path === '/login' && method === 'POST') {
      const body = (await readJson(req)) as { password?: string } | undefined;
      const now = Date.now();
      this.loginFailures = this.loginFailures.filter((t) => now - t < 60_000);
      if (this.loginFailures.length >= 5) throw new ApiError(429, 'too_many_attempts', 'Trop d’essais : attendez une minute.');
      if (!this.setupDone || !(await this.passwordOk(String(body?.password ?? '')))) {
        this.loginFailures.push(now);
        g.journal.add({ kind: 'error', who: `administration · ${req.socket.remoteAddress ?? ''}`, what: 'connexion', code: '401', note: 'mot de passe refusé' });
        throw new ApiError(401, 'bad_password', 'Mot de passe refusé');
      }
      this.openSession(res);
      return send(res, 200, { ok: true });
    }
    if (path === '/logout' && method === 'POST') {
      const id = this.session(req);
      if (id) this.sessions.delete(id);
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
      return send(res, 200, { ok: true });
    }

    // ---------- Mise en route ----------
    if (path === '/setup/token' && method === 'POST') {
      const body = (await readJson(req)) as { token?: string; code?: string } | undefined;
      this.requireSetupAllowed(req, body?.code);
      return send(res, 200, await this.applyToken(String(body?.token ?? '')));
    }
    if (path === '/setup/network' && method === 'POST') {
      const body = (await readJson(req)) as Record<string, unknown> | undefined;
      this.requireSetupAllowed(req, body?.code);
      return send(res, 200, await this.applyNetwork(body ?? {}));
    }
    if (path === '/setup/finish' && method === 'POST') {
      const body = (await readJson(req)) as { password?: string; metrics?: boolean; mcp?: boolean; code?: string } | undefined;
      this.requireSetupAllowed(req, body?.code);
      const password = String(body?.password ?? '');
      if (password.length < 10) throw new ApiError(400, 'weak_password', 'Dix caractères au moins.');
      g.state.data.admin.passwordHash = await StateStore.hashPassword(password);
      g.state.saveNow();
      const patch: Record<string, unknown> = {};
      if (typeof body?.metrics === 'boolean' && g.config.sources.metrics !== 'env' && g.config.sources.metrics !== 'file') patch.metrics = body.metrics;
      if (typeof body?.mcp === 'boolean' && g.config.sources.mcp !== 'env' && g.config.sources.mcp !== 'file') patch.mcp = body.mcp;
      if (Object.keys(patch).length) await g.updateSettings(patch);
      g.journal.add({ kind: 'admin', who: 'administration', what: 'mise en route terminée', code: 'ok' });
      this.openSession(res);
      return send(res, 200, { ok: true });
    }

    if (!authed) throw new ApiError(401, 'login_required', 'Connexion requise');

    // ---------- Écrans ----------
    if (path === '/dashboard' && method === 'GET') return send(res, 200, this.dashboard());
    if (path === '/bases' && method === 'GET') return send(res, 200, { bases: this.bases(), refused: g.replicator.refused, publicUrl: g.publicUrl(), write: g.settings.write });
    const preview = /^\/bases\/([A-Za-z0-9_-]{22})\/rows$/.exec(path);
    if (preview && method === 'GET') {
      const info = g.model.baseById(preview[1]!);
      if (!info) throw new ApiError(404, 'base_not_found', 'Base inconnue');
      const params = new URLSearchParams({ limit: url.searchParams.get('limit') ?? '50' });
      const viewSlug = url.searchParams.get('view');
      const view = viewSlug ? info.views.find((v) => v.slug === viewSlug) : undefined;
      const page = view ? viewPage(g.model, info, view, params) : listRows(g.model, info, params);
      return send(res, 200, page);
    }
    if (path === '/openapi.json' && method === 'GET') {
      return send(res, 200, buildOpenApi({ bases: g.model.bases(), queries: g.state.data.queries, serverUrl: g.publicUrl(), version: g.version, write: g.settings.write }), {
        'Content-Disposition': 'attachment; filename="openapi.json"',
      });
    }
    if (path === '/sql' && method === 'POST') {
      const body = (await readJson(req)) as { sql?: string } | undefined;
      const out = runSql(g.model.sql().catalog, String(body?.sql ?? ''));
      g.journal.add({ kind: 'read', who: 'administration', what: 'explorateur SQL', code: '200', ms: out.ms, note: `${out.rows.length} ligne(s)` });
      return send(res, 200, out);
    }
    if (path === '/sql/tables' && method === 'GET') return send(res, 200, this.tables());
    if (path === '/queries' && method === 'GET') {
      return send(res, 200, {
        queries: g.state.data.queries.map((q) => ({ ...q, endpoint: `/v1/q/${q.slug}`, keys: this.allowedKeys((k) => canReadQuery(k, q.id)) })),
      });
    }
    if (path === '/queries' && method === 'POST') {
      const body = (await readJson(req)) as { name?: string; sql?: string } | undefined;
      return send(res, 201, this.saveQuery(String(body?.name ?? ''), String(body?.sql ?? '')));
    }
    const q = /^\/queries\/([0-9a-f-]{36})$/.exec(path);
    if (q && method === 'DELETE') {
      g.state.data.queries = g.state.data.queries.filter((x) => x.id !== q[1]);
      g.state.saveNow();
      return send(res, 200, { ok: true });
    }

    if (path === '/keys' && method === 'GET') return send(res, 200, this.keyList());
    if (path === '/keys' && method === 'POST') {
      const body = (await readJson(req)) as Record<string, unknown> | undefined;
      const { record, key } = g.keys.create(this.keyInput(body ?? {}));
      g.journal.add({ kind: 'admin', who: 'administration', what: `clé créée · ${record.name}`, code: 'ok', note: record.prefix });
      return send(res, 201, { key, record: this.keyView(record) });
    }
    const k = /^\/keys\/([0-9a-f-]{36})$/.exec(path);
    if (k && method === 'PATCH') {
      const body = (await readJson(req)) as Record<string, unknown> | undefined;
      const patch: Record<string, unknown> = {};
      if (typeof body?.paused === 'boolean') patch.paused = body.paused;
      if (typeof body?.name === 'string' && body.name.trim()) patch.name = body.name.trim();
      const record = g.keys.update(k[1]!, patch);
      g.journal.add({ kind: 'admin', who: 'administration', what: `clé ${record.paused ? 'mise en pause' : 'reprise'} · ${record.name}`, code: 'ok' });
      return send(res, 200, { record: this.keyView(record) });
    }
    if (k && method === 'DELETE') {
      const record = g.keys.get(k[1]!);
      if (!g.keys.revoke(k[1]!)) throw new ApiError(404, 'key_not_found', 'Clé inconnue');
      g.journal.add({ kind: 'admin', who: 'administration', what: `clé révoquée · ${record?.name ?? k[1]}`, code: 'ok' });
      return send(res, 200, { ok: true });
    }

    if (path === '/webhooks' && method === 'GET') return send(res, 200, this.webhookList());
    if (path === '/webhooks' && method === 'POST') {
      const body = (await readJson(req)) as Record<string, unknown> | undefined;
      const hook = g.webhooks.create(this.webhookInput(body ?? {}));
      g.journal.add({ kind: 'admin', who: 'administration', what: `webhook créé · ${hook.name}`, code: 'ok' });
      // Le secret de signature n'est montré qu'ici, à la création
      return send(res, 201, { webhook: this.webhookView(hook.id), secret: hook.secret });
    }
    const w = /^\/webhooks\/([0-9a-f-]{36})(?:\/(test|rotate))?$/.exec(path);
    if (w && method === 'POST' && w[2] === 'test') {
      g.webhooks.test(w[1]!);
      return send(res, 200, { webhook: this.webhookView(w[1]!) });
    }
    if (w && method === 'POST' && w[2] === 'rotate') {
      const hook = g.webhooks.rotate(w[1]!);
      g.journal.add({ kind: 'admin', who: 'administration', what: `secret renouvelé · ${hook.name}`, code: 'ok' });
      return send(res, 200, { webhook: this.webhookView(w[1]!), secret: hook.secret });
    }
    if (w && !w[2] && method === 'PATCH') {
      const body = (await readJson(req)) as Record<string, unknown> | undefined;
      const patch = typeof body?.paused === 'boolean' && Object.keys(body).length === 1 ? { paused: body.paused } : this.webhookInput(body ?? {});
      g.webhooks.update(w[1]!, patch);
      return send(res, 200, { webhook: this.webhookView(w[1]!) });
    }
    if (w && !w[2] && method === 'DELETE') {
      if (!g.webhooks.remove(w[1]!)) throw new ApiError(404, 'webhook_not_found', 'Webhook inconnu');
      return send(res, 200, { ok: true });
    }

    if (path === '/journal' && method === 'GET') {
      const kind = (url.searchParams.get('kind') ?? 'all') as JournalKind | 'all';
      return send(res, 200, {
        entries: g.journal.list({ kind, q: url.searchParams.get('q') ?? '', limit: Math.min(1000, Number(url.searchParams.get('limit') ?? '200') || 200) }),
        counts: g.journal.counts(),
        retentionDays: g.journal.retentionDays,
      });
    }
    if (path === '/journal/export' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="filarr-gate-journal-${new Date().toISOString().slice(0, 10)}.jsonl"`,
        'Cache-Control': 'no-store',
      });
      res.end(await g.journal.export());
      return;
    }
    if (path === '/limits' && method === 'GET') return send(res, 200, await this.limits());

    if (path === '/settings' && method === 'GET') return send(res, 200, await this.settingsView());
    if (path === '/settings' && method === 'PUT') {
      const body = (await readJson(req)) as Record<string, unknown> | undefined;
      try {
        const out = await g.updateSettings(body ?? {});
        return send(res, 200, { ...(await this.settingsView()), restarted: out.restarted });
      } catch (err) {
        throw new ApiError(400, 'settings_refused', (err as Error).message);
      }
    }
    if (path === '/token' && method === 'POST') {
      const body = (await readJson(req)) as { token?: string } | undefined;
      if (g.tokenSource === 'env') throw new ApiError(409, 'token_from_env', 'Le jeton vient de FILARR_GATE_TOKEN : changez la variable.');
      return send(res, 200, await this.applyToken(String(body?.token ?? '')));
    }
    if (path === '/resync' && method === 'POST') {
      await g.replicator.resync();
      g.journal.add({ kind: 'admin', who: 'administration', what: 'resynchronisation complète', code: g.replicator.link });
      return send(res, 200, this.summary());
    }
    if (path === '/password' && method === 'POST') {
      const body = (await readJson(req)) as { current?: string; next?: string } | undefined;
      if (g.config.adminPasswordFromEnv !== null) throw new ApiError(409, 'password_from_env', 'Le mot de passe vient de FILARR_GATE_ADMIN_PASSWORD.');
      if (!(await this.passwordOk(String(body?.current ?? '')))) throw new ApiError(401, 'bad_password', 'Mot de passe actuel refusé');
      if (String(body?.next ?? '').length < 10) throw new ApiError(400, 'weak_password', 'Dix caractères au moins.');
      g.state.data.admin.passwordHash = await StateStore.hashPassword(String(body?.next));
      g.state.saveNow();
      this.sessions.clear();
      this.openSession(res);
      return send(res, 200, { ok: true });
    }
    if (path === '/forget' && method === 'POST') {
      const body = (await readJson(req)) as { confirm?: string } | undefined;
      if (body?.confirm !== 'oublier') throw new ApiError(400, 'confirm_required', 'Confirmation attendue : « oublier »');
      await g.forget();
      this.sessions.clear();
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
      return send(res, 200, { ok: true });
    }
    throw new ApiError(404, 'not_found', `Route inconnue : ${method} ${path}`);
  }

  // ==================== Vues des écrans ====================

  private summary() {
    const g = this.gate;
    const r = g.replicator;
    return {
      link: { state: r.link, detail: r.linkDetail, lastChangeAt: r.lastChangeAt, streamRefused: r.streamRefused },
      access: r.access ? { name: r.access.name ?? null, tier: (r.limits?.tier as string | undefined) ?? r.access.tier ?? null, expiresAt: r.access.expiresAt ?? null } : null,
      token: r.identity ? { hint: r.identity.hint, fingerprint: r.identity.fingerprint, source: g.tokenSource } : null,
      counts: { bases: r.bases.size, keys: g.keys.list().length, webhooks: g.webhooks.list().length },
      flags: { write: g.settings.write, mcp: g.settings.mcp, metrics: g.settings.metrics, docs: g.settings.docs },
      adminUrl: g.adminUrl(),
      publicUrl: g.publicUrl(),
    };
  }

  /** Mise en route, ou remplacement : le jeton est vérifié par Filarr avant d'être gardé. */
  private async applyToken(token: string) {
    const g = this.gate;
    const started = Date.now();
    try {
      await g.useToken(token, true, true);
    } catch (err) {
      throw new ApiError(400, 'token_refused', (err as Error).message);
    }
    const r = g.replicator;
    const bases = [...r.bases.values()];
    const rows = bases.reduce((n, b) => n + b.mirror.rows.length, 0);
    const blocks = bases.reduce((n, b) => n + b.mirror.blockCount, 0);
    const bytes = bases.reduce((n, b) => n + b.mirror.encryptedBytes, 0);
    return {
      ...this.summary(),
      steps: {
        recognized: r.access !== null,
        accessName: r.access?.name ?? null,
        tier: (r.limits?.tier as string | undefined) ?? r.access?.tier ?? null,
        bases: bases.map((b) => b.manifest?.title ?? b.storeId),
        blocks,
        bytes,
        rows,
        seconds: (Date.now() - started) / 1000,
        problems: bases.filter((b) => b.mirror.status !== 'ready').map((b) => ({ base: b.manifest?.title ?? b.storeId, status: b.mirror.status, message: b.mirror.problem?.message ?? null })),
      },
    };
  }

  private async applyNetwork(body: Record<string, unknown>) {
    const patch: Record<string, unknown> = {};
    if (body.host !== undefined) patch.host = String(body.host);
    if (body.port !== undefined) patch.port = Number(body.port);
    if (body.https === false) {
      patch.tlsCert = null;
      patch.tlsKey = null;
    } else if (typeof body.tlsCert === 'string' && typeof body.tlsKey === 'string') {
      if (!existsSync(body.tlsCert) || !existsSync(body.tlsKey)) throw new ApiError(400, 'tls_missing', 'Certificat ou clé introuvable sur cette machine');
      patch.tlsCert = body.tlsCert;
      patch.tlsKey = body.tlsKey;
    }
    if (body.corsClosed === true) patch.corsOrigins = [];
    const settable: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      const src = this.gate.config.sources[k as SettingKey];
      if (src !== 'env' && src !== 'file') settable[k] = v;
    }
    try {
      await this.gate.updateSettings(settable);
    } catch (err) {
      throw new ApiError(400, 'settings_refused', (err as Error).message);
    }
    return this.summary();
  }

  private dashboard() {
    const g = this.gate;
    const r = g.replicator;
    const bases = [...r.bases.values()];
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const recent = g.journal.list({ kind: 'all', since, limit: 5000 });
    const keys = [...new Map([...r.bases.values()].flatMap((b) => [...b.mirror.keys.values()]).map((k) => [`${k.epoch}|${k.generation}`, k])).values()];
    return {
      ...this.summary(),
      requests24h: g.metrics.served24h(),
      medianMs: g.metrics.medianMs(),
      rows: bases.reduce((n, b) => n + b.mirror.rows.length, 0),
      encryptedBytes: bases.reduce((n, b) => n + b.mirror.encryptedBytes, 0),
      writes24h: recent.filter((e) => e.kind === 'write').length,
      conflicts: g.metrics.value('filarr_gate_commit_conflicts_total'),
      webhooks: g.webhooks.stats(),
      traffic: g.metrics.traffic(),
      health: {
        expiresAt: r.access?.expiresAt ?? null,
        maxEpoch: keys.reduce((m, k) => Math.max(m, k.epoch), 0),
        maxGeneration: keys.reduce((m, k) => Math.max(m, k.generation), 0),
        cache: { kind: g.cache.kind, location: g.cache.location },
        version: g.version,
      },
      bases: g.model.bases().map((b) => ({
        storeId: b.storeId,
        slug: b.slug,
        title: b.title,
        views: b.views.length,
        rights: b.rights,
        rows: b.rows.length,
        version: b.version,
        lastChange: b.base.mirror.head?.updated ?? null,
        status: b.status,
        problem: b.base.mirror.problem?.message ?? null,
      })),
      quota: g.replicator.client?.quota ?? null,
    };
  }

  private allowedKeys(test: (k: ReturnType<Gate['keys']['list']>[number]) => boolean): string[] {
    return this.gate.keys.list().filter(test).map((k) => k.name);
  }

  /** Ce que la vue décide, en morceaux que l'interface met en mots dans sa langue. */
  private viewSummary(info: BaseInfo, view: BaseInfo['views'][number]) {
    const v = view.view;
    if (v.type === 'query') return { query: v.query?.sql ?? '' };
    const nameOf = (id: string) => info.properties.find((p) => p.id === id)?.name ?? id;
    const shown = orderedVisibleProperties(info.properties, v).length;
    return {
      filters: v.filters.length + (v.filterGroups?.length ?? 0),
      sorts: v.sorts.map((s) => ({ column: nameOf(s.propertyId), desc: s.direction === 'desc' })),
      columns: shown === info.properties.length ? null : shown,
    };
  }

  private bases() {
    const g = this.gate;
    const exposed = g.model.bases();
    const out = exposed.map((b) => {
      const writable = g.settings.write && b.rights === 'rw';
      return {
        storeId: b.storeId,
        slug: b.slug,
        title: b.title,
        rights: b.rights,
        status: b.status,
        problem: b.base.mirror.problem,
        version: b.version,
        rows: b.rows.length,
        blocks: b.base.mirror.blockCount,
        encryptedBytes: b.base.mirror.encryptedBytes,
        lastChange: b.base.mirror.head?.updated ?? null,
        keysHeld: b.base.mirror.heldKeys(),
        generation: b.base.mirror.generation,
        hk: b.base.mirror.hk,
        endpoint: `/v1/${b.slug}`,
        methods: writable ? ['GET', 'POST', 'PATCH', 'DELETE'] : ['GET'],
        keys: this.allowedKeys((k) => canReadBase(k, b.storeId)),
        writeKeys: this.allowedKeys((k) => canWrite(k, b.storeId, 'create') || canWrite(k, b.storeId, 'update') || canWrite(k, b.storeId, 'delete')),
        views: b.views.map((v) => ({
          id: v.view.id,
          slug: v.slug,
          name: v.view.name,
          type: v.view.type,
          endpoint: `/v1/${b.slug}/${v.slug}`,
          summary: this.viewSummary(b, v),
          keys: this.allowedKeys((k) => canReadView(k, b.storeId, v.view.id)),
        })),
        fields: b.fields.map((f) => {
          const target = f.target ? g.model.bases().find((x) => x.dbId === f.target) : undefined;
          const via = f.prop.type === 'rollup' ? b.properties.find((p) => p.id === f.prop.viaPropertyId) : undefined;
          const rollupTarget = via?.targetDbId ? g.model.bases().find((x) => x.dbId === via.targetDbId) : undefined;
          return {
            name: f.name,
            column: f.prop.name,
            type: f.prop.type,
            jsonType: f.type,
            options: f.options ?? null,
            writable: f.writable,
            numberFormat: f.prop.numberFormat ?? null,
            target: f.target ? { title: target?.title ?? null, granted: !!target } : null,
            unresolved: (f.target !== undefined && !target) || (f.prop.type === 'rollup' && !!via?.targetDbId && !rollupTarget),
          };
        }),
      };
    });
    const hidden = [...g.replicator.bases.values()]
      .filter((b) => !b.manifest)
      .map((b) => ({ storeId: b.storeId, slug: null, title: null, rights: b.rights, status: b.mirror.status, problem: b.mirror.problem ?? { code: 'manifest_missing', message: 'manifeste manquant : la base n’est pas encore publiée pour cet accès' } }));
    return [...out, ...hidden];
  }

  private tables() {
    const { mld, catalog } = this.gate.model.sql();
    return {
      tables: mld.map((t) => ({
        name: t.name,
        entity: t.entity ?? null,
        rows: catalog.get(t.name.toLowerCase())?.rows.length ?? 0,
        columns: t.columns.map((c) => ({ name: c.name, kind: c.kind, references: (c as { references?: string }).references ?? null })),
      })),
    };
  }

  private saveQuery(name: string, sql: string): SavedQuery {
    const g = this.gate;
    if (!name.trim()) throw new ApiError(400, 'name_required', 'Nom manquant');
    runSql(g.model.sql().catalog, sql); // refuse une requête fausse ou une écriture
    const taken = new Set(g.state.data.queries.map((q) => q.slug));
    const [base] = assignSlugs([name], 'vue');
    let slug = base ?? 'requete';
    for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
    const now = new Date().toISOString();
    const query: SavedQuery = { id: randomUUID(), name: name.trim(), slug, sql, createdAt: now, updatedAt: now };
    g.state.data.queries.push(query);
    g.state.saveNow();
    g.journal.add({ kind: 'admin', who: 'administration', what: `requête enregistrée · /v1/q/${slug}`, code: 'ok' });
    return query;
  }

  /** Les points d'accès qu'une clé peut viser (le formulaire « Nouvelle clé »). */
  private endpoints() {
    const g = this.gate;
    const out: Array<{ kind: 'base' | 'view' | 'query'; path: string; label: string; storeId?: string; viewId?: string; queryId?: string; writable: boolean }> = [];
    for (const b of g.model.bases()) {
      out.push({ kind: 'base', path: `/v1/${b.slug}`, label: b.title, storeId: b.storeId, writable: g.settings.write && b.rights === 'rw' });
      for (const v of b.views) out.push({ kind: 'view', path: `/v1/${b.slug}/${v.slug}`, label: `${b.title} · ${v.view.name}`, storeId: b.storeId, viewId: v.view.id, writable: false });
    }
    for (const q of g.state.data.queries) out.push({ kind: 'query', path: `/v1/q/${q.slug}`, label: q.name, queryId: q.id, writable: false });
    return out;
  }

  private keyView(k: ReturnType<Gate['keys']['list']>[number]) {
    const g = this.gate;
    const describe = (s: KeyScope): string => {
      if (s.target === 'all') return 'toutes les vues';
      if (s.target === 'query') return g.state.data.queries.find((q) => q.id === s.queryId)?.slug ?? 'requête supprimée';
      const base = g.model.baseById(s.storeId);
      if (s.target === 'view') return `${base?.slug ?? '?'}/${base?.views.find((v) => v.view.id === s.viewId)?.slug ?? '?'}`;
      return base?.slug ?? '?';
    };
    const writes = k.scopes.some((s) => s.target === 'base' && (s.create || s.update || s.delete));
    const expired = k.expiresAt !== null && Date.parse(k.expiresAt) < Date.now();
    const usage = g.keys.rateUsage(k.id);
    return {
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      endpoints: k.scopes.map(describe).join(', '),
      rights: writes ? 'write' : 'read',
      sql: k.sql,
      mcp: k.mcp,
      rateLimit: k.rateLimit,
      ipAllow: k.ipAllow,
      expiresAt: k.expiresAt,
      paused: k.paused,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      lastIp: k.lastIp,
      requests24h: g.keys.count24h(k.id),
      state: k.paused ? 'paused' : expired ? 'expired' : usage >= 0.8 ? 'near_rate' : 'active',
    };
  }

  private keyList() {
    return { keys: this.gate.keys.list().map((k) => this.keyView(k)), endpoints: this.endpoints(), write: this.gate.settings.write };
  }

  private keyInput(body: Record<string, unknown>) {
    const g = this.gate;
    const scopes: KeyScope[] = [];
    for (const raw of Array.isArray(body.scopes) ? body.scopes : []) {
      const s = raw as Record<string, unknown>;
      if (s.target === 'all') scopes.push({ target: 'all', read: true });
      else if (s.target === 'base' && typeof s.storeId === 'string' && g.replicator.bases.has(s.storeId)) {
        const scope = { target: 'base' as const, storeId: s.storeId, read: s.read === true, create: s.create === true, update: s.update === true, delete: s.delete === true };
        if (scope.read || scope.create || scope.update || scope.delete) scopes.push(scope);
      } else if (s.target === 'view' && typeof s.storeId === 'string' && typeof s.viewId === 'string') scopes.push({ target: 'view', storeId: s.storeId, viewId: s.viewId, read: true });
      else if (s.target === 'query' && typeof s.queryId === 'string') scopes.push({ target: 'query', queryId: s.queryId, read: true });
    }
    if (scopes.length === 0 && body.sql !== true && body.mcp !== true) throw new ApiError(400, 'scope_required', 'Choisissez au moins un point d’accès');
    const ipAllow = (Array.isArray(body.ipAllow) ? body.ipAllow : String(body.ipAllow ?? '').split(','))
      .map((x) => String(x).trim())
      .filter(Boolean);
    for (const r of ipAllow) if (!validRange(r)) throw new ApiError(400, 'bad_ip', `Adresse ou plage invalide : ${r}`);
    const days = Number(body.expiresInDays);
    return {
      name: String(body.name ?? ''),
      scopes,
      sql: body.sql === true,
      mcp: body.mcp === true,
      rateLimit: Number(body.rateLimit ?? 600) || 600,
      ipAllow,
      expiresAt: Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
    };
  }

  private webhookView(id: string) {
    const g = this.gate;
    const hook = g.webhooks.get(id);
    if (!hook) throw new ApiError(404, 'webhook_not_found', 'Webhook inconnu');
    const deliveries = g.webhooks.deliveries.get(id) ?? [];
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const base = hook.target ? g.model.baseById(hook.target.storeId) : undefined;
    const view = hook.target?.viewId ? base?.views.find((v) => v.view.id === hook.target!.viewId) : undefined;
    return {
      id: hook.id,
      name: hook.name,
      url: hook.url,
      secretSuffix: hook.secret.slice(-4),
      target: hook.target ? { storeId: hook.target.storeId, viewId: hook.target.viewId ?? null, base: base?.title ?? null, baseSlug: base?.slug ?? null, view: view?.view.name ?? null } : null,
      events: hook.events,
      filter: hook.filter,
      transition: hook.transition,
      fields: hook.fields,
      expand: hook.expand,
      paused: hook.paused,
      createdAt: hook.createdAt,
      pending: g.webhooks.pendingFor(id),
      delivered24h: deliveries.filter((d) => d.at >= since && d.status !== null && d.status >= 200 && d.status < 300).length,
      last: deliveries[0] ? { ...deliveries[0] } : null,
      deliveries: deliveries.slice(0, 50).map(({ body: _b, ...d }) => d),
    };
  }

  private webhookList() {
    const g = this.gate;
    return {
      webhooks: g.webhooks.list().map((h) => this.webhookView(h.id)),
      stats: g.webhooks.stats(),
      bases: g.model.bases().map((b) => ({ storeId: b.storeId, title: b.title, slug: b.slug, fields: b.fields.map((f) => ({ name: f.name, relation: f.prop.type === 'relation' })), views: b.views.filter((v) => v.view.type !== 'query').map((v) => ({ id: v.view.id, name: v.view.name, slug: v.slug })) })),
    };
  }

  private webhookInput(body: Record<string, unknown>) {
    const events = (Array.isArray(body.events) ? body.events : []).filter((e): e is WebhookEvent =>
      ['row.created', 'row.updated', 'row.deleted', 'gate.quota'].includes(String(e))
    );
    const target =
      typeof body.storeId === 'string' && body.storeId !== ''
        ? { storeId: body.storeId, ...(typeof body.viewId === 'string' && body.viewId !== '' ? { viewId: body.viewId } : {}) }
        : null;
    const filter = typeof body.filter === 'string' && body.filter.trim() !== '' ? body.filter.trim() : null;
    try {
      compileFilter(filter);
    } catch (err) {
      throw new ApiError(400, 'bad_filter', `Condition illisible : ${(err as Error).message}`);
    }
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean));
    const fields = list(body.fields);
    return {
      name: String(body.name ?? ''),
      url: String(body.url ?? ''),
      target,
      events,
      filter,
      transition: body.transition === true,
      fields: fields.length > 0 ? fields : null,
      expand: list(body.expand),
    };
  }

  private async limits() {
    const g = this.gate;
    const r = g.replicator;
    if (!this.publicLimits || Date.now() - this.publicLimits.at > 3_600_000) {
      try {
        const res = await fetch(new URL('public/api-limits', g.settings.apiUrl.endsWith('/') ? g.settings.apiUrl : `${g.settings.apiUrl}/`), { signal: AbortSignal.timeout(10_000) });
        const json = (await res.json()) as { data?: unknown };
        this.publicLimits = { at: Date.now(), data: res.ok ? (json.data ?? json) : null };
      } catch {
        this.publicLimits = { at: Date.now(), data: null };
      }
    }
    return {
      access: r.access,
      limits: r.limits,
      usage: r.usage,
      quota: r.client?.quota ?? null,
      quotaAlerts: r.quotaAlerts,
      basesInAccess: r.bases.size,
      peakPerMinute: r.client?.stats.peakPerMinute ?? 0,
      requestsToFilarr: r.client?.stats.requests ?? 0,
      limited: r.notBefore > Date.now() ? { code: r.limitedCode, until: new Date(r.notBefore).toISOString() } : null,
      publicLimits: this.publicLimits.data,
    };
  }

  private async settingsView() {
    const g = this.gate;
    const r = g.replicator;
    return {
      settings: g.settings,
      sources: g.config.sources,
      envNames: ENV_NAMES,
      stateDir: g.state.dir,
      configFile: g.config.configFile,
      token: r.identity ? { hint: r.identity.hint, fingerprint: r.identity.fingerprint, source: g.tokenSource } : null,
      access: r.access ? { name: r.access.name ?? null, expiresAt: r.access.expiresAt ?? null } : null,
      link: { state: r.link, detail: r.linkDetail, streamRefused: r.streamRefused, pollSeconds: g.settings.pollSeconds },
      cache: { kind: g.cache.kind, location: g.cache.location, bytes: await g.cache.size().catch(() => 0) },
      rows: [...r.bases.values()].reduce((n, b) => n + b.mirror.rows.length, 0),
      passwordFromEnv: g.config.adminPasswordFromEnv !== null,
      version: g.version,
    };
  }
}
