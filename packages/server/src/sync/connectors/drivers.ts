/**
 * Les exécutants SQL de chaque moteur :
 * - `d1` : l'API HTTP de Cloudflare (`POST /client/v4/accounts/:compte/d1/database/:base/query`),
 *   requêtes paramétrées, jeton en `Authorization: Bearer` (hôte `api.cloudflare.com` seul) ;
 * - `postgres` : le pilote `pg` (pur JS), chargé à la demande, TLS vérifié d'office
 *   (`verify-full`), `require` sans vérification du certificat, `off-local` sur le
 *   réseau local seulement ;
 * - `mysql` : le pilote `mysql2/promise`, mêmes règles TLS.
 */

import type { ExtSourceDef } from '../../../../core/src/engine/extsrc';
import { SqlConnector, MYSQL, POSTGRES, SQLITE, type SqlExecutor, type SqlResult } from './sql';
import { call, ConnectorError, httpError, type Connector, type ConnectorContext } from './types';

// ==================== D1 ====================

export function d1Connector(ctx: ConnectorContext): Connector {
  const { account, database } = ctx.def.conn as { account: string; database: string };
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(database)}/query`;
  const exec = async (sql: string, params: unknown[]): Promise<SqlResult> => {
    const res = await call(ctx, url, { method: 'POST', headers: { Authorization: `Bearer ${ctx.secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, params }) }, 'D1');
    if (!res.ok) throw await httpError(res, 'D1');
    const body = (await res.json()) as { success?: boolean; errors?: Array<{ message?: string }>; result?: Array<{ results?: Array<Record<string, unknown>>; meta?: { changes?: number; last_row_id?: unknown } }> };
    if (body.success === false) {
      const msg = body.errors?.map((e) => e.message).join(' ; ') ?? 'erreur';
      throw new ConnectorError(/no such table/i.test(msg) ? 'extdb_not_found' : 'extdb_unreachable', `D1 : ${msg}`);
    }
    const r = body.result?.[0];
    return { rows: r?.results ?? [], changes: r?.meta?.changes ?? 0, lastInsertId: r?.meta?.last_row_id };
  };
  const executor: SqlExecutor = { exec, close: async () => undefined };
  return new SqlConnector(ctx.def, SQLITE, executor);
}

// ==================== PostgreSQL ====================

type PgModule = { Client: new (cfg: Record<string, unknown>) => PgClient; types?: { setTypeParser(oid: number, fn: (v: string) => unknown): void } };
interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  end(): Promise<void>;
}

function tlsOf(def: ExtSourceDef, host: string): false | Record<string, unknown> {
  const tls = (def.conn.tls as string | undefined) ?? 'verify-full';
  if (tls === 'off-local') return false;
  if (tls === 'require') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true, servername: host };
}

function translate(err: unknown, what: string): ConnectorError {
  if (err instanceof ConnectorError) return err;
  const e = err as { code?: string; message?: string };
  const msg = e?.message ?? String(err);
  if (e?.code === '28P01' || e?.code === '28000' || e?.code === 'ER_ACCESS_DENIED_ERROR' || /password authentication failed|access denied/i.test(msg)) {
    return new ConnectorError('extdb_key_refused', `${what} a refusé la clé`);
  }
  if (e?.code === '42P01' || e?.code === 'ER_NO_SUCH_TABLE' || e?.code === '3D000' || e?.code === 'ER_BAD_DB_ERROR') return new ConnectorError('extdb_not_found', `${what} : ${msg}`);
  if (/self.signed|certificate|SSL|TLS|ssl/i.test(msg)) return new ConnectorError('extdb_tls', `${what} : TLS refusé (${msg})`);
  if (/timeout|ETIMEDOUT/i.test(msg)) return new ConnectorError('extdb_timeout', `${what} : délai dépassé`);
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|getaddrinfo/i.test(msg)) return new ConnectorError('extdb_unreachable', `${what} injoignable (${msg})`);
  return new ConnectorError('extdb_unreachable', `${what} : ${msg}`);
}

export async function postgresConnector(ctx: ConnectorContext): Promise<Connector> {
  const c = ctx.def.conn as { host: string; port?: number; db: string; user: string };
  const mod = (await ctx.loadDriver('pg')) as PgModule & { default?: PgModule };
  const pg = (mod.default ?? mod) as PgModule;
  // Une date reste une date (`AAAA-MM-JJ`), jamais un minuit dans le fuseau de la machine
  pg.types?.setTypeParser(1082, (v) => v);
  const client = new pg.Client({
    host: c.host,
    port: c.port ?? 5432,
    database: c.db,
    user: c.user,
    password: ctx.secret,
    ssl: tlsOf(ctx.def, c.host),
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    query_timeout: 30_000,
    application_name: 'filarr-gate',
  });
  try {
    await client.connect();
  } catch (err) {
    throw translate(err, 'PostgreSQL');
  }
  const executor: SqlExecutor = {
    exec: async (sql, params) => {
      try {
        const res = await client.query(sql, params);
        return { rows: res.rows, changes: res.rowCount ?? 0 };
      } catch (err) {
        throw translate(err, 'PostgreSQL');
      }
    },
    begin: async (readOnly) => {
      await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN', []);
    },
    commit: async () => {
      await client.query('COMMIT', []);
    },
    rollback: async () => {
      await client.query('ROLLBACK', []);
    },
    close: () => client.end().catch(() => undefined),
  };
  return new SqlConnector(ctx.def, POSTGRES, executor);
}

// ==================== MySQL, MariaDB ====================

interface MysqlConn {
  execute(sql: string, params: unknown[]): Promise<[unknown, unknown]>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}
type MysqlModule = { createConnection(cfg: Record<string, unknown>): Promise<MysqlConn> };

export async function mysqlConnector(ctx: ConnectorContext): Promise<Connector> {
  const c = ctx.def.conn as { host: string; port?: number; db: string; user: string };
  const mod = (await ctx.loadDriver('mysql2/promise')) as MysqlModule & { default?: MysqlModule };
  const mysql = (mod.default ?? mod) as MysqlModule;
  const tls = tlsOf(ctx.def, c.host);
  let conn: MysqlConn;
  try {
    conn = await mysql.createConnection({
      host: c.host,
      port: c.port ?? 3306,
      database: c.db,
      user: c.user,
      password: ctx.secret,
      ...(tls ? { ssl: tls } : {}),
      connectTimeout: 10_000,
      dateStrings: ['DATE'],
      supportBigNumbers: true,
      bigNumberStrings: true,
      // Une ligne trouvée compte comme touchée, même si la valeur ne change pas : l'écriture sous condition s'en sert
      flags: ['FOUND_ROWS'],
    });
  } catch (err) {
    throw translate(err, 'MySQL');
  }
  const executor: SqlExecutor = {
    exec: async (sql, params) => {
      try {
        const [res] = await conn.execute(sql, params);
        if (Array.isArray(res)) return { rows: res as Array<Record<string, unknown>>, changes: 0 };
        const r = res as { affectedRows?: number; insertId?: unknown };
        return { rows: [], changes: r.affectedRows ?? 0, ...(r.insertId ? { lastInsertId: r.insertId } : {}) };
      } catch (err) {
        throw translate(err, 'MySQL');
      }
    },
    begin: async (readOnly) => {
      await conn.query(readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION');
    },
    commit: async () => {
      await conn.query('COMMIT');
    },
    rollback: async () => {
      await conn.query('ROLLBACK');
    },
    close: () => conn.end().catch(() => undefined),
  };
  return new SqlConnector(ctx.def, MYSQL, executor);
}
