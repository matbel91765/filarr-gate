/**
 * Airtable (`api.airtable.com/v0`) — contrat `source-externe-1` § 1, § 6.6.
 *
 * - pages de 100 (`offset`) ; repère : un champ de date (souvent « Dernière
 *   modification », `LAST_MODIFIED_TIME()`), filtré par `filterByFormula` ;
 * - la colonne `id` désigne l'identifiant d'enregistrement (`rec…`) : c'est la
 *   clé naturelle quand `key.gen = "source"` ;
 * - SANS écriture sous condition : chaque enregistrement est RELU juste avant
 *   d'être écrit, et l'écriture est abandonnée s'il a changé. Une fenêtre de
 *   course subsiste entre la relecture et l'écriture (moins d'une seconde) ;
 * - 10 enregistrements par appel, 5 requêtes par seconde et par base.
 */

import { canonicalJson } from '../../../../core/src/engine/store/canonical';
import { canonicalKey, type SourceOp, type SourceRow } from '../../../../core/src/engine/extsrc';
import { call, columnsOf, ConnectorError, httpError, markerParam, pacer, unsupportedColumn, type Connector, type ConnectorContext, type SourceWriteResult } from './types';

interface AirRecord {
  id: string;
  createdTime?: string;
  fields: Record<string, unknown>;
}

/** Des enregistrements liés (un champ « Lien vers un autre enregistrement ») : une liste d'identifiants `rec…`. */
export const isLinkedRecords = (v: unknown): boolean => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && /^rec[A-Za-z0-9]{14}$/.test(x));

