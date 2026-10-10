/**
 * Les connecteurs SQL (`d1`, `postgres`, `mysql`) — contrat `source-externe-1`
 * § 1 et § 6.6. Un seul algorithme, trois dialectes :
 *
 * - lecture par pages ORDONNÉES sur la clé (`LIMIT/OFFSET` pour D1, curseur sur
 *   la clé pour PostgreSQL et MySQL quand la clé tient en une colonne), repère `>=`
 *   (recouvrement voulu : des horodatages égaux ne se perdent pas) ;
 * - écriture SOUS CONDITION de la valeur lue :
 *   `UPDATE t SET c = :nouveau WHERE <clé> = :k AND c <égal-nul> :ancien` —
 *   `IS` (SQLite, D1), `IS NOT DISTINCT FROM` (PostgreSQL), `<=>` (MySQL) ; zéro
 *   ligne touchée : la source a changé pendant le passage, la cellule est laissée ;
 * - insertion avec la clé relue (`RETURNING`, `LAST_INSERT_ID()`) ;
 * - une transaction par passage pour PostgreSQL et MySQL, instruction par
 *   instruction pour D1 ;
 * - une source `query` se lit dans une transaction en LECTURE SEULE quand le
 *   moteur le permet, et ne s'écrit jamais.
 *
 * Tous les identifiants sont cités par le dialecte ; toutes les valeurs passent
 * en paramètres (jamais dans le texte SQL).
 */

import { canonicalKey, type ExtSourceDef, type SourceOp, type SourceRow } from '../../../../core/src/engine/extsrc';
import { columnsOf, ConnectorError, markerParam, type Connector, type SourceWriteResult } from './types';

export interface SqlResult {
  rows: Array<Record<string, unknown>>;
  changes: number;
  lastInsertId?: unknown;
}

export interface SqlDialect {
  name: 'sqlite' | 'postgres' | 'mysql';
  quote(id: string): string;
  ph(i: number): string;
  /** `col <égal-nul> ph` */
  nullSafeEq(col: string, ph: string): string;
  returning: boolean;
  /** Pagination par curseur sur une clé d'une colonne. */
  keyset: boolean;
  /** Une valeur de Filarr (déjà passée par `toSource`) en paramètre. */
  param(value: unknown): unknown;
}

export interface SqlExecutor {
  exec(sql: string, params: unknown[]): Promise<SqlResult>;
  begin?(readOnly: boolean): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  close(): Promise<void>;
}

const PAGE = 1000;

export const SQLITE: SqlDialect = {
  name: 'sqlite',
  quote: (id) => `"${id.replace(/"/g, '""')}"`,
  ph: () => '?',
  nullSafeEq: (col, ph) => `${col} IS ${ph}`,
  returning: true,
  keyset: false,
  param: (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : Array.isArray(v) ? v.join(',') : v),
};

export const POSTGRES: SqlDialect = {
  name: 'postgres',
  quote: (id) => `"${id.replace(/"/g, '""')}"`,
  ph: (i) => `$${i}`,
  nullSafeEq: (col, ph) => `${col} IS NOT DISTINCT FROM ${ph}`,
  returning: true,
  keyset: true,
  param: (v) => v,
};

export const MYSQL: SqlDialect = {
  name: 'mysql',
  quote: (id) => `\`${id.replace(/`/g, '``')}\``,
  ph: () => '?',
  nullSafeEq: (col, ph) => `${col} <=> ${ph}`,
  returning: false,
  keyset: true,
  param: (v) => (Array.isArray(v) ? v.join(',') : v),
};

/** `"schéma"."table"` ou `(requête) AS q`. */
function sourceOf(def: ExtSourceDef, d: SqlDialect): { from: string; writable: boolean } {
  const f = def.from as { table?: string; query?: string };
  if (typeof f.query === 'string') return { from: `(${f.query.trim().replace(/;\s*$/, '')}) AS q`, writable: false };
  const schema = d.name === 'postgres' && typeof def.conn.schema === 'string' && def.conn.schema !== '' ? `${d.quote(def.conn.schema)}.` : '';
  return { from: `${schema}${d.quote(String(f.table))}`, writable: true };
}

export class SqlConnector implements Connector {
  readonly caps = { cas: true };
  private readonly cols: string[];
  private readonly src: { from: string; writable: boolean };

  constructor(
    private readonly def: ExtSourceDef,
    private readonly d: SqlDialect,
    private readonly db: SqlExecutor
  ) {
    this.cols = columnsOf(def);
    this.src = sourceOf(def, d);
  }

  private select(): string {
    return `SELECT ${this.cols.map((c) => this.d.quote(c)).join(', ')} FROM ${this.src.from}`;
  }

  private orderBy(): string {
    return ` ORDER BY ${this.def.key.cols.map((c) => this.d.quote(c)).join(', ')}`;
  }

  private async readOnly<T>(fn: () => Promise<T>): Promise<T> {
    if (this.src.writable || !this.db.begin) return fn();
    await this.db.begin(true);
    try {
      return await fn();
    } finally {
      await this.db.rollback?.().catch(() => undefined);
    }
  }

