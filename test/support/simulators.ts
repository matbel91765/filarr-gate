/**
 * DES SERVICES SIMULÉS pour éprouver les connecteurs sans réseau ni compte :
 * l'API HTTP de D1 (sur `node:sqlite`, le même moteur que D1), un PostgREST de
 * Supabase (sur `node:sqlite`), Airtable, Notion et Google Sheets en mémoire. Ils
 * suivent les formes des réponses réelles relevées dans la documentation des
 * services (pagination, filtres, codes d'erreur) ; ils ne sont pas ces services.
 *
 * `routeFetch` aiguille un `fetch` vers eux par nom d'hôte : la boîte garde ses
 * vraies adresses (`api.cloudflare.com`…), rien ne sort de la machine.
 */

import { DatabaseSync } from 'node:sqlite';

type Handler = (req: Request) => Promise<Response> | Response;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** Un `fetch` qui sert certains hôtes par des simulateurs ; les autres partent vers le vrai `fetch`. */
export function routeFetch(routes: Record<string, Handler>, log?: Array<{ method: string; url: string; auth: string | null }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const host = new URL(req.url).hostname;
    log?.push({ method: req.method, url: req.url, auth: req.headers.get('authorization') });
    const h = routes[host];
    if (!h) return fetch(input, init);
    return h(req);
  }) as typeof fetch;
}

const sqlValue = (v: unknown): unknown => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

// ==================== D1 ====================

export class D1Sim {
  readonly db = new DatabaseSync(':memory:');
  readonly token: string;
  calls = 0;

  constructor(token = 'jeton-d1-essai') {
    this.token = token;
  }

  exec(sql: string, params: unknown[] = []): { results: Array<Record<string, unknown>>; changes: number; last: number } {
    const stmt = this.db.prepare(sql);
    if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
      const rows = stmt.all(...(params.map(sqlValue) as never[])) as Array<Record<string, unknown>>;
      return { results: rows.map((r) => ({ ...r })), changes: /^\s*(select|with)/i.test(sql) ? 0 : rows.length, last: 0 };
    }
    const r = stmt.run(...(params.map(sqlValue) as never[]));
    return { results: [], changes: Number(r.changes), last: Number(r.lastInsertRowid) };
  }

  handler: Handler = async (req) => {
    this.calls += 1;
    if (req.headers.get('authorization') !== `Bearer ${this.token}`) return json(401, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
    if (!/\/client\/v4\/accounts\/[^/]+\/d1\/database\/[^/]+\/query$/.test(new URL(req.url).pathname)) return json(404, { success: false, errors: [{ message: 'not found' }] });
    const body = (await req.json()) as { sql: string; params?: unknown[] };
    try {
      const r = this.exec(body.sql, body.params ?? []);
      return json(200, { success: true, errors: [], messages: [], result: [{ results: r.results, success: true, meta: { changes: r.changes, last_row_id: r.last, rows_read: r.results.length } }] });
    } catch (err) {
      return json(400, { success: false, errors: [{ code: 7500, message: (err as Error).message }] });
    }
  };
}

// ==================== Supabase (PostgREST) ====================

export class SupabaseSim {
  readonly db = new DatabaseSync(':memory:');
  constructor(readonly key = 'cle-supabase-essai') {}

  private where(params: URLSearchParams): { sql: string; args: unknown[] } {
    const parts: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
      const m = /^(eq|neq|gte|gt|lte|lt|is|in)\.(.*)$/s.exec(v);
      if (!m) continue;
      const col = `"${k.replace(/"/g, '""')}"`;
      const [, op, raw] = m as unknown as [string, string, string];
      const val = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replace(/\\"/g, '"') : raw;
      if (op === 'is') parts.push(val === 'null' ? `${col} IS NULL` : `${col} IS ${val === 'true' ? 1 : 0}`);
      else if (op === 'in') {
        const items = val.replace(/^\(|\)$/g, '').split(',');
        parts.push(`${col} IN (${items.map(() => '?').join(',')})`);
        args.push(...items);
      } else {
        parts.push(`${col} ${{ eq: '=', neq: '<>', gte: '>=', gt: '>', lte: '<=', lt: '<' }[op]} ?`);
        args.push(/^-?\d+(\.\d+)?$/.test(val) ? Number(val) : val);
      }
    }
    return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', args };
  }