const formulaString = (v: unknown): string => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function airtableConnector(ctx: ConnectorContext): Connector {
  const def = ctx.def;
  const c = def.conn as { base: string; table: string; view?: string };
  const root = `https://api.airtable.com/v0/${encodeURIComponent(c.base)}/${encodeURIComponent(c.table)}`;
  const auth = { Authorization: `Bearer ${ctx.secret}` };
  const pace = pacer(ctx, 210);
  const cols = columnsOf(def).filter((col) => col !== 'id');
  const keyCols = def.key.cols;
  // Précision P3 : un champ d'enregistrements liés associé est refusé (identifiants `rec…`, jamais en texte).
  // Airtable ne donne pas le type des champs à la lecture (le schéma demande une autre portée de la
  // clé) : il se reconnaît à sa valeur, une liste d'identifiants d'enregistrements.
  const toRaw = (r: AirRecord): Record<string, unknown> => {
    for (const col of cols) if (isLinkedRecords(r.fields[col])) throw unsupportedColumn('Airtable', col);
    return { ...r.fields, id: r.id };
  };

  const list = async (formula: string | null): Promise<AirRecord[]> => {
    const out: AirRecord[] = [];
    let offset: string | undefined;
    do {
      const p = new URLSearchParams({ pageSize: '100' });
      for (const col of cols) p.append('fields[]', col);
      if (c.view) p.set('view', c.view);
      if (formula) p.set('filterByFormula', formula);
      if (offset) p.set('offset', offset);
      await pace();
      const res = await call(ctx, `${root}?${p.toString()}`, { headers: auth }, 'Airtable');
      if (!res.ok) throw await httpError(res, 'Airtable');
      const body = (await res.json()) as { records?: AirRecord[]; offset?: string };
      out.push(...(body.records ?? []));
      offset = body.offset;
      if (out.length > 200_000) throw new ConnectorError('extdb_too_large', 'plus de 200 000 lignes lues');
    } while (offset);
    return out;
  };
  const keyFormula = (keys: ReadonlyArray<Record<string, unknown>>): string =>
    `OR(${keys
      .map((k) => `AND(${keyCols.map((col) => (col === 'id' ? `RECORD_ID()=${formulaString(k[col])}` : `{${col}}=${formulaString(k[col])}`)).join(',')})`)
      .join(',')})`;
  const byKey = async (keys: ReadonlyArray<Record<string, unknown>>): Promise<AirRecord[]> => {
    const out: AirRecord[] = [];
    for (let i = 0; i < keys.length; i += 20) out.push(...(await list(keyFormula(keys.slice(i, i + 20)))));
    return out;
  };
  const send = async (method: string, body: unknown): Promise<AirRecord[]> => {
    await pace();
    const res = await call(ctx, root, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'Airtable');
    if (!res.ok) throw await httpError(res, 'Airtable');
    return ((await res.json()) as { records?: AirRecord[] }).records ?? [];
  };

  return {
    caps: { cas: false },
    async readAll(): Promise<SourceRow[]> {
      return (await list(null)).map((r) => ({ raw: toRaw(r) }));
    },
    async readSince(marker): Promise<SourceRow[]> {
      if (!def.marker) return this.readAll();
      const iso = formulaString(markerParam(def, marker));
      return (await list(`OR(IS_AFTER({${def.marker.col}},${iso}),IS_SAME({${def.marker.col}},${iso}))`)).map((r) => ({ raw: toRaw(r) }));
    },
    async readKeys(keys): Promise<SourceRow[]> {
      return (await byKey(keys)).map((r) => ({ raw: toRaw(r) }));
    },
    async write(ops: readonly SourceOp[]): Promise<SourceWriteResult> {
      const result: SourceWriteResult = { failed: [], reread: new Map(), inserted: [] };
      // Relire juste avant d'écrire : ce qui a changé depuis la lecture est laissé (cas B ou E au passage suivant)
      const updates = ops.filter((o): o is Extract<SourceOp, { kind: 'update' }> => o.kind === 'update');
      const current = new Map<string, AirRecord>();
      for (const r of await byKey(updates.map((u) => u.keyValues))) {
        const k = canonicalKey(keyCols.map((col) => toRaw(r)[col]));
        if (k !== null) current.set(k, r);
      }
      const patches = new Map<string, { id: string; fields: Record<string, unknown> }>();
      for (const u of updates) {
        const rec = current.get(u.key);
        if (!rec || canonicalJson(toRaw(rec)[u.col] ?? null) !== canonicalJson(u.old ?? null)) {
          result.failed.push({ key: u.key, col: u.col });
          continue;
        }
        const p = patches.get(u.key) ?? { id: rec.id, fields: {} };
        p.fields[u.col] = u.value;
        patches.set(u.key, p);
      }
      const list10 = [...patches.values()];
      for (let i = 0; i < list10.length; i += 10) {
        for (const r of await send('PATCH', { records: list10.slice(i, i + 10) })) {
          const k = canonicalKey(keyCols.map((col) => toRaw(r)[col]));
          if (k !== null) result.reread.set(k, toRaw(r));
        }
      }
      const inserts = ops.filter((o): o is Extract<SourceOp, { kind: 'insert' }> => o.kind === 'insert');
      for (let i = 0; i < inserts.length; i += 10) {
        const batch = inserts.slice(i, i + 10);
        const records = batch.map((op) => {
          const fields = { ...op.values };
          delete fields.id;
          if (def.key.gen === 'runner') fields[keyCols[0]!] = op.rowId;
          return { fields };
        });
        const created = await send('POST', { records });
        batch.forEach((op, j) => {
          const r = created[j];
          result.inserted.push({ rowId: op.rowId, keyValues: r ? Object.fromEntries(keyCols.map((col) => [col, toRaw(r)[col]])) : null });
        });
      }
      const deletes = ops.filter((o): o is Extract<SourceOp, { kind: 'delete' }> => o.kind === 'delete');
      const ids: string[] = [];
      for (const r of await byKey(deletes.map((d) => d.keyValues))) ids.push(r.id);
      for (let i = 0; i < ids.length; i += 10) {
        const p = new URLSearchParams();
        for (const id of ids.slice(i, i + 10)) p.append('records[]', id);
        await pace();
        const res = await call(ctx, `${root}?${p.toString()}`, { method: 'DELETE', headers: auth }, 'Airtable');
        if (!res.ok) throw await httpError(res, 'Airtable');
        await res.arrayBuffer().catch(() => undefined);
      }
      return result;
    },
    async close() {
      /* rien */
    },
  };
}