  private async pages(where: string, params: unknown[]): Promise<SourceRow[]> {
    const out: SourceRow[] = [];
    const key = this.def.key.cols;
    if (this.d.keyset && key.length === 1) {
      const k = this.d.quote(key[0]!);
      let last: unknown = undefined;
      for (;;) {
        const conds = [where, last !== undefined ? `${k} > ${this.d.ph(params.length + 1)}` : ''].filter(Boolean);
        const sql = `${this.select()}${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''}${this.orderBy()} LIMIT ${PAGE}`;
        const res = await this.db.exec(sql, last !== undefined ? [...params, last] : params);
        for (const raw of res.rows) out.push({ raw });
        if (res.rows.length < PAGE) break;
        last = res.rows[res.rows.length - 1]![key[0]!];
        if (out.length > 200_000) throw new ConnectorError('extdb_too_large', 'plus de 200 000 lignes lues');
      }
      return out;
    }
    for (let offset = 0; ; offset += PAGE) {
      const sql = `${this.select()}${where ? ` WHERE ${where}` : ''}${this.orderBy()} LIMIT ${PAGE} OFFSET ${offset}`;
      const res = await this.db.exec(sql, params);
      for (const raw of res.rows) out.push({ raw });
      if (res.rows.length < PAGE) break;
      if (out.length > 200_000) throw new ConnectorError('extdb_too_large', 'plus de 200 000 lignes lues');
    }
    return out;
  }

  readAll(): Promise<SourceRow[]> {
    return this.readOnly(() => this.pages('', []));
  }

  readSince(marker: number | string): Promise<SourceRow[]> {
    const m = this.def.marker;
    if (!m) return this.readAll();
    return this.readOnly(() => this.pages(`${this.d.quote(m.col)} >= ${this.d.ph(1)}`, [markerParam(this.def, marker)]));
  }

  private keyWhere(keys: ReadonlyArray<Record<string, unknown>>, start: number): { sql: string; params: unknown[] } {
    const cols = this.def.key.cols;
    const params: unknown[] = [];
    const parts = keys.map((k) => {
      const eqs = cols.map((c) => {
        params.push(k[c]);
        return `${this.d.quote(c)} = ${this.d.ph(start + params.length)}`;
      });
      return `(${eqs.join(' AND ')})`;
    });
    return { sql: parts.join(' OR '), params };
  }

  async readKeys(keys: ReadonlyArray<Record<string, unknown>>): Promise<SourceRow[]> {
    const out: SourceRow[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      const w = this.keyWhere(keys.slice(i, i + 100), 0);
      const res = await this.readOnly(() => this.db.exec(`${this.select()} WHERE ${w.sql}`, w.params));
      for (const raw of res.rows) out.push({ raw });
    }
    return out;
  }

  async write(ops: readonly SourceOp[]): Promise<SourceWriteResult> {
    if (!this.src.writable) throw new ConnectorError('extdb_not_found', 'une source « query » ne s’écrit pas');
    const result: SourceWriteResult = { failed: [], reread: new Map(), inserted: [] };
    if (ops.length === 0) return result;
    const d = this.d;
    const table = this.src.from;
    const keyCols = this.def.key.cols;
    await this.db.begin?.(false);
    try {
      const touched = new Map<string, Record<string, unknown>>();
      for (const op of ops) {
        if (op.kind === 'update') {
          const params: unknown[] = [d.param(op.value)];
          const where = keyCols.map((c) => {
            params.push(op.keyValues[c]);
            return `${d.quote(c)} = ${d.ph(params.length)}`;
          });
          params.push(op.old);
          where.push(d.nullSafeEq(d.quote(op.col), d.ph(params.length)));
          const res = await this.db.exec(`UPDATE ${table} SET ${d.quote(op.col)} = ${d.ph(1)} WHERE ${where.join(' AND ')}`, params);
          if (res.changes === 0) result.failed.push({ key: op.key, col: op.col });
          else touched.set(op.key, op.keyValues);
        } else if (op.kind === 'insert') {
          const values = { ...op.values };
          if (this.def.key.gen === 'source') for (const c of keyCols) delete values[c];
          if (this.def.key.gen === 'runner') values[keyCols[0]!] = op.rowId;
          const cols = Object.keys(values);
          const params = cols.map((c) => d.param(values[c]));
          const sql = `INSERT INTO ${table} (${cols.map((c) => d.quote(c)).join(', ')}) VALUES (${cols.map((_, i) => d.ph(i + 1)).join(', ')})${d.returning ? ` RETURNING ${keyCols.map((c) => d.quote(c)).join(', ')}` : ''}`;
          const res = await this.db.exec(sql, params);
          let keyValues: Record<string, unknown> | null = null;
          if (this.def.key.gen === 'runner') keyValues = { [keyCols[0]!]: op.rowId };
          else if (res.rows[0]) keyValues = Object.fromEntries(keyCols.map((c) => [c, res.rows[0]![c]]));
          else if (res.lastInsertId !== undefined && keyCols.length === 1) keyValues = { [keyCols[0]!]: res.lastInsertId };
          result.inserted.push({ rowId: op.rowId, keyValues });
        } else {
          const params: unknown[] = [];
          const where = keyCols.map((c) => {
            params.push(op.keyValues[c]);
            return `${d.quote(c)} = ${d.ph(params.length)}`;
          });
          await this.db.exec(`DELETE FROM ${table} WHERE ${where.join(' AND ')}`, params);
        }
      }
      // Relire ce qui a été écrit, dans la même transaction (l'écho : arrondis, dates normalisées)
      const keys = [...touched.values()];
      for (let i = 0; i < keys.length; i += 100) {
        const w = this.keyWhere(keys.slice(i, i + 100), 0);
        const res = await this.db.exec(`${this.select()} WHERE ${w.sql}`, w.params);
        for (const raw of res.rows) {
          const k = canonicalKey(keyCols.map((c) => raw[c]));
          if (k !== null) result.reread.set(k, raw);
        }
      }
      await this.db.commit?.();
    } catch (err) {
      await this.db.rollback?.().catch(() => undefined);
      throw err;
    }
    return result;
  }

  close(): Promise<void> {
    return this.db.close();
  }
}
