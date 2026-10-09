// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/view.ts @ 9b0ca853 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Une vue évaluée par le moteur en colonnes : filtres vectorisés, recherche,
 * tri sans comparateur. Point d'entrée : `engineApplyView`, interchangeable avec
 * `viewEngine.applyView` — mêmes lignes, même ordre, mêmes objets (vérifié par
 * le test différentiel sur des bases tirées au hasard).
 *
 * LES FILTRES rendent un MASQUE par clause (`Uint8Array`, 1 = la ligne passe),
 * combinés ensuite par ET / OU. Chaque clause est un NOYAU par (type, opérateur)
 * qui parcourt une colonne typée ; sur un dictionnaire, le prédicat est évalué
 * une fois par VALEUR DISTINCTE, puis lu par ligne.
 *
 * LE TRI ramène chaque niveau à une clé entière par ligne qui porte déjà tout :
 * rang dense de la valeur, sens décroissant (rang retourné) et vides TOUJOURS en
 * dernier (clé maximale). Le noyau (`sortKernels.ts`) n'a plus qu'à trier des
 * entiers, de façon stable.
 */

import type {
  DbFilter,
  DbFilterOp,
  DbProperty,
  DbRow,
  DbSort,
  DbView,
  InlineDbData,
} from '../types';
import type { DbLinkContext } from '../relations';
import { dayStamp, filterFamily, numberOf } from '../cellValues';
import { filterActs, haystackReader, normalizeSearch } from '../viewEngine';
import { chooseSortKernel, sortByLevels, type SortKernel } from './sortKernels';
import type { Column, EngineTable } from './table';
import { tableFor } from './table';

// ==================== Filtres ====================

/** Masque « tout passe », partagé (jamais modifié). */
function fullMask(n: number): Uint8Array {
  return new Uint8Array(n).fill(1);
}

function numericMask(values: Float64Array, op: DbFilterOp, target: number, out: Uint8Array): void {
  const n = values.length;
  // Vide (NaN) : ni égal, ni comparable — seul « ≠ » l'accepte
  switch (op) {
    case 'eq':
      for (let i = 0; i < n; i += 1) out[i] = values[i] === target ? 1 : 0;
      return;
    case 'neq':
      for (let i = 0; i < n; i += 1) out[i] = values[i] !== target ? 1 : 0;
      return;
    case 'gt':
      for (let i = 0; i < n; i += 1) out[i] = values[i] > target ? 1 : 0;
      return;
    case 'lt':
      for (let i = 0; i < n; i += 1) out[i] = values[i] < target ? 1 : 0;
      return;
    case 'gte':
      for (let i = 0; i < n; i += 1) out[i] = values[i] >= target ? 1 : 0;
      return;
    case 'lte':
      for (let i = 0; i < n; i += 1) out[i] = values[i] <= target ? 1 : 0;
      return;
    default:
      // Opérateur inconnu : une valeur présente passe, une vide non (`numberTest`)
      for (let i = 0; i < n; i += 1) out[i] = values[i] === values[i] ? 1 : 0;
  }
}

/**
 * Le masque d'UN filtre, ou `null` quand il N'AGIT PAS (propriété disparue,
 * opérateur hors famille) : il ne compte alors pas parmi les clauses.
 *
 * À NE PAS CONFONDRE avec un filtre qui agit mais laisse tout passer (terme
 * vide) : celui-là EST une clause, et en « OU » il fait passer toutes les
 * lignes — c'est la règle de `viewEngine.applyViewFilters`.
 */
function filterMask(table: EngineTable, filter: DbFilter): Uint8Array | null {
  const prop = table.props.get(filter.propertyId);
  if (!filterActs(prop, filter)) return null;
  const mask = actingMask(table, prop, filter);
  return mask ?? fullMask(table.n);
}

