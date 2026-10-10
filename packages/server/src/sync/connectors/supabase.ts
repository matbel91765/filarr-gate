/**
 * Supabase (PostgREST du projet) — contrat `source-externe-1` § 1 : pages
 * `order` + `limit` + `offset`, repère `gte`, écriture SOUS CONDITION par un
 * filtre sur l'ancienne valeur (`col=eq.ancien` ou `col=is.null`) avec
 * `Prefer: return=representation` (zéro ligne rendue : la source a changé),
 * insertion avec la clé relue. La clé du projet part en `apikey` et
 * `Authorization: Bearer` vers l'hôte du projet seulement.
 */

import { canonicalKey, type SourceOp, type SourceRow } from '../../../../core/src/engine/extsrc';
import { call, columnsOf, ConnectorError, httpError, markerParam, type Connector, type ConnectorContext, type SourceWriteResult } from './types';

const PAGE = 1000;

/** Une valeur dans un filtre PostgREST (dates en ISO, booléens et nombres tels quels). */
function lit(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && /[,()":]/.test(v)) return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return String(v);
}

export function supabaseConnector(ctx: ConnectorContext): Connector {
  const def = ctx.def;
  const c = def.conn as { url: string; schema?: string };
  const table = String((def.from as { table?: string }).table);
  const base = `${c.url.replace(/\/+$/, '')}/rest/v1/${encodeURIComponent(table)}`;
  const schema = c.schema && c.schema !== 'public' ? c.schema : null;
  const headers = (write = false): Record<string, string> => ({
    apikey: ctx.secret,
    Authorization: `Bearer ${ctx.secret}`,
    Accept: 'application/json',
    ...(schema ? { 'Accept-Profile': schema, ...(write ? { 'Content-Profile': schema } : {}) } : {}),
    ...(write ? { 'Content-Type': 'application/json', Prefer: 'return=representation' } : {}),
  });
  const cols = columnsOf(def);
  const keyCols = def.key.cols;
  const order = keyCols.map((k) => `${encodeURIComponent(k)}.asc`).join(',');
  const select = cols.map(encodeURIComponent).join(',');

  const get = async (filters: string[]): Promise<Array<Record<string, unknown>>> => {
    const out: Array<Record<string, unknown>> = [];
    for (let offset = 0; ; offset += PAGE) {
      const q = [`select=${select}`, ...filters, `order=${order}`, `limit=${PAGE}`, `offset=${offset}`].join('&');
      const res = await call(ctx, `${base}?${q}`, { headers: headers() }, 'Supabase');
      if (!res.ok) throw await httpError(res, 'Supabase');
      const rows = (await res.json()) as Array<Record<string, unknown>>;
      out.push(...rows);
      if (rows.length < PAGE) break;
      if (out.length > 200_000) throw new ConnectorError('extdb_too_large', 'plus de 200 000 lignes lues');
    }
    return out;
  };
  const keyFilter = (k: Record<string, unknown>): string[] => keyCols.map((col) => `${encodeURIComponent(col)}=eq.${encodeURIComponent(lit(k[col]))}`);

  return {
    caps: { cas: true },
    async readAll(): Promise<SourceRow[]> {
      return (await get([])).map((raw) => ({ raw }));
    },
    async readSince(marker): Promise<SourceRow[]> {
      if (!def.marker) return this.readAll();
      return (await get([`${encodeURIComponent(def.marker.col)}=gte.${encodeURIComponent(lit(markerParam(def, marker)))}`])).map((raw) => ({ raw }));
    },
    async readKeys(keys): Promise<SourceRow[]> {
      const out: SourceRow[] = [];
      for (const k of keys) out.push(...(await get(keyFilter(k))).map((raw) => ({ raw })));
      return out;
    },
    async write(ops: readonly SourceOp[]): Promise<SourceWriteResult> {
      const result: SourceWriteResult = { failed: [], reread: new Map(), inserted: [] };
      for (const op of ops) {
        if (op.kind === 'update') {
          const cond = op.old === null || op.old === undefined ? `${encodeURIComponent(op.col)}=is.null` : `${encodeURIComponent(op.col)}=eq.${encodeURIComponent(lit(op.old))}`;
          const res = await call(ctx, `${base}?${[...keyFilter(op.keyValues), cond].join('&')}`, { method: 'PATCH', headers: headers(true), body: JSON.stringify({ [op.col]: op.value }) }, 'Supabase');
          if (!res.ok) throw await httpError(res, 'Supabase');
          const rows = (await res.json()) as Array<Record<string, unknown>>;
          if (rows.length === 0) result.failed.push({ key: op.key, col: op.col });
          else {
            const k = canonicalKey(keyCols.map((col) => rows[0]![col]));
            if (k !== null) result.reread.set(k, rows[0]!);
          }
        } else if (op.kind === 'insert') {
          const values = { ...op.values };
          if (def.key.gen === 'source') for (const col of keyCols) delete values[col];
          if (def.key.gen === 'runner') values[keyCols[0]!] = op.rowId;
          const res = await call(ctx, base, { method: 'POST', headers: headers(true), body: JSON.stringify(values) }, 'Supabase');
          if (!res.ok) throw await httpError(res, 'Supabase');
          const rows = (await res.json()) as Array<Record<string, unknown>>;
          result.inserted.push({ rowId: op.rowId, keyValues: rows[0] ? Object.fromEntries(keyCols.map((col) => [col, rows[0]![col]])) : null });
        } else {
          const res = await call(ctx, `${base}?${keyFilter(op.keyValues).join('&')}`, { method: 'DELETE', headers: headers(true) }, 'Supabase');
          if (!res.ok) throw await httpError(res, 'Supabase');
          await res.arrayBuffer().catch(() => undefined);
        }
      }
      return result;
    },
    async close() {
      /* rien à fermer */
    },
  };
}
