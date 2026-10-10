/**
 * Un CSV ou un JSON publié (`url`, https, `GET`) — contrat `source-externe-1` §
 * 1, § 2.1 : lecture entière, aucun repère, aucune écriture (`once`, `mirror`).
 * Le CSV suit la RFC 4180 (guillemets, séparateur réglable, en-tête) ; le JSON
 * prend la liste désignée par un chemin simple (`$.items`, `$.data.rows`).
 */

import type { SourceOp, SourceRow } from '../../../../core/src/engine/extsrc';
import { call, ConnectorError, httpError, type Connector, type ConnectorContext, type SourceWriteResult } from './types';

/** Un CSV en lignes (RFC 4180 : guillemets doublés, retours à la ligne dans un champ). */
export function parseCsv(text: string, sep = ','): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i]!;
    if (quoted) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) out.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) out.push(row);
  return out;
}

function pick(value: unknown, path: string): unknown {
  const parts = path.replace(/^\$\.?/, '').split('.').filter(Boolean);
  let v = value;
  for (const p of parts) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[p] : undefined;
  return v;
}

export function urlConnector(ctx: ConnectorContext): Connector {
  const c = ctx.def.conn as { url: string; format: { kind: 'csv' | 'json'; sep?: string; header?: boolean; items?: string } };
  const readAll = async (): Promise<SourceRow[]> => {
    const res = await call(ctx, c.url, { headers: ctx.secret ? { Authorization: `Bearer ${ctx.secret}` } : {} }, 'Adresse');
    if (!res.ok) throw await httpError(res, 'Adresse');
    const text = await res.text();
    if (text.length > 20 * 1024 * 1024) throw new ConnectorError('extdb_too_large', 'fichier publié de plus de 20 Mio');
    if (c.format.kind === 'json') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ConnectorError('extdb_schema_changed', 'le JSON publié est illisible');
      }
      const items = c.format.items ? pick(parsed, c.format.items) : parsed;
      if (!Array.isArray(items)) throw new ConnectorError('extdb_schema_changed', `aucune liste à ${c.format.items ?? '$'}`);
      return items.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').map((raw) => ({ raw }));
    }
    const lines = parseCsv(text, c.format.sep ?? ',');
    if (lines.length === 0) return [];
    const header = c.format.header === false ? lines[0]!.map((_, i) => `c${i + 1}`) : lines[0]!;
    const body = c.format.header === false ? lines : lines.slice(1);
    return body.map((line) => ({ raw: Object.fromEntries(header.map((h, i) => [h, line[i] === undefined || line[i] === '' ? null : line[i]])) }));
  };
  return {
    caps: { cas: false },
    readAll,
    readSince: () => readAll(),
    async readKeys(): Promise<SourceRow[]> {
      return readAll();
    },
    async write(_ops: readonly SourceOp[]): Promise<SourceWriteResult> {
      throw new ConnectorError('extdb_not_found', 'un fichier publié ne s’écrit pas (once, mirror seulement)');
    },
    async close() {
      /* rien */
    },
  };
}