/** Le masque d'un filtre qui agit ; `null` = il laisse tout passer. */
function actingMask(table: EngineTable, prop: DbProperty, filter: DbFilter): Uint8Array | null {
  const n = table.n;
  const out = new Uint8Array(n);

  switch (filter.op) {
    case 'isEmpty':
      out.set(table.empty(prop));
      return out;
    case 'isNotEmpty': {
      const empty = table.empty(prop);
      for (let i = 0; i < n; i += 1) out[i] = empty[i] ? 0 : 1;
      return out;
    }
    case 'isChecked':
    case 'isUnchecked': {
      const col = table.column(prop);
      const checked = filter.op === 'isChecked' ? 1 : 0;
      if (col.kind === 'bool') {
        for (let i = 0; i < n; i += 1) out[i] = col.values[i] === checked ? 1 : 0;
        return out;
      }
      return null;
    }
    default:
      break;
  }

  const col = table.column(prop);
  switch (filterFamily(prop.type)) {
    case 'relation':
    case 'text': {
      const needle = typeof filter.value === 'string' ? filter.value.trim().toLowerCase() : '';
      if (needle === '') return null;
      if (col.kind !== 'text' && col.kind !== 'relation') return null;
      const isRelation = col.kind === 'relation';
      // Le prédicat, une fois par VALEUR DISTINCTE du dictionnaire
      const hit = new Uint8Array(col.dict.length);
      for (let c = isRelation ? 1 : 0; c < col.dict.length; c += 1) {
        const hay = col.dict[c].toLowerCase();
        let match: boolean;
        if (filter.op === 'contains') match = hay.includes(needle);
        else if (filter.op === 'notContains') match = !hay.includes(needle);
        else if (filter.op === 'equals' && !isRelation) match = hay === needle;
        else match = true;
        hit[c] = match ? 1 : 0;
      }
      // Relation : cible inconnue (code 0) → on ne sait rien, le filtre est inerte
      if (isRelation) hit[0] = 1;
      const codes = col.codes;
      for (let i = 0; i < n; i += 1) out[i] = hit[codes[i]];
      return out;
    }
    case 'rollup':
    case 'number': {
      const target = numberOf(filter.value);
      if (target === null) return null;
      if (col.kind !== 'number' && col.kind !== 'rollup') return null;
      numericMask(col.values, filter.op, target, out);
      return out;
    }
    case 'select': {
      const target = typeof filter.value === 'string' ? filter.value : '';
      if (target === '' || col.kind !== 'select') return null;
      // Une cible qui n'est pas une option connue n'est jamais « portée »
      const code = col.codeOf.get(target) ?? -1;
      const is = filter.op === 'is';
      const codes = col.codes;
      for (let i = 0; i < n; i += 1) out[i] = (codes[i] === code) === is ? 1 : 0;
      return out;
    }
    case 'multiSelect': {
      const target = typeof filter.value === 'string' ? filter.value : '';
      if (target === '' || col.kind !== 'multi') return null;
      const code = col.codeOf.get(target) ?? -1;
      const contains = filter.op === 'contains';
      const { offsets, codes } = col;
      for (let i = 0; i < n; i += 1) {
        let found = false;
        if (code !== -1) {
          for (let k = offsets[i]; k < offsets[i + 1]; k += 1) {
            if (codes[k] === code) {
              found = true;
              break;
            }
          }
        }
        out[i] = found === contains ? 1 : 0;
      }
      return out;
    }
    case 'date': {
      const target = dayStamp(filter.value);
      if (target === null) return null;
      if (col.kind !== 'day' && col.kind !== 'time') return null;
      const day = col.day;
      // Une date absente (NaN) n'est ni avant, ni après, ni « le »
      if (filter.op === 'before') for (let i = 0; i < n; i += 1) out[i] = day[i] < target ? 1 : 0;
      else if (filter.op === 'after')
        for (let i = 0; i < n; i += 1) out[i] = day[i] > target ? 1 : 0;
      else if (filter.op === 'on')
        for (let i = 0; i < n; i += 1) out[i] = day[i] === target ? 1 : 0;
      else for (let i = 0; i < n; i += 1) out[i] = day[i] === day[i] ? 1 : 0;
      return out;
    }
    default:
      return null;
  }
}

function andInto(acc: Uint8Array, mask: Uint8Array): void {
  for (let i = 0; i < acc.length; i += 1) acc[i] &= mask[i];
}

function orInto(acc: Uint8Array, mask: Uint8Array): void {
  for (let i = 0; i < acc.length; i += 1) acc[i] |= mask[i];
}

