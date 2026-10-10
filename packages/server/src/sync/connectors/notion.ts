/**
 * Notion (`api.notion.com`) — contrat `source-externe-1` § 1, § 6.6.
 *
 * - version de l'API FIGÉE (`Notion-Version: 2022-06-28`) ;
 * - pages de 100 (`start_cursor`) ; repère : `last_edited_time` de la page ;
 * - la colonne `id` est l'identifiant de la page (clé naturelle) ; les autres
 *   colonnes sont les propriétés de la base, par leur nom, ramenées à des valeurs
 *   simples (titre et texte riche en texte brut, sélections par leur nom, dates
 *   par leur début) ;
 * - sans écriture sous condition : la page est relue juste avant d'être écrite ;
 *   supprimer = mettre à la corbeille ; 3 requêtes par seconde.
 */

import { canonicalJson } from '../../../../core/src/engine/store/canonical';
import { canonicalKey, type SourceOp, type SourceRow } from '../../../../core/src/engine/extsrc';
import { call, columnsOf, ConnectorError, httpError, markerParam, pacer, unsupportedColumn, type Connector, type ConnectorContext, type SourceWriteResult } from './types';

export const NOTION_VERSION = '2022-06-28';
const ROOT = 'https://api.notion.com/v1';

interface NotionPage {
  id: string;
  last_edited_time?: string;
  created_time?: string;
  archived?: boolean;
  properties: Record<string, Record<string, unknown> & { type: string }>;
}

const plain = (rich: unknown): string | null => {
  if (!Array.isArray(rich)) return null;
  const s = rich.map((r) => String((r as { plain_text?: string }).plain_text ?? (r as { text?: { content?: string } }).text?.content ?? '')).join('');
  return s === '' ? null : s;
};

/** La valeur simple d'une propriété de page. */
export function notionValue(p: Record<string, unknown> & { type: string }): unknown {
  const v = p[p.type] as unknown;
  switch (p.type) {
    case 'title':
    case 'rich_text':
      return plain(v);
    case 'number':
    case 'checkbox':
    case 'url':
    case 'email':
    case 'phone_number':
    case 'created_time':
    case 'last_edited_time':
      return v ?? null;
    case 'select':
    case 'status':
      return (v as { name?: string } | null)?.name ?? null;
    case 'multi_select':
      return Array.isArray(v) ? v.map((x) => (x as { name: string }).name) : [];
    case 'date':
      return (v as { start?: string } | null)?.start ?? null;
    case 'people':
      return Array.isArray(v) ? v.map((x) => (x as { name?: string; id: string }).name ?? (x as { id: string }).id) : [];
    case 'relation':
      return Array.isArray(v) ? v.map((x) => (x as { id: string }).id) : [];
    case 'files':
      return Array.isArray(v) ? v.map((x) => (x as { name?: string }).name ?? '').join(', ') : null;
    case 'formula': {
      const f = v as { type?: string } & Record<string, unknown>;
      return f?.type ? (f[f.type] ?? null) : null;
    }
    case 'unique_id': {
      const u = v as { prefix?: string | null; number?: number } | null;
      return u ? `${u.prefix ? `${u.prefix}-` : ''}${u.number}` : null;
    }
    default:
      return v ?? null;
  }
}

/** Une valeur simple dans la forme d'écriture de Notion, selon le type de la propriété. */
export function notionInput(type: string, value: unknown): unknown {
  switch (type) {
    case 'title':
    case 'rich_text':
      return value === null || value === undefined || value === '' ? [] : [{ type: 'text', text: { content: String(value) } }];
    case 'number':
      return typeof value === 'number' ? value : value === null ? null : Number(value);
    case 'checkbox':
      return value === true;
    case 'select':
    case 'status':
      return value === null || value === undefined || value === '' ? null : { name: String(value) };
    case 'multi_select':
      return (Array.isArray(value) ? value : []).map((name) => ({ name: String(name) }));
    case 'date':
      return value === null || value === undefined || value === '' ? null : { start: String(value) };
    case 'url':
    case 'email':
    case 'phone_number':
      return value === '' ? null : (value ?? null);
    default:
      throw new ConnectorError('extdb_schema_changed', `Notion : la propriété de type ${type} ne s’écrit pas`);
  }
}

