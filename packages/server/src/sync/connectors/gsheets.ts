/**
 * Google Sheets (`sheets.googleapis.com`, compte de service) — contrat
 * `source-externe-1` § 1, § 6.6, § 7.1.
 *
 * - l'assertion JWT (RS256) est signée DANS la boîte ; seule l'assertion part
 *   vers `oauth2.googleapis.com`, jamais la clé privée ;
 * - lecture entière de l'onglet (aucun repère), ligne d'en-tête réglable ;
 * - la clé d'une ligne est tirée par l'exécutant (`key.gen = "runner"`,
 *   obligatoire) : une ligne se RETROUVE par sa clé au moment de l'écrire ou de
 *   l'effacer, jamais par un numéro de ligne gardé ;
 * - sans écriture sous condition : relecture juste avant l'écriture.
 */

import { canonicalJson } from '../../../../core/src/engine/store/canonical';
import { canonicalKey, type SourceOp, type SourceRow } from '../../../../core/src/engine/extsrc';
import { call, ConnectorError, httpError, type Connector, type ConnectorContext, type SourceWriteResult } from './types';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_HOST = 'oauth2.googleapis.com';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const b64url = (bytes: Uint8Array | string): string => {
  const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** L'assertion signée d'un compte de service (RS256, WebCrypto). */
export async function serviceAccountAssertion(sa: ServiceAccount, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: sa.token_uri ?? `https://${TOKEN_HOST}/token`, iat: nowS, exp: nowS + 3600 })
  );
  const der = pemToDer(sa.private_key);
  const key = await crypto.subtle.importKey('pkcs8', der as unknown as ArrayBuffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`)));
  return `${header}.${claims}.${b64url(sig)}`;
}

/** `A1`, `B7`, `AA3` : la cellule d'une colonne (0…) et d'une ligne (1…). */
export function a1(col: number, row: number): string {
  let s = '';
  let n = col + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return `${s}${row}`;
}

export function gsheetsConnector(ctx: ConnectorContext): Connector {
  const def = ctx.def;
  const c = def.conn as { spreadsheet: string; tab: string; headerRow?: number };
  const headerRow = c.headerRow ?? 1;
  const keyCols = def.key.cols;
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(ctx.secret) as ServiceAccount;
  } catch {
    throw new ConnectorError('extdb_key_refused', 'Google Sheets : la clé n’est pas le JSON d’un compte de service');
  }
  // La clé n'est posée QUE vers l'hôte du jeton de Google (§ 7.1)
  const tokenUri = sa.token_uri ?? `https://${TOKEN_HOST}/token`;
  if (new URL(tokenUri).hostname !== TOKEN_HOST) throw new ConnectorError('extdb_key_refused', 'Google Sheets : token_uri hors de oauth2.googleapis.com');
  let token: { value: string; until: number } | null = null;
  const bearer = async (): Promise<Record<string, string>> => {
    if (!token || token.until < Date.now() + 60_000) {
      const assertion = await serviceAccountAssertion(sa);
      const res = await call(ctx, tokenUri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}` }, 'Google');
      if (!res.ok) throw await httpError(res, 'Google');
      const body = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!body.access_token) throw new ConnectorError('extdb_key_refused', 'Google : aucun jeton rendu');
      token = { value: body.access_token, until: Date.now() + (body.expires_in ?? 3600) * 1000 };
    }
    return { Authorization: `Bearer ${token.value}` };
  };
  const tab = encodeURIComponent(c.tab);

  /** L'onglet entier : l'en-tête, et chaque ligne avec son numéro (1…). */
  const readTab = async (): Promise<{ header: string[]; rows: Array<{ n: number; raw: Record<string, unknown> }> }> => {
    const res = await call(ctx, `${SHEETS}/${encodeURIComponent(c.spreadsheet)}/values/${tab}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`, { headers: await bearer() }, 'Google Sheets');
    if (!res.ok) throw await httpError(res, 'Google Sheets');
    const values = ((await res.json()) as { values?: unknown[][] }).values ?? [];
    const header = (values[headerRow - 1] ?? []).map((h) => String(h));
    const rows: Array<{ n: number; raw: Record<string, unknown> }> = [];
    for (let i = headerRow; i < values.length; i += 1) {
      const line = values[i] ?? [];
      if (line.every((v) => v === '' || v === null || v === undefined)) continue;
      rows.push({ n: i + 1, raw: Object.fromEntries(header.map((h, j) => [h, line[j] === undefined || line[j] === '' ? null : line[j]])) });
    }
    return { header, rows };
  };
  const keyOf = (raw: Record<string, unknown>): string | null => {
    try {
      return canonicalKey(keyCols.map((col) => raw[col]));
    } catch {
      return null;
    }
  };

  return {
    caps: { cas: false },
    async readAll(): Promise<SourceRow[]> {
      return (await readTab()).rows.map((r) => ({ raw: r.raw }));
    },
    async readSince(): Promise<SourceRow[]> {
      return this.readAll();
    },
    async readKeys(keys): Promise<SourceRow[]> {
      const wanted = new Set(keys.map((k) => keyOf(k)));
      return (await readTab()).rows.filter((r) => wanted.has(keyOf(r.raw))).map((r) => ({ raw: r.raw }));
    },
    async write(ops: readonly SourceOp[]): Promise<SourceWriteResult> {
      const result: SourceWriteResult = { failed: [], reread: new Map(), inserted: [] };
      const { header, rows } = await readTab();
      const byKey = new Map(rows.map((r) => [keyOf(r.raw), r] as const));
      const data: Array<{ range: string; values: unknown[][] }> = [];
      for (const op of ops) {
        if (op.kind !== 'update') continue;
        const r = byKey.get(op.key);
        const j = header.indexOf(op.col);
        if (!r || j < 0 || canonicalJson(r.raw[op.col] ?? null) !== canonicalJson(op.old ?? null)) {
          result.failed.push({ key: op.key, col: op.col });
          continue;
        }
        data.push({ range: `${c.tab}!${a1(j, r.n)}`, values: [[op.value ?? '']] });
        r.raw[op.col] = op.value;
        result.reread.set(op.key, r.raw);
      }
      if (data.length > 0) {
        const res = await call(ctx, `${SHEETS}/${encodeURIComponent(c.spreadsheet)}/values:batchUpdate`, { method: 'POST', headers: { ...(await bearer()), 'Content-Type': 'application/json' }, body: JSON.stringify({ valueInputOption: 'RAW', data }) }, 'Google Sheets');
        if (!res.ok) throw await httpError(res, 'Google Sheets');
        await res.arrayBuffer().catch(() => undefined);
      }
      const inserts = ops.filter((o): o is Extract<SourceOp, { kind: 'insert' }> => o.kind === 'insert');
      if (inserts.length > 0) {
        const lines = inserts.map((op) => {
          const values = { ...op.values, [keyCols[0]!]: op.rowId };
          return header.map((h) => (values[h] === undefined || values[h] === null ? '' : values[h]));
        });
        const res = await call(ctx, `${SHEETS}/${encodeURIComponent(c.spreadsheet)}/values/${tab}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', headers: { ...(await bearer()), 'Content-Type': 'application/json' }, body: JSON.stringify({ values: lines }) }, 'Google Sheets');
        if (!res.ok) throw await httpError(res, 'Google Sheets');
        await res.arrayBuffer().catch(() => undefined);
        for (const op of inserts) result.inserted.push({ rowId: op.rowId, keyValues: { [keyCols[0]!]: op.rowId } });
      }
      const deletes = ops.filter((o): o is Extract<SourceOp, { kind: 'delete' }> => o.kind === 'delete');
      const numbers = deletes.map((d) => byKey.get(d.key)?.n).filter((n): n is number => n !== undefined).sort((a, b) => b - a);
      if (numbers.length > 0) {
        const meta = await call(ctx, `${SHEETS}/${encodeURIComponent(c.spreadsheet)}?fields=sheets.properties`, { headers: await bearer() }, 'Google Sheets');
        if (!meta.ok) throw await httpError(meta, 'Google Sheets');
        const sheets = ((await meta.json()) as { sheets?: Array<{ properties?: { sheetId?: number; title?: string } }> }).sheets ?? [];
        const sheetId = sheets.find((s) => s.properties?.title === c.tab)?.properties?.sheetId;
        if (sheetId === undefined) throw new ConnectorError('extdb_not_found', `Google Sheets : onglet « ${c.tab} » introuvable`);
        // Du bas vers le haut : un effacement ne décale pas les lignes qui restent à effacer
        const requests = numbers.map((n) => ({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: n - 1, endIndex: n } } }));
        const res = await call(ctx, `${SHEETS}/${encodeURIComponent(c.spreadsheet)}:batchUpdate`, { method: 'POST', headers: { ...(await bearer()), 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }) }, 'Google Sheets');
        if (!res.ok) throw await httpError(res, 'Google Sheets');
        await res.arrayBuffer().catch(() => undefined);
      }
      return result;
    },
    async close() {
      /* rien */
    },
  };
}