/**
 * Le masque des filtres d'une VUE — même règle que `viewEngine.applyViewFilters` :
 * clauses de premier niveau (filtres seuls + groupes) combinées par
 * `filterMatch`, une clause inerte ne compte pas, un groupe sans clause
 * agissante est inerte, et sans aucune clause agissante tout passe (`null`).
 */
export function viewMask(
  table: EngineTable,
  view: Pick<DbView, 'filters' | 'filterMatch' | 'filterGroups'>
): Uint8Array | null {
  const clauses: Uint8Array[] = [];
  for (const f of view.filters) {
    const mask = filterMask(table, f);
    if (mask) clauses.push(mask);
  }
  for (const g of view.filterGroups ?? []) {
    const masks = g.filters.map((f) => filterMask(table, f)).filter((m): m is Uint8Array => !!m);
    if (masks.length === 0) continue;
    const acc = masks[0].slice();
    for (let k = 1; k < masks.length; k += 1) {
      if (g.match === 'any') orInto(acc, masks[k]);
      else andInto(acc, masks[k]);
    }
    clauses.push(acc);
  }
  if (clauses.length === 0) return null;
  const any = view.filterMatch === 'any';
  const acc = clauses[0].slice();
  for (let k = 1; k < clauses.length; k += 1) {
    if (any) orInto(acc, clauses[k]);
    else andInto(acc, clauses[k]);
  }
  return acc;
}

/** Les lignes retenues, dans l'ordre de la base. */
function selection(table: EngineTable, mask: Uint8Array | null): Uint32Array {
  const n = table.n;
  if (!mask) {
    const all = new Uint32Array(n);
    for (let i = 0; i < n; i += 1) all[i] = i;
    return all;
  }
  let count = 0;
  for (let i = 0; i < n; i += 1) count += mask[i];
  const sel = new Uint32Array(count);
  let k = 0;
  for (let i = 0; i < n; i += 1) if (mask[i]) sel[k++] = i;
  return sel;
}

/** La recherche rapide sur la sélection : le même texte que `viewEngine.applySearch`. */
function searchSelection(table: EngineTable, sel: Uint32Array, search: string): Uint32Array {
  const needle = normalizeSearch(search);
  if (needle === '') return sel;
  const hay = haystackReader(table.properties);
  const kept = new Uint32Array(sel.length);
  let k = 0;
  for (let j = 0; j < sel.length; j += 1) {
    if (hay(table.rows[sel[j]]).includes(needle)) kept[k++] = sel[j];
  }
  return kept.slice(0, k);
}

// ==================== Tri ====================

interface Level {
  keys: Uint32Array;
  maxKey: number;
}

/**
 * Rangs DENSES des valeurs numériques retenues (`NaN` exclu), en ordre croissant.
 * Deux valeurs égales (0 et −0 compris) partagent leur rang.
 */
function numericRanks(
  values: Float64Array,
  sel: Uint32Array
): { rankOf: Map<number, number>; d: number } {
  const distinct = new Set<number>();
  for (let j = 0; j < sel.length; j += 1) {
    const v = values[sel[j]];
    if (v === v) distinct.add(v === 0 ? 0 : v);
  }
  // Hermes (RN 0.81) : `Float64Array.from(itérable)` rend un tableau VIDE, sans
  // erreur — il ne lit que `length` et les index (constaté sur appareil par le
  // mobile, 2026-10-04 : tout tri sur un nombre ou une date sortait dans un autre
  // ordre que `viewEngine`). Jamais `TypedArray.from(Set|Map|itérateur)` dans le
  // code partagé : on remplit à la main.
  const sorted = new Float64Array(distinct.size);
  let at = 0;
  for (const v of distinct) sorted[at++] = v;
  sorted.sort();
  const rankOf = new Map<number, number>();
  for (let r = 0; r < sorted.length; r += 1) rankOf.set(sorted[r], r);
  return { rankOf, d: sorted.length };
}

/**
 * La clé entière d'un niveau, par ligne : rang dense, retourné si décroissant,
 * vides à la clé maximale quel que soit le sens.
 */