export function notionConnector(ctx: ConnectorContext): Connector {
  const def = ctx.def;
  const db = String((def.conn as { database: string }).database);
  const headers = { Authorization: `Bearer ${ctx.secret}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' };
  const pace = pacer(ctx, 350);
  const keyCols = def.key.cols;
  let types: Record<string, string> | null = null;
  // Précision P3 : une propriété `relation` associée est refusée (identifiants de pages, jamais en texte)
  const mapped = new Set(columnsOf(def));
  const toRaw = (p: NotionPage): Record<string, unknown> => {
    const raw: Record<string, unknown> = { id: p.id, last_edited_time: p.last_edited_time ?? null, created_time: p.created_time ?? null };
    for (const [name, prop] of Object.entries(p.properties ?? {})) {
      if (prop.type === 'relation' && mapped.has(name)) throw unsupportedColumn('Notion', name);
      raw[name] = notionValue(prop);
    }
    return raw;
  };
  const req = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    await pace();
    const res = await call(ctx, `${ROOT}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, 'Notion');
    if (!res.ok) throw await httpError(res, 'Notion');
    return res.json();
  };
  const query = async (filter: unknown): Promise<NotionPage[]> => {
    const out: NotionPage[] = [];
    let cursor: string | undefined;
    do {
      const body = (await req('POST', `/databases/${encodeURIComponent(db)}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}), ...(filter ? { filter } : {}) })) as { results?: NotionPage[]; next_cursor?: string | null; has_more?: boolean };
      out.push(...(body.results ?? []));
      cursor = body.has_more && body.next_cursor ? body.next_cursor : undefined;
      if (out.length > 200_000) throw new ConnectorError('extdb_too_large', 'plus de 200 000 lignes lues');
    } while (cursor);
    return out;
  };
  const propTypes = async (): Promise<Record<string, string>> => {
    if (!types) {
      const body = (await req('GET', `/databases/${encodeURIComponent(db)}`)) as { properties?: Record<string, { type: string }> };
      types = Object.fromEntries(Object.entries(body.properties ?? {}).map(([k, v]) => [k, v.type]));
    }
    return types;
  };
  const pagesByKey = async (keys: ReadonlyArray<Record<string, unknown>>): Promise<NotionPage[]> => {
    if (keyCols.length === 1 && keyCols[0] === 'id') {
      const out: NotionPage[] = [];
      for (const k of keys) {
        try {
          const p = (await req('GET', `/pages/${encodeURIComponent(String(k.id))}`)) as NotionPage;
          if (!p.archived) out.push(p);
        } catch (err) {
          if (!(err instanceof ConnectorError && err.code === 'extdb_not_found')) throw err;
        }
      }
      return out;
    }
    const wanted = new Set(keys.map((k) => canonicalKey(keyCols.map((c) => k[c]))));
    return (await query(null)).filter((p) => wanted.has(canonicalKey(keyCols.map((c) => toRaw(p)[c]))));
  };

  return {
    caps: { cas: false },
    async readAll(): Promise<SourceRow[]> {
      return (await query(null)).map((p) => ({ raw: toRaw(p) }));
    },
    async readSince(marker): Promise<SourceRow[]> {
      const iso = String(markerParam({ ...def, marker: def.marker ?? { col: 'last_edited_time', kind: 'iso' } }, marker));
      return (await query({ timestamp: 'last_edited_time', last_edited_time: { on_or_after: iso } })).map((p) => ({ raw: toRaw(p) }));
    },
    async readKeys(keys): Promise<SourceRow[]> {
      return (await pagesByKey(keys)).map((p) => ({ raw: toRaw(p) }));
    },
    async write(ops: readonly SourceOp[]): Promise<SourceWriteResult> {
      const result: SourceWriteResult = { failed: [], reread: new Map(), inserted: [] };
      const t = await propTypes();
      const updates = ops.filter((o): o is Extract<SourceOp, { kind: 'update' }> => o.kind === 'update');
      const current = new Map<string, NotionPage>();
      for (const p of await pagesByKey(updates.map((u) => u.keyValues))) {
        const k = canonicalKey(keyCols.map((c) => toRaw(p)[c]));
        if (k !== null) current.set(k, p);
      }
      const props = new Map<string, { id: string; properties: Record<string, unknown> }>();
      for (const u of updates) {
        const page = current.get(u.key);
        const type = t[u.col];
        if (!page || !type || canonicalJson(toRaw(page)[u.col] ?? null) !== canonicalJson(u.old ?? null)) {
          result.failed.push({ key: u.key, col: u.col });
          continue;
        }
        const entry = props.get(u.key) ?? { id: page.id, properties: {} };
        entry.properties[u.col] = { [type]: notionInput(type, u.value) };
        props.set(u.key, entry);
      }
      for (const [key, e] of props) {
        const page = (await req('PATCH', `/pages/${encodeURIComponent(e.id)}`, { properties: e.properties })) as NotionPage;
        result.reread.set(key, toRaw(page));
      }
      for (const op of ops) {
        if (op.kind === 'insert') {
          const properties: Record<string, unknown> = {};
          const values = { ...op.values };
          delete values.id;
          if (def.key.gen === 'runner') values[keyCols[0]!] = op.rowId;
          for (const [col, v] of Object.entries(values)) if (t[col]) properties[col] = { [t[col]!]: notionInput(t[col]!, v) };
          const page = (await req('POST', '/pages', { parent: { database_id: db }, properties })) as NotionPage;
          result.inserted.push({ rowId: op.rowId, keyValues: Object.fromEntries(keyCols.map((c) => [c, toRaw(page)[c]])) });
        } else if (op.kind === 'delete') {
          for (const p of await pagesByKey([op.keyValues])) await req('PATCH', `/pages/${encodeURIComponent(p.id)}`, { archived: true });
        }
      }
      return result;
    },
    async close() {
      /* rien */
    },
  };
}
