/**
 * Lire : les lignes d'une base (filtres, tri, champs, pages), une vue rejouée par
 * le moteur de vues de Filarr, une requête SQL en lecture seule par son moteur SQL.
 */

import { parseStatement, SqlSyntaxError, type SelectStatement } from '../../../core/src/engine/sql/parser';
import { runSelect, SqlError, type SqlCatalog } from '../../../core/src/engine/sql/run';
import type { SqlValue } from '../../../core/src/engine/sql/values';
import { viewRows } from '../../../core/src/engine';
import { applySearch, orderedVisibleProperties } from '../../../core/src/viewEngine';
import type { DbRow } from '../../../core/src/types';
import { rowJson, type FieldDef } from './fields';
import type { BaseInfo, GateModel, ViewInfo } from './model';
import { ApiError } from '../errors';

export { ApiError };

export const MAX_LIMIT = 1000;
export const DEFAULT_LIMIT = 100;
/** Paramètres de la requête qui ne sont pas des filtres. */
const CONTROL = new Set(['limit', 'cursor', 'fields', 'sort', 'q', 'since']);
const OPS = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'in', 'empty']);

export interface RowsPage {
  rows: Array<Record<string, unknown>>;
  next: string | null;
  total: number;
  version: number;
  unresolved?: string[];
}

interface Filter {
  field: string;
  op: string;
  value: string;
}

function parseFilters(params: URLSearchParams, fields: readonly FieldDef[]): Filter[] {
  const names = new Set(['id', 'created_at', 'updated_at', ...fields.map((f) => f.name)]);
  const out: Filter[] = [];
  for (const [key, value] of params) {
    if (CONTROL.has(key)) continue;
    const m = /^([A-Za-z0-9_]+)(?:\[([a-z]+)\])?$/.exec(key);
    if (!m) throw new ApiError(400, 'bad_filter', `Paramètre illisible : ${key}`);
    const [, field, op = 'eq'] = m;
    if (!names.has(field!)) throw new ApiError(400, 'unknown_field', `Champ inconnu : ${field}`, { field });
    if (!OPS.has(op)) throw new ApiError(400, 'bad_filter', `Opérateur inconnu : ${op} (eq, ne, lt, lte, gt, gte, contains, in, empty)`);
    out.push({ field: field!, op, value });
  }
  return out;
}

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

function compareJson(a: unknown, b: unknown): number {
  const aNull = a === null || a === undefined || (Array.isArray(a) && a.length === 0);
  const bNull = b === null || b === undefined || (Array.isArray(b) && b.length === 0);
  if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return collator.compare(Array.isArray(a) ? a.join(', ') : String(a), Array.isArray(b) ? b.join(', ') : String(b));
}

function matches(value: unknown, f: Filter): boolean {
  const empty = value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
  if (f.op === 'empty') return (f.value !== 'false') === empty;
  if (Array.isArray(value)) {
    if (f.op === 'contains' || f.op === 'eq') return value.some((v) => String(v).toLowerCase() === f.value.toLowerCase());
    if (f.op === 'ne') return !value.some((v) => String(v).toLowerCase() === f.value.toLowerCase());
    if (f.op === 'in') return f.value.split(',').some((x) => value.map(String).includes(x));
    return false;
  }
  if (f.op === 'in') return f.value.split(',').includes(String(value));
  if (f.op === 'contains') return !empty && String(value).toLowerCase().includes(f.value.toLowerCase());
  if (empty) return f.op === 'ne';
  let cmp: number;
  if (typeof value === 'number') {
    const n = Number(f.value);
    if (!Number.isFinite(n)) return f.op === 'ne';
    cmp = value - n;
  } else if (typeof value === 'boolean') {
    cmp = Number(value) - Number(/^(1|true|oui|yes)$/i.test(f.value));
  } else {
    cmp = collator.compare(String(value), f.value);
  }
  switch (f.op) {
    case 'eq':
      return cmp === 0;
    case 'ne':
      return cmp !== 0;
    case 'lt':
      return cmp < 0;
    case 'lte':
      return cmp <= 0;
    case 'gt':
      return cmp > 0;
    case 'gte':
      return cmp >= 0;
    default:
      return false;
  }
}