  handler: Handler = async (req) => {
    if (req.headers.get('apikey') !== this.key) return json(401, { message: 'Invalid API key' });
    const url = new URL(req.url);
    const m = /^\/rest\/v1\/([^/]+)$/.exec(url.pathname);
    if (!m) return json(404, { message: 'not found' });
    const table = `"${decodeURIComponent(m[1]!).replace(/"/g, '""')}"`;
    const p = url.searchParams;
    const w = this.where(p);
    try {
      if (req.method === 'GET') {
        const sel = (p.get('select') ?? '*').split(',').map((c) => (c === '*' ? '*' : `"${c}"`)).join(', ');
        const order = p.get('order') ? ` ORDER BY ${p.get('order')!.split(',').map((o) => { const [c, dir] = o.split('.'); return `"${c}" ${dir === 'desc' ? 'DESC' : 'ASC'}`; }).join(', ')}` : '';
        const rows = this.db.prepare(`SELECT ${sel} FROM ${table}${w.sql}${order} LIMIT ${Number(p.get('limit') ?? 1000)} OFFSET ${Number(p.get('offset') ?? 0)}`).all(...(w.args as never[]));
        return json(200, rows.map((r) => ({ ...(r as object) })));
      }
      if (req.method === 'PATCH') {
        const body = (await req.json()) as Record<string, unknown>;
        const cols = Object.keys(body);
        const rows = this.db.prepare(`UPDATE ${table} SET ${cols.map((c) => `"${c}" = ?`).join(', ')}${w.sql} RETURNING *`).all(...(cols.map((c) => sqlValue(body[c])) as never[]), ...(w.args as never[]));
        return json(200, rows.map((r) => ({ ...(r as object) })));
      }
      if (req.method === 'POST') {
        const body = (await req.json()) as Record<string, unknown>;
        const cols = Object.keys(body);
        const rows = this.db.prepare(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING *`).all(...(cols.map((c) => sqlValue(body[c])) as never[]));
        return json(201, rows.map((r) => ({ ...(r as object) })));
      }
      if (req.method === 'DELETE') {
        this.db.prepare(`DELETE FROM ${table}${w.sql}`).run(...(w.args as never[]));
        return new Response(null, { status: 204 });
      }
    } catch (err) {
      return json(400, { message: (err as Error).message });
    }
    return json(405, { message: 'method' });
  };
}

// ==================== Airtable ====================

export class AirtableSim {
  readonly records = new Map<string, { id: string; createdTime: string; fields: Record<string, unknown> }>();
  private n = 0;
  constructor(readonly token = 'pat-airtable-essai') {}

  add(fields: Record<string, unknown>): string {
    const id = `rec${String((this.n += 1)).padStart(14, '0')}`;
    this.records.set(id, { id, createdTime: new Date().toISOString(), fields: { ...fields } });
    return id;
  }

  /** Un sous-ensemble de `filterByFormula` : `OR(AND(RECORD_ID()='…'),…)`, `OR(AND({champ}='…'),…)`, `IS_AFTER`. */
  private match(formula: string | null, r: { id: string; fields: Record<string, unknown> }): boolean {
    if (!formula) return true;
    const ids = [...formula.matchAll(/RECORD_ID\(\)='([^']*)'/g)].map((m) => m[1]);
    if (ids.length) return ids.includes(r.id);
    const eqs = [...formula.matchAll(/\{([^}]+)\}='((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1]!, m[2]!.replace(/\\'/g, "'")] as const);
    if (eqs.length) return eqs.some(([f, v]) => String(r.fields[f] ?? '') === v);
    const after = /IS_AFTER\(\{([^}]+)\},'([^']+)'\)/.exec(formula);
    if (after) return String(r.fields[after[1]!] ?? '') >= after[2]!;
    return true;
  }

  handler: Handler = async (req) => {
    if (req.headers.get('authorization') !== `Bearer ${this.token}`) return json(401, { error: { type: 'AUTHENTICATION_REQUIRED' } });
    const url = new URL(req.url);
    if (req.method === 'GET') {
      const all = [...this.records.values()].filter((r) => this.match(url.searchParams.get('filterByFormula'), r));
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const size = Number(url.searchParams.get('pageSize') ?? 100);
      const page = all.slice(offset, offset + size);
      return json(200, { records: page, ...(offset + size < all.length ? { offset: String(offset + size) } : {}) });
    }
    const body = req.method === 'DELETE' ? null : ((await req.json()) as { records: Array<{ id?: string; fields: Record<string, unknown> }> });
    if (req.method === 'PATCH') {
      const out = body!.records.map((u) => {
        const r = this.records.get(u.id!)!;
        Object.assign(r.fields, u.fields);
        return r;
      });
      return json(200, { records: out });
    }
    if (req.method === 'POST') return json(200, { records: body!.records.map((u) => this.records.get(this.add(u.fields))!) });
    if (req.method === 'DELETE') {
      const ids = url.searchParams.getAll('records[]');
      for (const id of ids) this.records.delete(id);
      return json(200, { records: ids.map((id) => ({ id, deleted: true })) });
    }
    return json(405, {});
  };
}

// ==================== Notion ====================

type NProp = { type: string } & Record<string, unknown>;

export class NotionSim {
  readonly pages = new Map<string, { id: string; last_edited_time: string; created_time: string; archived: boolean; properties: Record<string, NProp> }>();
  readonly schema: Record<string, string>;
  private n = 0;
  constructor(schema: Record<string, string>, readonly token = 'secret_notion_essai') {
    this.schema = schema;
  }

  private value(type: string, v: unknown): NProp {
    switch (type) {
      case 'title':
      case 'rich_text':
        return { type, [type]: v === null || v === undefined || v === '' ? [] : [{ type: 'text', text: { content: String(v) }, plain_text: String(v) }] };
      case 'select':
      case 'status':
        return { type, [type]: v ? { name: String(v) } : null };
      case 'multi_select':
        return { type, multi_select: (Array.isArray(v) ? v : []).map((name) => ({ name })) };
      case 'date':
        return { type, date: v ? { start: String(v) } : null };
      default:
        return { type, [type]: v ?? null };
    }
  }

  add(values: Record<string, unknown>): string {
    const id = `00000000-0000-4000-8000-${String((this.n += 1)).padStart(12, '0')}`;
    const now = new Date().toISOString();
    const properties = Object.fromEntries(Object.entries(this.schema).map(([name, type]) => [name, this.value(type, values[name])]));
    this.pages.set(id, { id, last_edited_time: now, created_time: now, archived: false, properties });
    return id;
  }

  /** Le format d'écriture de Notion vers un format de lecture. */
  private fromInput(type: string, input: unknown): NProp {
    const v = (input as Record<string, unknown>)[type];
    if (type === 'title' || type === 'rich_text') return this.value(type, Array.isArray(v) && v.length ? (v[0] as { text: { content: string } }).text.content : null);
    if (type === 'select' || type === 'status') return this.value(type, (v as { name?: string } | null)?.name ?? null);
    if (type === 'multi_select') return this.value(type, (v as Array<{ name: string }>).map((x) => x.name));
    if (type === 'date') return this.value(type, (v as { start?: string } | null)?.start ?? null);
    return this.value(type, v);
  }

  handler: Handler = async (req) => {
    if (req.headers.get('authorization') !== `Bearer ${this.token}`) return json(401, { object: 'error', code: 'unauthorized' });
    if (!req.headers.get('notion-version')) return json(400, { object: 'error', code: 'missing_version' });
    const path = new URL(req.url).pathname;
    if (/\/v1\/databases\/[^/]+$/.test(path) && req.method === 'GET') return json(200, { properties: Object.fromEntries(Object.entries(this.schema).map(([k, t]) => [k, { type: t }])) });
    if (/\/v1\/databases\/[^/]+\/query$/.test(path)) {
      const body = (await req.json()) as { page_size?: number; start_cursor?: string; filter?: { last_edited_time?: { on_or_after?: string } } };
      const since = body.filter?.last_edited_time?.on_or_after;
      const all = [...this.pages.values()].filter((p) => !p.archived && (!since || p.last_edited_time >= since));
      const start = Number(body.start_cursor ?? 0);
      const size = body.page_size ?? 100;
      return json(200, { results: all.slice(start, start + size), has_more: start + size < all.length, next_cursor: start + size < all.length ? String(start + size) : null });
    }
    const pm = /\/v1\/pages\/([^/]+)$/.exec(path);
    if (pm && req.method === 'GET') {
      const p = this.pages.get(decodeURIComponent(pm[1]!));
      return p ? json(200, p) : json(404, { object: 'error', code: 'object_not_found' });
    }
    if (pm && req.method === 'PATCH') {
      const p = this.pages.get(decodeURIComponent(pm[1]!));
      if (!p) return json(404, { object: 'error', code: 'object_not_found' });
      const body = (await req.json()) as { properties?: Record<string, unknown>; archived?: boolean };
      if (body.archived) p.archived = true;
      for (const [name, input] of Object.entries(body.properties ?? {})) p.properties[name] = this.fromInput(this.schema[name]!, input);
      p.last_edited_time = new Date().toISOString();
      return json(200, p);
    }
    if (path.endsWith('/v1/pages') && req.method === 'POST') {
      const body = (await req.json()) as { properties: Record<string, unknown> };
      const id = this.add({});
      const p = this.pages.get(id)!;
      for (const [name, input] of Object.entries(body.properties)) p.properties[name] = this.fromInput(this.schema[name]!, input);
      return json(200, p);
    }
    return json(404, { object: 'error', code: 'invalid_request_url' });
  };
}

// ==================== Google Sheets (et son jeton OAuth) ====================

export class SheetsSim {
  values: unknown[][];
  sheetId = 7;
  tokens = new Set<string>();
  assertions: string[] = [];
  constructor(header: string[], readonly tab = 'Tarifs') {
    this.values = [header];
  }

  oauth: Handler = async (req) => {
    const form = new URLSearchParams(await req.text());
    if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return json(400, { error: 'unsupported_grant_type' });
    const assertion = form.get('assertion') ?? '';
    this.assertions.push(assertion);
    if (assertion.split('.').length !== 3) return json(400, { error: 'invalid_grant' });
    const token = `ya29.essai-${this.tokens.size + 1}`;
    this.tokens.add(token);
    return json(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
  };

  private col(letters: string): number {
    return letters.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  }

  handler: Handler = async (req) => {
    const auth = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!this.tokens.has(auth)) return json(401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    if (req.method === 'GET' && path.includes('/values/')) return json(200, { range: this.tab, majorDimension: 'ROWS', values: this.values });
    if (req.method === 'GET') return json(200, { sheets: [{ properties: { sheetId: this.sheetId, title: this.tab } }] });
    if (path.endsWith('/values:batchUpdate')) {
      const body = (await req.json()) as { data: Array<{ range: string; values: unknown[][] }> };
      for (const d of body.data) {
        const m = /!([A-Z]+)(\d+)$/.exec(d.range)!;
        const row = Number(m[2]) - 1;
        const col = this.col(m[1]!);
        while (this.values.length <= row) this.values.push([]);
        const line = this.values[row]!;
        while (line.length <= col) line.push('');
        line[col] = d.values[0]![0];
      }
      return json(200, { totalUpdatedCells: body.data.length });
    }
    if (path.includes(':append')) {
      const body = (await req.json()) as { values: unknown[][] };
      this.values.push(...body.values.map((r) => [...r]));
      return json(200, { updates: { updatedRows: body.values.length } });
    }
    if (path.endsWith(':batchUpdate')) {
      const body = (await req.json()) as { requests: Array<{ deleteDimension: { range: { startIndex: number; endIndex: number } } }> };
      for (const r of body.requests) this.values.splice(r.deleteDimension.range.startIndex, r.deleteDimension.range.endIndex - r.deleteDimension.range.startIndex);
      return json(200, {});
    }
    return json(404, {});
  };
}