function levelFor(
  table: EngineTable,
  prop: DbProperty,
  direction: DbSort['direction'],
  sel: Uint32Array
): Level {
  const col: Column = table.column(prop);
  const keys = new Uint32Array(table.n);
  const desc = direction === 'desc';
  const assign = (row: number, rank: number, d: number) => {
    keys[row] = rank < 0 ? d : desc ? d - 1 - rank : rank;
  };

  switch (col.kind) {
    case 'number':
    case 'rollup':
    case 'day':
    case 'time': {
      const values = col.kind === 'time' ? col.full : col.kind === 'day' ? col.day : col.values;
      const { rankOf, d } = numericRanks(values, sel);
      for (let j = 0; j < sel.length; j += 1) {
        const row = sel[j];
        const v = values[row];
        assign(row, v === v ? (rankOf.get(v === 0 ? 0 : v) as number) : -1, d);
      }
      return { keys, maxKey: d };
    }
    case 'bool': {
      // Jamais vide : décochée d'abord en ordre croissant
      for (let j = 0; j < sel.length; j += 1) assign(sel[j], col.values[sel[j]], 2);
      return { keys, maxKey: 2 };
    }
    case 'select': {
      // Ordre du SCHÉMA : le code est déjà le rang + 1 ; 0 = vide
      const d = (prop.options ?? []).length;
      for (let j = 0; j < sel.length; j += 1) assign(sel[j], col.codes[sel[j]] - 1, d);
      return { keys, maxKey: d };
    }
    case 'multi': {
      const d = (prop.options ?? []).length;
      for (let j = 0; j < sel.length; j += 1) assign(sel[j], col.minRank[sel[j]], d);
      return { keys, maxKey: d };
    }
    case 'text':
    case 'relation': {
      // Rang de COLLATION de la valeur, gardé par la table pour toute la
      // colonne ; le texte vide et la cible inconnue (−1) sont des vides,
      // rejetés en fin de tri
      const { rank, d } = table.collation(prop);
      const codes = col.codes;
      for (let j = 0; j < sel.length; j += 1) assign(sel[j], rank[codes[sel[j]]], d);
      return { keys, maxKey: d };
    }
    default:
      return { keys, maxKey: 0 };
  }
}

// ==================== Point d'entrée ====================

export interface EngineOptions {
  /** Noyau de tri imposé (tests, bancs) ; par défaut, l'étalonnage de l'appareil. */
  kernel?: SortKernel;
}

/**
 * Filtre, cherche PUIS trie — le remplaçant de `viewEngine.applyView`. La
 * recherche restreint ce que la vue montre sans changer son ordre ; elle passe
 * après les filtres et avant les tris, comme là-bas.
 */
export function engineApplyView(
  data: InlineDbData,
  view: DbView,
  ctx?: DbLinkContext | null,
  search?: string,
  options: EngineOptions = {}
): DbRow[] {
  const order = engineViewOrder(data, view, ctx, search, options);
  const out: DbRow[] = new Array(order.length);
  for (let j = 0; j < order.length; j += 1) out[j] = data.rows[order[j]];
  return out;
}

/**
 * Le même calcul, rendu en POSITIONS de lignes (dans `data.rows`) plutôt qu'en
 * objets — ce que la vue vivante range dans ses emplacements.
 */
export function engineViewOrder(
  data: InlineDbData,
  view: DbView,
  ctx?: DbLinkContext | null,
  search?: string,
  options: EngineOptions = {}
): Uint32Array {
  const table = tableFor(data, ctx);
  const mask = viewMask(table, view);
  let sel = selection(table, mask);
  sel = searchSelection(table, sel, search ?? '');

  const levels: Level[] = [];
  for (const s of view.sorts) {
    const prop = table.props.get(s.propertyId);
    if (prop) levels.push(levelFor(table, prop, s.direction, sel));
  }
  if (levels.length > 0) sortByLevels(options.kernel ?? chooseSortKernel(), sel, levels);
  return sel;
}

/** Utilitaire des tests : le masque complet d'une table, filtres compris. */
export function engineSelection(
  data: InlineDbData,
  view: DbView,
  ctx?: DbLinkContext | null
): number[] {
  const table = tableFor(data, ctx);
  return Array.from(selection(table, viewMask(table, view) ?? fullMask(table.n)));
}
