// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/sql/catalog.ts @ 3e9d65cd — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Les bases Filarr, vues comme des TABLES SQL — exactement celles du script de
 * la vue Merise (`merise/sql.ts`, dialecte SQLite) : mêmes noms de tables et de
 * colonnes (le MLD), mêmes valeurs, mêmes affinités. Une requête rend donc dans
 * Filarr ce qu'elle rendrait sur le fichier SQLite exporté — c'est ce que le
 * test confronte, valeur par valeur, à `node:sqlite`.
 */

import type { DbProperty, DbRow } from '../../types';
import { relationIds } from '../../dbCore';
import { peopleOf } from '../../people';
import type { InlineDbIndexEntry } from '../../dbIndex';
import { buildMcd } from '../../merise/mcd';
import { buildMld, type MldColumn, type MldTable } from '../../merise/mld';
import { catalogOf, type SqlCatalog, type SqlTable } from './run';
import { storeAs, type Affinity, type SqlValue } from './values';

/** L'affinité de la colonne, d'après le type que le script SQLite déclare. */
function affinityOf(column: MldColumn): Affinity {
  if (column.kind !== 'attr') return 'TEXT';
  switch (column.type) {
    case 'number':
    case 'progress':
      return 'REAL';
    case 'rating':
    case 'checkbox':
      return 'INTEGER';
    default:
      return 'TEXT';
  }
}

/** La valeur d'une cellule, telle que le script SQLite l'insère (avant affinité). */
function cellValue(prop: DbProperty | undefined, row: DbRow, column: MldColumn): SqlValue {
  if (!prop) return null;
  const raw =
    prop.type === 'createdTime'
      ? row.createdAt
      : prop.type === 'updatedTime'
        ? row.updatedAt
        : row.cells[prop.id];
  if (raw === undefined || raw === null || raw === '') return prop.type === 'checkbox' ? 0n : null;
  switch (column.type) {
    case 'number':
    case 'progress':
    case 'rating':
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
      // Le script écrit `String(nombre)` : un entier sans point est lu comme
      // INTEGER (−0 s'écrit « 0 », donc un zéro positif)
      return Number.isInteger(raw) && /^-?\d+$/.test(String(raw)) ? BigInt(raw) : raw;
    case 'checkbox':
      return raw === true ? 1n : 0n;
    case 'date':
    case 'createdTime':
    case 'updatedTime':
      return typeof raw === 'string' ? raw : null;
    case 'select': {
      const label = prop.options?.find((o) => o.id === raw)?.label;
      return label === undefined ? null : label;
    }
    case 'multiSelect': {
      const ids = Array.isArray(raw) ? raw : [];
      const labels = ids
        .map((id) => prop.options?.find((o) => o.id === id)?.label)
        .filter((l): l is string => l !== undefined);
      return labels.length === 0 ? null : labels.join(', ');
    }
    case 'person': {
      const names = peopleOf(raw);
      return names.length === 0 ? null : names.join(', ');
    }
    default:
      return typeof raw === 'string'
        ? raw
        : typeof raw === 'number' || typeof raw === 'boolean'
          ? String(raw)
          : JSON.stringify(raw);
  }
}

/**
 * Le catalogue SQL de bases indexées (une table par base, plus les jointures).
 * `tables` : le modèle logique déjà construit par l'appelant, pour que les noms
 * de tables qu'il affiche soient ceux que le SQL connaît.
 */
export function catalogFromDatabases(
  entries: readonly InlineDbIndexEntry[],
  tables: readonly MldTable[] = buildMld(buildMcd(entries))
): SqlCatalog {
  const props = new Map<string, DbProperty>();
  const byDb = new Map<string, InlineDbIndexEntry>();
  for (const entry of entries) {
    byDb.set(entry.dbId, entry);
    for (const p of entry.properties) props.set(p.id, p);
  }
  const out: SqlTable[] = [];
  for (const t of tables) {
    const columns = t.columns.map((c) => ({ name: c.name, affinity: affinityOf(c) }));
    const rows: SqlValue[][] = [];
    if (t.entity) {
      const db = byDb.get(t.entity);
      for (const row of db?.rows ?? []) {
        rows.push(
          t.columns.map((c, i) => {
            if (c.kind === 'pk') return row.id;
            const prop = c.propertyId ? props.get(c.propertyId) : undefined;
            if (c.kind === 'fk') {
              const first = prop ? relationIds(row.cells[prop.id])[0] : undefined;
              return first === undefined ? null : first;
            }
            return storeAs(cellValue(prop, row, c), columns[i]!.affinity);
          })
        );
      }
    } else {
      // Table de jointure : les liens lus du côté qui les STOCKE
      const [first] = t.columns;
      const viaProp = first?.propertyId ? props.get(first.propertyId) : undefined;
      const owner = viaProp
        ? entries.find((db) => db.properties.some((p) => p.id === viaProp.id))
        : undefined;
      if (viaProp && owner) {
        for (const row of owner.rows) {
          for (const linked of relationIds(row.cells[viaProp.id])) rows.push([row.id, linked]);
        }
      }
    }
    out.push({ name: t.name, columns, rows });
  }
  return catalogOf(out);
}