function cursorOffset(cursor: string | null): number {
  if (!cursor) return 0;
  const m = /^o(\d+)$/.exec(cursor);
  if (!m) throw new ApiError(400, 'bad_cursor', 'Curseur illisible');
  return Number(m[1]);
}

function limitOf(params: URLSearchParams): number {
  const raw = params.get('limit');
  if (raw === null) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ApiError(400, 'bad_limit', `limit : entier de 1 à ${MAX_LIMIT}`);
  return Math.min(n, MAX_LIMIT);
}

/**
 * Une page de lignes déjà ordonnées : champs choisis, filtres de la requête, tri
 * demandé, pagination par curseur. `fields` borne ce que l'appelant peut voir.
 */
export function pageOf(
  model: GateModel,
  info: BaseInfo,
  rows: readonly DbRow[],
  fields: readonly FieldDef[],
  params: URLSearchParams
): RowsPage {
  const env = model.env(info);
  const unresolved = new Set<string>();
  const since = params.get('since');
  let source = rows;
  if (since !== null) {
    const v = Number(since.replace(/^v/, ''));
    if (!Number.isInteger(v) || v < 0) throw new ApiError(400, 'bad_since', 'since : un numéro de version');
    source = rows.filter((r) => (info.base.mirror.rowSeq.get(r.id) ?? 0) > v);
  }
  const q = params.get('q');
  if (q) source = applySearch([...source], info.properties, q);
  let objects = source.map((r) => rowJson(fields, r, env, unresolved));
  const filters = parseFilters(params, fields);
  for (const f of filters) objects = objects.filter((o) => matches(o[f.field], f));
  const sort = params.get('sort');
  if (sort) {
    const keys = sort.split(',').map((s) => s.trim()).filter(Boolean).map((s) => ({ field: s.replace(/^-/, ''), desc: s.startsWith('-') }));
    const names = new Set(['id', 'created_at', 'updated_at', ...fields.map((f) => f.name)]);
    for (const k of keys) if (!names.has(k.field)) throw new ApiError(400, 'unknown_field', `Champ inconnu : ${k.field}`, { field: k.field });
    objects = objects
      .map((o, i) => ({ o, i }))
      .sort((a, b) => {
        for (const k of keys) {
          const c = compareJson(a.o[k.field], b.o[k.field]);
          if (c !== 0) return k.desc && a.o[k.field] != null && b.o[k.field] != null ? -c : c;
        }
        return a.i - b.i;
      })
      .map((x) => x.o);
  }
  const wanted = params.get('fields');
  if (wanted) {
    const keep = new Set(['id', ...wanted.split(',').map((s) => s.trim()).filter(Boolean)]);
    const names = new Set(['id', 'created_at', 'updated_at', ...fields.map((f) => f.name)]);
    for (const k of keep) if (!names.has(k)) throw new ApiError(400, 'unknown_field', `Champ inconnu : ${k}`, { field: k });
    objects = objects.map((o) => Object.fromEntries(Object.entries(o).filter(([k]) => keep.has(k))));
  }
  const offset = cursorOffset(params.get('cursor'));
  const limit = limitOf(params);
  const page = objects.slice(offset, offset + limit);
  return {
    rows: page,
    next: offset + limit < objects.length ? `o${offset + limit}` : null,
    total: objects.length,
    version: info.version,
    ...(unresolved.size > 0 ? { unresolved: [...unresolved].sort() } : {}),
  };
}

/** Toutes les lignes d'une base, dans l'ordre manuel. */
export function listRows(model: GateModel, info: BaseInfo, params: URLSearchParams): RowsPage {
  return pageOf(model, info, info.rows, info.fields, params);
}

/** Les champs que montre une vue (colonnes masquées et ordre de la vue). */
export function viewFields(info: BaseInfo, view: ViewInfo): FieldDef[] {
  const byId = new Map(info.fields.map((f) => [f.prop.id, f]));
  return orderedVisibleProperties(info.properties, view.view)
    .map((p) => byId.get(p.id))
    .filter((f): f is FieldDef => f !== undefined);
}

/** Une vue rejouée par le moteur de Filarr : ses filtres, son tri, ses colonnes. */
export function viewPage(model: GateModel, info: BaseInfo, view: ViewInfo, params: URLSearchParams): RowsPage & { view: { slug: string; name: string } } {
  if (view.view.type === 'query') {
    const sql = view.view.query?.sql ?? '';
    const res = runSql(model.sql().catalog, sql);
    return { ...sqlPage(res, params), version: info.version, view: { slug: view.slug, name: view.view.name } };
  }
  const rows = viewRows(model.data(info), view.view, model.env(info).ctx);
  return { ...pageOf(model, info, rows, viewFields(info, view), params), view: { slug: view.slug, name: view.view.name } };
}

// ==================== SQL ====================

export interface SqlOutcome {
  columns: string[];
  rows: unknown[][];
  ms: number;
  scanned: number;
  truncated: boolean;
}

export const SQL_MAX_ROWS = 10_000;

const jsonSql = (v: SqlValue): unknown =>
  typeof v === 'bigint' ? (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : v;

/** Les tables nommées par une requête (pour le compte des lignes parcourues). */
function tablesOf(stmt: SelectStatement): string[] {
  return [stmt.from?.table, ...stmt.joins.map((j) => j.table)].filter((t): t is string => typeof t === 'string');
}

/** Un SELECT seulement : toute écriture est refusée (`sql_read_only`). */
export function runSql(catalog: SqlCatalog, sql: string): SqlOutcome {
  if (typeof sql !== 'string' || sql.trim() === '') throw new ApiError(400, 'sql_empty', 'Requête vide');
  if (sql.length > 64 * 1024) throw new ApiError(413, 'sql_too_long', 'Requête trop longue (64 Kio au plus)');
  const started = performance.now();
  try {
    const stmt = parseStatement(sql);
    if (stmt.kind !== 'select') {
      throw new ApiError(400, 'sql_read_only', 'Lecture seule : seules les requêtes SELECT sont acceptées. Les écritures passent par les points d’accès.');
    }
    const res = runSelect(catalog, stmt);
    const scanned = tablesOf(stmt).reduce((n, t) => n + (catalog.get(t.toLowerCase())?.rows.length ?? 0), 0);
    const truncated = res.rows.length > SQL_MAX_ROWS;
    return {
      columns: res.columns,
      rows: res.rows.slice(0, SQL_MAX_ROWS).map((r) => r.map(jsonSql)),
      ms: Math.round((performance.now() - started) * 100) / 100,
      scanned,
      truncated,
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof SqlSyntaxError) throw new ApiError(400, 'sql_syntax', err.message, { position: err.position, sqlCode: err.code });
    if (err instanceof SqlError) throw new ApiError(400, 'sql_error', err.message, { sqlCode: err.code });
    throw new ApiError(400, 'sql_error', (err as Error).message);
  }
}

/** Le résultat d'une requête en lignes-objets paginées. */
export function sqlPage(res: SqlOutcome, params: URLSearchParams): Omit<RowsPage, 'version'> & { columns: string[] } {
  const objects = res.rows.map((r) => Object.fromEntries(res.columns.map((c, i) => [c, r[i]])));
  const offset = cursorOffset(params.get('cursor'));
  const limit = limitOf(params);
  return {
    columns: res.columns,
    rows: objects.slice(offset, offset + limit),
    next: offset + limit < objects.length ? `o${offset + limit}` : null,
    total: objects.length,
  };
}
