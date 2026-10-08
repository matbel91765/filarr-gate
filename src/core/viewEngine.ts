// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/viewEngine.ts @ 7864b9e2 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * viewEngine — Filarr Notes / bases inline
 *
 * Moteur PUR des vues enregistrées : familles d'opérateurs, filtrage, tri
 * multi-niveaux, migration des bases d'avant les vues, et nettoyage des vues
 * quand le schéma bouge. Aucun React, aucun DOM : tout est testable seul.
 *
 * Deux règles gouvernent les comparaisons :
 *  - le filtre est d'accord avec ce qu'on VOIT (une valeur d'un type inattendu
 *    s'affiche vide dans la table, elle est donc vide pour le moteur) ;
 *  - un filtre incomplet est inerte (il ne masque rien) — jamais destructeur.
 */

import type {
  DbFilter,
  DbFilterOp,
  DbProperty,
  DbRow,
  DbSort,
  DbView,
  DbViewType,
  InlineDbData,
  PropertyType,
} from './types';
import { makeDefaultView } from './types';
import type { BoardSettings } from './boardLayout';
import { isSummarizable } from './boardLayout';
import type { FilterFamily } from './cellValues';
import {
  cellValueFor,
  dayStamp,
  filterFamily,
  fullStamp,
  isEmptyCellBase,
  numberOf,
  optionIds,
  selectedOptionIds,
  textOf,
} from './cellValues';
import type { DbEnv, DbLinkContext } from './relations';
import { relationText, resolveRelation, rollupNumber } from './relations';

// ==================== Familles de types ====================

/**
 * Les lecteurs de cellules vivent dans `cellValues` (partagés avec le moteur
 * des relations) ; ils restent exportés d'ici, qui est le point d'entrée connu
 * des vues.
 */
export type { FilterFamily, DbEnv, DbLinkContext };
export { filterFamily, cellValueFor };

/**
 * « vide » et « non vide » vont à TOUTES les familles sauf la case à cocher,
 * qui est toujours dans un état (cf. le contrat de DbFilterOp) : le moteur les
 * traite génériquement par `isEmptyCell`, la table doit donc les proposer.
 *
 * `relation` : `contient` porte sur les TITRES des lignes liées — le même geste
 * mental que le « contient » du texte, et le seul qui se saisisse sans ouvrir
 * la base visée. `rollup` : un agrégat se compare comme le nombre qu'il est.
 */
export const FAMILY_OPS: Record<FilterFamily, readonly DbFilterOp[]> = {
  text: ['contains', 'notContains', 'equals', 'isEmpty', 'isNotEmpty'],
  number: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'isEmpty', 'isNotEmpty'],
  select: ['is', 'isNot', 'isEmpty', 'isNotEmpty'],
  multiSelect: ['contains', 'notContains', 'isEmpty', 'isNotEmpty'],
  checkbox: ['isChecked', 'isUnchecked'],
  date: ['before', 'after', 'on', 'isEmpty', 'isNotEmpty'],
  relation: ['contains', 'notContains', 'isEmpty', 'isNotEmpty'],
  rollup: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'isEmpty', 'isNotEmpty'],
};

const LINK_ONLY_OPS: readonly DbFilterOp[] = ['isEmpty', 'isNotEmpty'];

/** Opérateurs proposés pour un type — l'UI et le nettoyage lisent la même table */
export function opsForType(type: PropertyType): readonly DbFilterOp[] {
  const family = filterFamily(type);
  return family ? FAMILY_OPS[family] : LINK_ONLY_OPS;
}

export function isOpValidForType(type: PropertyType, op: DbFilterOp): boolean {
  return opsForType(type).includes(op);
}

/** Opérateurs sans terme de comparaison (l'UI n'affiche alors aucun champ) */
export function opNeedsValue(op: DbFilterOp): boolean {
  return op !== 'isEmpty' && op !== 'isNotEmpty' && op !== 'isChecked' && op !== 'isUnchecked';
}

/** Types dont on peut trier (le lien vers une note ne porte qu'un id opaque) */
export function isSortableType(type: PropertyType): boolean {
  return type !== 'note' && type !== 'vaultFile';
}

// ==================== Lecture douce des cellules ====================

/**
 * « Vide » au sens de l'AFFICHAGE : une valeur d'un type inattendu, ou une
 * option supprimée, n'apparaît nulle part — elle est donc vide ici aussi.
 *
 * Toujours jugé sur la VRAIE ligne, jamais sur une cellule isolée : un agrégat
 * ne lit pas sa propre cellule (rien n'y est stocké), il suit la relation
 * VOISINE — une ligne de circonstance qui ne porterait que la cellule jugée
 * ferait donc rendre 0 à un `count`, et déclarerait la cellule vide à tort.
 *
 * Relations et agrégats se jugent sur ce qu'ils montrent, d'où l'environnement :
 *  - une relation dont plus aucune ligne visée n'existe est vide, MAIS une
 *    relation dont la base est introuvable ne l'est pas : elle garde des
 *    identifiants, et la table affiche « base indisponible » ;
 *  - un agrégat est vide dès qu'il ne rend pas de nombre.
 */
export function isEmptyCell(prop: DbProperty, row: DbRow, env?: DbEnv | null): boolean {
  return isEmptyCellForRow(prop, row, cellValueFor(prop, row), env);
}

/** Même décision, la valeur de la cellule étant déjà lue (chemin du filtrage) */
function isEmptyCellForRow(
  prop: DbProperty,
  row: DbRow,
  value: unknown,
  env?: DbEnv | null
): boolean {
  if (prop.type === 'relation') {
    const res = resolveRelation(prop, row, env);
    // Cible introuvable : la valeur EXISTE toujours, elle est seulement
    // illisible — la dire vide inviterait un filtre à l'effacer de la vue
    if (res.status === 'unavailable') return res.ids.length === 0;
    if (res.status === 'unset') return isEmptyCellBase(prop, value);
    return res.links.length === 0;
  }
  if (prop.type === 'rollup') return rollupNumber(prop, row, env) === null;
  return isEmptyCellBase(prop, value);
}

// ==================== Filtrage ====================

/**
 * Ce filtre peut-il AGIR ?
 *
 * UNE seule définition, lue par le moteur (`matchesFilter`) et par le badge
 * (`activeFilterCount`). Elles décidaient séparément de ce qu'« actif » veut
 * dire, et elles avaient déjà divergé : un opérateur d'une autre famille rendait
 * le filtre inerte à l'application, mais le badge le comptait quand même —
 * « Filtres 1 » sur une vue qui montre tout, exactement le mensonge qu'on venait
 * de retirer par la porte des colonnes absentes.
 *
 * Mesuré, pas supposé, et signalé par `filarr-mobile-b1` sous la forme « deux
 * endroits qui décident séparément finissent par ne plus dire la même chose ».
 * La fenêtre est étroite — `sanitizeViews` écarte ces filtres au commit suivant
 * — mais elle existe entre la relecture d'un document écrit par une autre
 * surface et la première édition.
 *
 * GARDE DE TYPE et pas simple booléen : au-delà de la commodité, ça dit au
 * compilateur ce que la fonction promet — après elle, la propriété existe. Sans
 * ça, le moteur perdait le rétrécissement que lui donnait son ancien
 * `if (!prop || …)`, et la contrainte se serait payée en `!` disséminés.
 */
export function filterActs(prop: DbProperty | undefined, filter: DbFilter): prop is DbProperty {
  return !!prop && isOpValidForType(prop.type, filter.op);
}

/** Vrai = la ligne passe. Un filtre inapplicable ou incomplet ne masque rien. */
export function matchesFilter(
  prop: DbProperty | undefined,
  row: DbRow,
  filter: DbFilter,
  env?: DbEnv | null
): boolean {
  return compileFilter(prop, filter, env, new Map())(row);
}

/** Le test d'une ligne, une fois le filtre préparé. */
export type RowTest = (row: DbRow) => boolean;

const PASSES: RowTest = () => true;

/**
 * Jours civils déjà calculés pendant UN passage du moteur, par chaîne brute. Une
 * colonne de dates porte peu de valeurs distinctes : chacune n'est analysée
 * qu'une fois. Jamais gardé d'un passage à l'autre (le fuseau peut changer).
 */
type DayCache = Map<string, number | null>;

function cachedDayStamp(value: unknown, days: DayCache): number | null {
  if (typeof value !== 'string') return null;
  const known = days.get(value);
  if (known !== undefined) return known;
  const day = dayStamp(value);
  days.set(value, day);
  return day;
}

/** La comparaison d'un opérateur numérique ; un opérateur inconnu laisse passer. */
function numberTest(op: DbFilterOp, target: number): (n: number) => boolean {
  switch (op) {
    case 'eq':
      return (n) => n === target;
    case 'neq':
      return (n) => n !== target;
    case 'gt':
      return (n) => n > target;
    case 'lt':
      return (n) => n < target;
    case 'gte':
      return (n) => n >= target;
    case 'lte':
      return (n) => n <= target;
    default:
      return () => true;
  }
}

/**
 * PRÉPARE un filtre : tout ce qui ne dépend pas de la ligne (le terme normalisé,
 * le jour visé, les options connues) est calculé UNE fois, au lieu d'une fois
 * par ligne (phase 1 du moteur, docs/moteur-bases/PLAN.md). La sémantique est
 * celle de toujours, vérifiée ligne à ligne contre la copie figée
 * (`__tests__/reference/viewEngineRef.ts`) sur des bases tirées au hasard.
 */
function compileFilter(
  prop: DbProperty | undefined,
  filter: DbFilter,
  env: DbEnv | null | undefined,
  days: DayCache
): RowTest {
  // Propriété disparue ou opérateur d'une autre famille : filtre inerte
  if (!filterActs(prop, filter)) return PASSES;

  switch (filter.op) {
    case 'isEmpty':
      return (row) => isEmptyCellForRow(prop, row, cellValueFor(prop, row), env);
    case 'isNotEmpty':
      return (row) => !isEmptyCellForRow(prop, row, cellValueFor(prop, row), env);
    case 'isChecked':
      return (row) => cellValueFor(prop, row) === true;
    case 'isUnchecked':
      return (row) => cellValueFor(prop, row) !== true;
    default:
      break;
  }

  switch (filterFamily(prop.type)) {
    case 'relation': {
      const needle = typeof filter.value === 'string' ? filter.value.trim().toLowerCase() : '';
      if (needle === '') return PASSES;
      const contains = filter.op === 'contains';
      return (row) => {
        const hay = relationText(prop, row, env);
        // Base visée inconnue : on ne sait rien des titres, le filtre est inerte
        if (hay === null) return true;
        const found = hay.toLowerCase().includes(needle);
        return contains ? found : !found;
      };
    }
    case 'rollup': {
      const target = numberOf(filter.value);
      if (target === null) return PASSES;
      const test = numberTest(filter.op, target);
      const neq = filter.op === 'neq';
      return (row) => {
        const n = rollupNumber(prop, row, env);
        // Comme un nombre vide : ni égal, ni comparable — seul « ≠ » l'accepte
        return n === null ? neq : test(n);
      };
    }
    case 'text': {
      const needle = typeof filter.value === 'string' ? filter.value.trim().toLowerCase() : '';
      if (needle === '') return PASSES;
      if (filter.op === 'contains') {
        return (row) => textOf(cellValueFor(prop, row)).toLowerCase().includes(needle);
      }
      if (filter.op === 'notContains') {
        return (row) => !textOf(cellValueFor(prop, row)).toLowerCase().includes(needle);
      }
      if (filter.op === 'equals') {
        return (row) => textOf(cellValueFor(prop, row)).toLowerCase() === needle;
      }
      return PASSES;
    }
    case 'number': {
      const target = numberOf(filter.value);
      if (target === null) return PASSES;
      const test = numberTest(filter.op, target);
      const neq = filter.op === 'neq';
      return (row) => {
        const n = numberOf(cellValueFor(prop, row));
        // Une cellule vide n'est ni égale ni comparable : seul « ≠ » l'accepte
        return n === null ? neq : test(n);
      };
    }
    case 'select': {
      const target = typeof filter.value === 'string' ? filter.value : '';
      if (target === '') return PASSES;
      // Comparaison par IDENTIFIANT d'option (renommer une option ne change rien)
      const known = optionIds(prop);
      const is = filter.op === 'is';
      return (row) => {
        const value = cellValueFor(prop, row);
        const current = typeof value === 'string' && known.has(value) ? value : '';
        return is ? current === target : current !== target;
      };
    }
    case 'multiSelect': {
      const target = typeof filter.value === 'string' ? filter.value : '';
      if (target === '') return PASSES;
      // La cible n'est portée QUE si elle est une option connue présente dans
      // la cellule — exactement `selectedOptionIds(…).includes(cible)`, sans
      // rebâtir la liste filtrée à chaque ligne.
      const targetKnown = optionIds(prop).has(target);
      const contains = filter.op === 'contains';
      return (row) => {
        const value = cellValueFor(prop, row);
        const found = targetKnown && Array.isArray(value) && value.includes(target);
        return contains ? found : !found;
      };
    }
    case 'date': {
      const target = dayStamp(filter.value);
      if (target === null) return PASSES;
      const op = filter.op;
      if (op !== 'before' && op !== 'after' && op !== 'on') {
        // Une date absente n'est ni avant, ni après, ni « le » — et un
        // opérateur inconnu ne retient que les dates présentes.
        return (row) => cachedDayStamp(cellValueFor(prop, row), days) !== null;
      }
      return (row) => {
        const day = cachedDayStamp(cellValueFor(prop, row), days);
        // Une date absente n'est ni avant, ni après, ni « le »
        if (day === null) return false;
        if (op === 'before') return day < target;
        if (op === 'after') return day > target;
        return day === target;
      };
    }
    default:
      return PASSES;
  }
}

function propertyIndex(properties: DbProperty[]): Map<string, DbProperty> {
  return new Map(properties.map((p) => [p.id, p]));
}

/**
 * Environnement d'évaluation d'une base : son schéma (une propriété rollup a
 * besoin de retrouver la relation qu'elle suit) et, quand la couche React le
 * fournit, l'index des bases visées. Sans lui, relations et agrégats sont
 * simplement illisibles — donc inertes, jamais faussement vides.
 */
function envFor(data: InlineDbData, ctx?: DbLinkContext | null): DbEnv {
  return { properties: data.properties, ...(ctx ? { ctx } : {}) };
}

export function applyFilters(
  data: InlineDbData,
  filters: DbFilter[],
  ctx?: DbLinkContext | null
): DbRow[] {
  if (filters.length === 0) return data.rows;
  const props = propertyIndex(data.properties);
  const env = envFor(data, ctx);
  const days: DayCache = new Map();
  const tests = filters.map((f) => compileFilter(props.get(f.propertyId), f, env, days));
  // Combinaison ET uniquement (v1) : une seule condition fausse suffit à masquer
  return data.rows.filter((row) => tests.every((test) => test(row)));
}

/**
 * Les filtres d'une VUE, avec OU et groupes (contrat gelé 2026-09-19).
 *
 * Clauses de premier niveau = chaque filtre de `view.filters` + chaque groupe
 * de `view.filterGroups` ; combinées par `view.filterMatch` (`all` d'office).
 * Un groupe combine ses filtres par son `match`.
 *
 * En OU, une clause INERTE (colonne absente, opérateur hors famille) n'est
 * pas comptée : sinon « vrai par défaut » ferait passer toutes les lignes dès
 * qu'une colonne manque. Un groupe sans clause agissante est inerte de même.
 * Aucune clause agissante : toutes les lignes.
 */
export function applyViewFilters(
  data: InlineDbData,
  view: Pick<DbView, 'filters' | 'filterMatch' | 'filterGroups'>,
  ctx?: DbLinkContext | null
): DbRow[] {
  const test = compileViewFilter(data, view, ctx);
  return test ? data.rows.filter(test) : data.rows;
}

/**
 * Le prédicat des filtres d'une vue sur UNE ligne, préparé une fois — `null`
 * quand aucune clause n'agit (toutes les lignes passent). La seule définition,
 * lue par `applyViewFilters` et par la vue vivante du moteur (`engine/`), qui
 * réévalue une ligne modifiée sans repasser sur les autres.
 */
export function compileViewFilter(
  data: InlineDbData,
  view: Pick<DbView, 'filters' | 'filterMatch' | 'filterGroups'>,
  ctx?: DbLinkContext | null
): RowTest | null {
  const props = propertyIndex(data.properties);
  const acting = (f: DbFilter) => filterActs(props.get(f.propertyId), f);
  const groups = (view.filterGroups ?? [])
    .map((g) => ({ match: g.match, filters: g.filters.filter(acting) }))
    .filter((g) => g.filters.length > 0);
  const singles = view.filters.filter(acting);
  if (singles.length === 0 && groups.length === 0) return null;
  const env = envFor(data, ctx);
  // Chaque filtre est PRÉPARÉ une fois pour tout le passage (voir `compileFilter`).
  const days: DayCache = new Map();
  const compile = (f: DbFilter) => compileFilter(props.get(f.propertyId), f, env, days);
  const clauses: RowTest[] = [
    ...singles.map(compile),
    ...groups.map((g): RowTest => {
      const tests = g.filters.map(compile);
      return g.match === 'any'
        ? (row) => tests.some((test) => test(row))
        : (row) => tests.every((test) => test(row));
    }),
  ];
  const any = view.filterMatch === 'any';
  return any
    ? (row) => clauses.some((clause) => clause(row))
    : (row) => clauses.every((clause) => clause(row));
}

// ==================== Tri ====================

export interface SortKey {
  empty: boolean;
  num: number | null;
  str: string | null;
}

const EMPTY_KEY: SortKey = { empty: true, num: null, str: null };

let collatorCache: Intl.Collator | null = null;
function collator(): Intl.Collator {
  if (!collatorCache) {
    // numeric : « Item 2 » avant « Item 10 » ; base : accents et casse ignorés
    collatorCache = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  }
  return collatorCache;
}

/** Rang de chaque option dans l'ordre du SCHÉMA — la première occurrence d'un id fait foi. */
function optionRanks(prop: DbProperty): Map<string, number> {
  const ranks = new Map<string, number>();
  (prop.options ?? []).forEach((o, i) => {
    if (!ranks.has(o.id)) ranks.set(o.id, i);
  });
  return ranks;
}

/**
 * Le lecteur de clé d'une colonne, PRÉPARÉ une fois par tri : les rangs des
 * options au lieu d'un `findIndex` par ligne, les jours déjà analysés (phase 1
 * du moteur, docs/moteur-bases/PLAN.md).
 */
function sortKeyReader(
  prop: DbProperty,
  env: DbEnv | null | undefined,
  days: DayCache
): (row: DbRow) => SortKey {
  switch (prop.type) {
    case 'relation':
      return (row) => {
        // Trié sur ce qu'on LIT : les titres liés, mis bout à bout. Cible inconnue
        // (base indisponible) → vide, donc rejeté en fin de tri sans faux ordre.
        const text = relationText(prop, row, env);
        return text === null || text === '' ? EMPTY_KEY : { empty: false, num: null, str: text };
      };
    case 'rollup':
      return (row) => {
        const n = rollupNumber(prop, row, env);
        return n === null ? EMPTY_KEY : { empty: false, num: n, str: null };
      };
    case 'checkbox':
      // Jamais vide : décochée d'abord en ordre croissant
      return (row) => ({ empty: false, num: cellValueFor(prop, row) === true ? 1 : 0, str: null });
    case 'number':
    case 'rating':
    case 'progress':
      return (row) => {
        const n = numberOf(cellValueFor(prop, row));
        return n === null ? EMPTY_KEY : { empty: false, num: n, str: null };
      };
    case 'date':
      return (row) => {
        const d = cachedDayStamp(cellValueFor(prop, row), days);
        return d === null ? EMPTY_KEY : { empty: false, num: d, str: null };
      };
    case 'createdTime':
    case 'updatedTime':
      return (row) => {
        const t = fullStamp(cellValueFor(prop, row));
        return t === null ? EMPTY_KEY : { empty: false, num: t, str: null };
      };
    case 'select': {
      // Ordre du SCHÉMA (comme les colonnes du board), pas ordre alphabétique
      const ranks = optionRanks(prop);
      return (row) => {
        const value = cellValueFor(prop, row);
        const idx = typeof value === 'string' ? ranks.get(value) : undefined;
        return idx === undefined ? EMPTY_KEY : { empty: false, num: idx, str: null };
      };
    }
    case 'multiSelect': {
      const ranks = optionRanks(prop);
      return (row) => {
        const ids = selectedOptionIds(prop, cellValueFor(prop, row));
        if (ids.length === 0) return EMPTY_KEY;
        // Des options CONNUES (`selectedOptionIds`) : chacune a son rang.
        let idx = Infinity;
        for (const id of ids) idx = Math.min(idx, ranks.get(id) as number);
        return { empty: false, num: idx, str: null };
      };
    }
    default:
      return (row) => {
        const s = textOf(cellValueFor(prop, row));
        return s === '' ? EMPTY_KEY : { empty: false, num: null, str: s };
      };
  }
}

/**
 * Le premier niveau d'un tri sur du TEXTE passe en RANGS : les valeurs
 * distinctes sont triées une fois par le collateur, et chaque ligne reçoit le
 * rang de la sienne (deux textes que le collateur dit égaux partagent le même).
 * Le tri principal ne compare plus que des nombres : d log d appels au
 * collateur au lieu de n log n — jamais plus, et beaucoup moins dès que les
 * valeurs se répètent. Les niveaux suivants gardent le collateur : il n'y est
 * appelé que pour départager, rarement.
 */
function rankTextLevel(decorated: Array<{ keys: SortKey[] }>, level: number): void {
  const distinct = new Set<string>();
  for (const d of decorated) {
    const key = d.keys[level];
    if (!key.empty && key.num === null && key.str !== null) distinct.add(key.str);
  }
  if (distinct.size === 0) return;
  const compare = collator().compare;
  const sorted = [...distinct].sort(compare);
  const rankOf = new Map<string, number>();
  let rank = 0;
  sorted.forEach((s, i) => {
    if (i > 0 && compare(sorted[i - 1], s) !== 0) rank += 1;
    rankOf.set(s, rank);
  });
  for (const d of decorated) {
    const key = d.keys[level];
    if (!key.empty && key.num === null && key.str !== null) {
      d.keys[level] = { empty: false, num: rankOf.get(key.str) as number, str: null };
    }
  }
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (a.num !== null && b.num !== null) return a.num < b.num ? -1 : a.num > b.num ? 1 : 0;
  return collator().compare(a.str ?? '', b.str ?? '');
}

/** Tri STABLE, multi-niveaux, vides toujours en dernier quel que soit le sens */
export function applySorts(
  data: InlineDbData,
  rows: DbRow[],
  sorts: DbSort[],
  ctx?: DbLinkContext | null
): DbRow[] {
  const compiled = compileSort(data, sorts, ctx);
  if (!compiled) return rows;

  // Décoration : index d'origine (stabilité garantie sans dépendre du moteur) ET
  // clés de tri calculées UNE fois par ligne et par niveau. Les rebâtir dans le
  // comparateur en referait deux par comparaison — donc O(n log n) reparsages de
  // date au lieu de O(n), soit des dizaines de milliers sur quelques milliers de
  // lignes.
  const decorated = rows.map((row, index) => ({ row, index, keys: compiled.keysOf(row) }));
  rankTextLevel(decorated, 0);

  decorated.sort((a, b) => compiled.compare(a.keys, b.keys) || a.index - b.index);
  return decorated.map((d) => d.row);
}

/** Les tris d'une vue, préparés : les clés d'une ligne, et l'ordre de deux jeux de clés. */
export interface CompiledSort {
  keysOf(row: DbRow): SortKey[];
  /** Ordre de deux lignes par leurs clés, SANS le départage par l'ordre d'origine. */
  compare(a: SortKey[], b: SortKey[]): number;
}

/**
 * Les tris d'une vue, préparés une fois — `null` quand aucun niveau ne vise une
 * propriété existante. La seule définition de l'ordre, lue par `applySorts` et
 * par la vue vivante du moteur : vides toujours en dernier, deux vides passent
 * au critère suivant, sens décroissant par inversion de la comparaison.
 */
export function compileSort(
  data: InlineDbData,
  sorts: DbSort[],
  ctx?: DbLinkContext | null
): CompiledSort | null {
  if (sorts.length === 0) return null;
  const props = propertyIndex(data.properties);
  const env = envFor(data, ctx);
  const active = sorts
    .map((s) => ({ prop: props.get(s.propertyId), direction: s.direction }))
    .filter((s): s is { prop: DbProperty; direction: DbSort['direction'] } => !!s.prop);
  if (active.length === 0) return null;
  const days: DayCache = new Map();
  const readers = active.map((a) => sortKeyReader(a.prop, env, days));
  return {
    keysOf: (row) => readers.map((read) => read(row)),
    compare: (a, b) => {
      for (let level = 0; level < active.length; level += 1) {
        const ka = a[level];
        const kb = b[level];
        // Deux vides ne se départagent pas : on passe au critère suivant
        if (ka.empty && kb.empty) continue;
        if (ka.empty) return 1;
        if (kb.empty) return -1;
        const c = compareKeys(ka, kb);
        if (c !== 0) return active[level].direction === 'desc' ? -c : c;
      }
      return 0;
    },
  };
}

/** Filtre PUIS trie — le seul point d'entrée du rendu */
export function applyView(
  data: InlineDbData,
  view: DbView,
  ctx?: DbLinkContext | null,
  /** Recherche rapide, EPHEMERE : elle ne s'ecrit jamais dans le document. */
  search?: string
): DbRow[] {
  // La recherche s'applique APRES les filtres et AVANT les tris : elle
  // restreint ce que la vue montre, sans jamais changer son ordre.
  const filtered = applySearch(applyViewFilters(data, view, ctx), data.properties, search ?? '');
  return applySorts(data, filtered, view.sorts, ctx);
}

// ==================== Vues : migration et cohérence ====================

/**
 * Vue affichée. L'onglet choisi LOCALEMENT (préférence de cet appareil, cf.
 * `viewPrefKey`) prime, mais seulement s'il désigne encore une vue : un onglet
 * supprimé ailleurs ne doit pas figer l'affichage. Repli ensuite sur l'onglet
 * enregistré dans le document, puis sur la première vue.
 */
/**
 * Colonnes AFFICHEES par une vue, dans son ordre.
 *
 * Deux garde-fous, et ce sont eux qui comptent :
 *  - une propriete absente de `propertyOrder` n'est pas perdue, elle passe a la
 *    fin. Une colonne ajoutee apres coup disparaitrait sinon de toutes les vues
 *    deja reglees, sans que rien ne le dise ;
 *  - un identifiant qui ne designe plus rien (colonne supprimee) est ignore.
 */
export function orderedVisibleProperties(
  properties: DbProperty[],
  view: Pick<DbView, 'hiddenPropertyIds' | 'propertyOrder'> | null | undefined
): DbProperty[] {
  if (!view) return properties;
  const hidden = new Set(view.hiddenPropertyIds ?? []);
  const order = view.propertyOrder ?? [];

  const byId = new Map(properties.map((prop) => [prop.id, prop]));
  const ordered: DbProperty[] = [];
  const placed = new Set<string>();

  for (const id of order) {
    const prop = byId.get(id);
    if (prop && !placed.has(id)) {
      ordered.push(prop);
      placed.add(id);
    }
  }
  for (const prop of properties) {
    if (!placed.has(prop.id)) ordered.push(prop);
  }

  return ordered.filter((prop) => !hidden.has(prop.id));
}

/**
 * Deplace `propertyId` A LA PLACE de `targetId` (glisser-deposer).
 *
 * Le deplacement porte sur l'ordre COMPLET, colonnes masquees comprises :
 * reordonner a partir des seules colonnes visibles ferait sauter les masquees a
 * une place arbitraire des qu'on les reaffiche.
 */
export function reorderPropertyInView(
  view: DbView,
  properties: DbProperty[],
  propertyId: string,
  targetId: string
): DbView {
  const full = orderedVisibleProperties(properties, { propertyOrder: view.propertyOrder });
  const ids = full.map((prop) => prop.id);
  const from = ids.indexOf(propertyId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return view;
  ids.splice(from, 1);
  ids.splice(to, 0, propertyId);
  return { ...view, propertyOrder: ids };
}

/**
 * Tout afficher, ou tout masquer SAUF la premiere.
 *
 * « Tout masquer » garde une colonne : une table sans aucune colonne n'affiche
 * plus rien, et l'utilisateur n'aurait alors plus aucun moyen de revenir en
 * arriere depuis la table elle-meme.
 */
export function setAllPropertiesVisible(
  view: DbView,
  properties: DbProperty[],
  visible: boolean
): DbView {
  if (visible) return { ...view, hiddenPropertyIds: undefined };
  const ordered = orderedVisibleProperties(properties, { propertyOrder: view.propertyOrder });
  const hidden = ordered.slice(1).map((prop) => prop.id);
  return {
    ...view,
    ...(hidden.length > 0 ? { hiddenPropertyIds: hidden } : { hiddenPropertyIds: undefined }),
  };
}

/**
 * Rend la vue avec `propertyId` masquee ou reaffichee.
 *
 * La DERNIERE colonne visible ne peut pas etre masquee : une table sans aucune
 * colonne n'affiche plus rien, et l'utilisateur n'a alors plus aucun moyen de
 * revenir en arriere depuis la table elle-meme.
 */
export function togglePropertyVisibility(
  view: DbView,
  properties: DbProperty[],
  propertyId: string
): DbView {
  const hidden = new Set(view.hiddenPropertyIds ?? []);
  if (hidden.has(propertyId)) {
    hidden.delete(propertyId);
  } else {
    if (orderedVisibleProperties(properties, view).length <= 1) return view;
    hidden.add(propertyId);
  }
  const next = Array.from(hidden);
  return {
    ...view,
    ...(next.length > 0 ? { hiddenPropertyIds: next } : { hiddenPropertyIds: undefined }),
  };
}

/** Deplace une propriete d'un cran dans l'ordre de la vue. */
export function movePropertyInView(
  view: DbView,
  properties: DbProperty[],
  propertyId: string,
  delta: -1 | 1
): DbView {
  // On part de l'ordre EFFECTIF (schema complet, ordre de la vue applique) :
  // reordonner a partir d'une liste partielle melangerait les colonnes
  // masquees avec les autres.
  const full = orderedVisibleProperties(properties, { propertyOrder: view.propertyOrder });
  const from = full.findIndex((prop) => prop.id === propertyId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= full.length) return view;
  const ids = full.map((prop) => prop.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  return { ...view, propertyOrder: ids };
}

/**
 * Texte cherchable d'une ligne : toutes ses cellules, mises a plat.
 *
 * On cherche sur les valeurs BRUTES et non sur l'affichage : une recherche doit
 * trouver « 2026-03-05 » comme « 5 mars », et l'affichage depend de la langue.
 * Les identifiants d'option sont traduits en libelles, sans quoi chercher
 * « urgent » ne trouverait rien dans une colonne de choix.
 */
function rowHaystack(
  row: DbRow,
  properties: DbProperty[],
  labels: ReadonlyMap<string, ReadonlyMap<unknown, string>>
): string {
  const parts: string[] = [];
  for (const prop of properties) {
    const value = row.cells[prop.id];
    if (value === undefined || value === null) continue;
    if (prop.type === 'select' || prop.type === 'multiSelect') {
      const byId = labels.get(prop.id);
      const ids = Array.isArray(value) ? value : [value];
      for (const id of ids) {
        const label = byId?.get(id);
        if (label) parts.push(label);
      }
      continue;
    }
    if (Array.isArray(value)) parts.push(value.join(' '));
    else parts.push(String(value));
  }
  return parts.join(' ');
}

/**
 * Libellé de chaque option, par colonne de choix — la PREMIÈRE option d'un id
 * fait foi, comme le `find` d'origine.
 */
function optionLabels(properties: DbProperty[]): Map<string, Map<unknown, string>> {
  const byProp = new Map<string, Map<unknown, string>>();
  for (const prop of properties) {
    if (prop.type !== 'select' && prop.type !== 'multiSelect') continue;
    const byId = new Map<unknown, string>();
    for (const option of prop.options ?? []) {
      if (!byId.has(option.id)) byId.set(option.id, option.label);
    }
    byProp.set(prop.id, byId);
  }
  return byProp;
}

/**
 * Le texte cherchable d'une ligne, NORMALISÉ, gardé d'une frappe à l'autre : la
 * recherche rapide le recalculait pour chaque ligne à chaque lettre tapée
 * (phase 1 du moteur). Une ligne modifiée est un NOUVEL objet, et le schéma
 * aussi : la clé (ligne) et la vérification (tableau de propriétés) suffisent.
 */
const haystackCache = new WeakMap<DbRow, { properties: DbProperty[]; hay: string }>();

/** Normalise pour une comparaison insensible a la casse ET aux accents. */
export function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Lignes dont une cellule contient la recherche. */
export function applySearch(rows: DbRow[], properties: DbProperty[], search: string): DbRow[] {
  const needle = normalizeSearch(search);
  if (needle === '') return rows;
  const searcher = haystackReader(properties);
  return rows.filter((row) => searcher(row).includes(needle));
}

/**
 * Le texte cherchable NORMALISÉ d'une ligne, gardé d'une frappe à l'autre — la
 * seule définition, lue par la recherche rapide et par le moteur en colonnes
 * (`engine/`), pour qu'ils ne puissent pas chercher deux choses différentes.
 */
export function haystackReader(properties: DbProperty[]): (row: DbRow) => string {
  let labels: Map<string, Map<unknown, string>> | null = null;
  return (row) => {
    const cached = haystackCache.get(row);
    if (cached && cached.properties === properties) return cached.hay;
    labels ??= optionLabels(properties);
    const hay = normalizeSearch(rowHaystack(row, properties, labels));
    haystackCache.set(row, { properties, hay });
    return hay;
  };
}

export function resolveActiveView(data: InlineDbData, localViewId?: string | null): DbView {
  const views = data.views ?? [];
  return (
    views.find((v) => v.id === localViewId) ??
    views.find((v) => v.id === data.activeViewId) ??
    views[0] ??
    makeDefaultView('table')
  );
}

/** Vue affichée sans préférence locale (repli sur la première si l'id actif ne pointe sur rien) */
export function activeViewOf(data: InlineDbData): DbView {
  return resolveActiveView(data, null);
}

/**
 * Attrs hérités à réécrire à chaque commit, en MIROIR de la vue active : un
 * client d'avant les vues ne lit que `view`/`groupBy` et reste utilisable
 * (il affichera la vue active, sans ses filtres). C'est le prix de la
 * compatibilité descendante, et il est payé à chaque écriture.
 */
export function legacyAttrsFor(data: InlineDbData): { view: DbViewType; groupBy: string } {
  const active = activeViewOf(data);
  return { view: active.type, groupBy: active.groupBy ?? '' };
}

/**
 * Retire des vues ce que le schéma ne porte plus : filtres et tris d'une
 * propriété supprimée, filtres dont l'opérateur ne va plus au type (changement
 * de type), filtres visant une option de sélection supprimée, groupBy qui ne
 * désigne plus une propriété select. Les LIGNES ne sont jamais touchées.
 */
/**
 * Réglages de plateau qui ne visent plus rien.
 *
 * Un second axe posé sur une colonne supprimée découperait le plateau en un
 * unique couloir « Sans valeur » — soit exactement l'aspect d'un bug. Un résumé
 * dont la propriété a changé de type afficherait, lui, une somme de rien.
 * Les PLAFONDS, eux, ne sont pas touchés : ils désignent des options, et une
 * option momentanément absente (base en cours de chargement) ne doit pas coûter
 * un réglage qu'on avait posé à la main.
 */
function sanitizeBoard(
  board: BoardSettings | undefined,
  props: Map<string, DbProperty>
): BoardSettings | undefined {
  if (!board) return undefined;
  const swimlaneProp = board.swimlaneBy ? props.get(board.swimlaneBy) : undefined;
  const summaryProp = board.summaryBy ? props.get(board.summaryBy) : undefined;
  const next: BoardSettings = {
    ...board,
    ...(swimlaneProp && swimlaneProp.type === 'select'
      ? { swimlaneBy: board.swimlaneBy }
      : { swimlaneBy: undefined }),
    ...(summaryProp && isSummarizable(summaryProp)
      ? { summaryBy: board.summaryBy }
      : { summaryBy: undefined }),
  };
  return Object.values(next).some((value) => value !== undefined) ? next : undefined;
}

/**
 * Ce réglage désigne-t-il une colonne qui n'existe pas (ou plus) ?
 *
 * Sert à deux choses, et les deux comptent : ne pas COMPTER un réglage inerte
 * comme actif, et le MARQUER dans le panneau. Sans ça, conserver une référence
 * orpheline remplacerait une perte silencieuse par un mensonge silencieux — un
 * bouton « Filtres 1 » allumé sur une vue qui montre tout.
 */
export function isOrphanReference(
  propertyId: string | undefined,
  properties: DbProperty[]
): boolean {
  if (!propertyId) return false;
  return !properties.some((p) => p.id === propertyId);
}

/**
 * Filtres qui filtrent VRAIMENT.
 *
 * La MÊME condition que le moteur, jamais une seconde écrite à côté : c'est ce
 * qui garantit que le badge et l'écran racontent la même histoire. Un filtre
 * orphelin est inerte, un opérateur hors famille aussi — les deux sont ici pour
 * la même raison, et par le même code.
 */
export function activeFilterCount(view: DbView, properties: DbProperty[]): number {
  const parId = new Map(properties.map((p) => [p.id, p]));
  const acting = (f: DbFilter) => filterActs(parId.get(f.propertyId), f);
  return (
    view.filters.filter(acting).length +
    (view.filterGroups ?? []).reduce((n, g) => n + g.filters.filter(acting).length, 0)
  );
}

/** Tris qui trient VRAIMENT, même raison. */
export function activeSortCount(view: DbView, properties: DbProperty[]): number {
  return view.sorts.filter((s) => !isOrphanReference(s.propertyId, properties)).length;
}

/**
 * ── RÈGLE GELÉE le 2026-09-09 avec `filarr-mobile-b1` ───────────────────────
 *
 * **Une référence orpheline se CONSERVE toujours ; ce qui varie, c'est si on
 * l'APPLIQUE.**
 *
 * Cette fonction effaçait les filtres, les tris et le groupement qui
 * désignaient une colonne absente — définitivement, au premier commit. Le
 * contrat de la frise, gelé le même jour, promettait l'inverse pour la même
 * chose (« une colonne supprimée puis rétablie ne doit pas coûter le réglage au
 * passage »).
 *
 * L'argument qui aurait justifié la destruction — un filtre orphelin appliqué
 * donnerait des lignes fausses — ne tenait pas : le moteur le neutralise DÉJÀ
 * (`matchesFilter` rend `true`, `applySorts` écarte le tri du comparateur, le
 * kanban retombe sur la première colonne à options). On résolvait un problème
 * d'évaluation par une destruction, alors qu'il était résolu.
 *
 * CE QUI RESTE NETTOYÉ, et la distinction est ce qui empêche « conserver » de
 * devenir « tout garder » : un réglage devenu FAUX sur une colonne bien
 * présente — opérateur d'une autre famille, tri sur un type non triable,
 * valeur de sélection qui n'est plus une option. Ce ne sont pas des références
 * orphelines ; la colonne ne reviendra pas différemment.
 */
export function sanitizeViews(data: InlineDbData): InlineDbData {
  const props = propertyIndex(data.properties);
  const source = data.views && data.views.length > 0 ? data.views : [makeDefaultView('table')];

  const views = source.map((view) => {
    const keepFilter = (f: DbFilter): boolean => {
      const prop = props.get(f.propertyId);
      // Colonne absente : CONSERVÉ (il revivra), et déjà inerte à l'application.
      if (!prop) return true;
      if (!isOpValidForType(prop.type, f.op)) return false;
      if (
        (prop.type === 'select' || prop.type === 'multiSelect') &&
        opNeedsValue(f.op) &&
        typeof f.value === 'string' &&
        f.value !== '' &&
        !optionIds(prop).has(f.value)
      ) {
        return false;
      }
      return true;
    };
    const filters = view.filters.filter(keepFilter);
    // Les groupes suivent la même règle, filtre par filtre ; un groupe vidé
    // reste (inerte) : c'est un cadre, pas un réglage faux.
    const filterGroups = view.filterGroups?.map((g) => ({
      ...g,
      filters: g.filters.filter(keepFilter),
    }));
    const seen = new Set<string>();
    const sorts = view.sorts.filter((s) => {
      // Un seul tri par propriété : le premier niveau gagne. Le dédoublonnage
      // passe AVANT le reste — il vaut aussi pour les orphelins, sans quoi deux
      // tris sur la même colonne absente survivraient tous les deux.
      if (seen.has(s.propertyId)) return false;
      const prop = props.get(s.propertyId);
      // Colonne présente mais d'un type qu'on ne sait pas trier : réglage FAUX,
      // écarté. Colonne absente : CONSERVÉ.
      if (prop && !isSortableType(prop.type)) return false;
      seen.add(s.propertyId);
      return true;
    });
    const groupProp = view.groupBy ? props.get(view.groupBy) : undefined;
    // Colonne absente : le groupement est CONSERVÉ — la vue kanban retombe
    // d'elle-même sur la première colonne à options tant qu'elle manque.
    const groupBy =
      view.groupBy && (!groupProp || groupProp.type === 'select') ? view.groupBy : undefined;
    return {
      ...view,
      filters,
      ...(filterGroups ? { filterGroups } : {}),
      sorts,
      ...(groupBy ? { groupBy } : { groupBy: undefined }),
      board: sanitizeBoard(view.board, props),
    };
  });

  const activeViewId = views.some((v) => v.id === data.activeViewId)
    ? data.activeViewId
    : views[0].id;

  return { ...data, views, activeViewId };
}

/**
 * COHÉRENCE DU SCHÉMA, appliquée au commit (jamais à la lecture : lire ne doit
 * rien écrire). Ce qui est nettoyé :
 *  - un agrégat qui suivait une relation supprimée — ou devenue un autre type —
 *    perd sa relation ET sa propriété cible : il redevient un agrégat à
 *    configurer, visiblement vide, plutôt qu'un chiffre qui ne veut plus rien dire ;
 *  - une propriété qui n'est plus une relation lâche sa cible, une propriété qui
 *    n'est plus un agrégat lâche sa configuration (conversion de type propre).
 *
 * Ce qui n'est JAMAIS touché :
 *  - `targetDbId` d'une relation vivante, même quand la base visée est absente
 *    de l'index : une note pas encore chargée n'est pas une base supprimée ;
 *  - les LIGNES. Changer la cible d'une relation laisse les identifiants en
 *    place : ceux qui ne désignent plus rien s'affichent en « introuvables »
 *    (et le sélecteur propose de les retirer), et re-viser l'ancienne base les
 *    fait tous revenir. Un nettoyage automatique, lui, serait irréversible et
 *    se déclencherait au moindre index momentanément incomplet.
 */
export function sanitizeSchema(data: InlineDbData): InlineDbData {
  const byId = propertyIndex(data.properties);
  let changed = false;

  const properties = data.properties.map((prop) => {
    const next: DbProperty = { ...prop };
    let touched = false;

    if (next.type !== 'relation' && next.targetDbId !== undefined) {
      next.targetDbId = undefined;
      touched = true;
    }

    // Une date posée d'office n'a de sens que sur une Date, avec un déclencheur
    // qui existe : le contrat permet au rédacteur de retirer la règle dans ces
    // deux cas. Un déclencheur d'un autre type la rend seulement inerte.
    if (next.autoDate && (next.type !== 'date' || !byId.has(next.autoDate.propertyId))) {
      next.autoDate = undefined;
      touched = true;
    }

    if (next.type === 'rollup') {
      const via = next.viaPropertyId ? byId.get(next.viaPropertyId) : undefined;
      if (next.viaPropertyId && (!via || via.type !== 'relation')) {
        next.viaPropertyId = undefined;
        next.targetPropertyId = undefined;
        touched = true;
      }
    } else if (
      next.viaPropertyId !== undefined ||
      next.targetPropertyId !== undefined ||
      next.aggregate !== undefined
    ) {
      next.viaPropertyId = undefined;
      next.targetPropertyId = undefined;
      next.aggregate = undefined;
      touched = true;
    }

    if (!touched) return prop;
    changed = true;
    return next;
  });

  return changed ? { ...data, properties } : data;
}

/**
 * MIGRATION SANS PERTE des bases d'avant les vues : `views` absent → on
 * fabrique « Vue principale » à partir des attrs de nœud `view`/`groupBy`, sans
 * toucher aux propriétés ni aux lignes. Idempotent (rappelé à chaque lecture).
 */
export function ensureViews(
  data: InlineDbData,
  legacy: { view?: string; groupBy?: string }
): InlineDbData {
  if (data.views && data.views.length > 0) return sanitizeViews(data);
  const type = legacy.view === 'board' ? 'board' : 'table';
  const groupBy =
    typeof legacy.groupBy === 'string' && legacy.groupBy !== '' ? legacy.groupBy : undefined;
  const view = makeDefaultView(type, groupBy);
  return sanitizeViews({ ...data, views: [view], activeViewId: view.id });
}

// ==================== Nouvelle ligne dans une vue filtrée ====================

const MS_PER_DAY = 86400000;

function shiftDay(value: string, days: number): string | undefined {
  const stamp = dayStamp(value);
  if (stamp === null) return undefined;
  const d = new Date(stamp + days * MS_PER_DAY);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Un filtre négatif de sélection écarte-t-il PRÉCISÉMENT l'option que le schéma
 * pose d'office ? Si oui, la ligne naîtrait avec la valeur exclue et serait
 * masquée à l'instant même de sa création (« Statut ≠ À faire » où « À faire »
 * est le défaut). Une cellule déjà décidée par un autre filtre de la vue n'est
 * pas touchée : c'est ce choix-là qui rend la ligne visible.
 */
function excludesSchemaDefault(
  prop: DbProperty,
  value: DbFilter['value'],
  cells: Record<string, unknown>
): boolean {
  if (typeof value !== 'string' || prop.id in cells) return false;
  return prop.defaultOptionId === value && optionIds(prop).has(value);
}

/**
 * Cellules à poser sur une ligne créée DANS cette vue, pour qu'elle y soit
 * visible (sinon on ajoute une ligne qu'on ne voit pas). `undefined` = effacer
 * la cellule (contrat de `newRow`), ce que demande un filtre « vide » — et
 * aussi un filtre NÉGATIF qui exclut justement la valeur par défaut du schéma.
 *
 * Seul `non vide` reste sans réponse, quelle que soit la famille : on ne peut
 * pas inventer un contenu à la place de l'utilisateur (poser d'office une
 * option de sélection serait un choix, pas un remplissage). La ligne existe
 * alors bel et bien, simplement masquée ici tant qu'elle est vide — le compteur
 * de lignes masquées de la barre de vues le dit.
 */
export function prefillCellsForView(
  view: DbView,
  properties: DbProperty[]
): Record<string, unknown> {
  const props = propertyIndex(properties);
  const cells: Record<string, unknown> = {};

  for (const f of view.filters) {
    const prop = props.get(f.propertyId);
    if (!prop || !isOpValidForType(prop.type, f.op)) continue;
    // Un agrégat ne s'écrit jamais (il se calcule) et on n'invente pas un lien
    // à la place de l'utilisateur : ces deux colonnes n'ont rien à pré-remplir.
    if (prop.type === 'rollup' || prop.type === 'relation') continue;

    if (f.op === 'isEmpty') {
      cells[prop.id] = undefined;
      continue;
    }
    if (f.op === 'isChecked') {
      cells[prop.id] = true;
      continue;
    }
    if (f.op === 'isUnchecked') {
      cells[prop.id] = undefined;
      continue;
    }
    if (f.op === 'isNotEmpty') continue;

    switch (filterFamily(prop.type)) {
      case 'text': {
        // « contient » et « égal » se satisfont du terme lui-même ;
        // « ne contient pas » l'est déjà par une cellule vide
        if ((f.op === 'contains' || f.op === 'equals') && typeof f.value === 'string') {
          const v = f.value.trim();
          if (v !== '') cells[prop.id] = v;
        }
        break;
      }
      case 'number': {
        const target = numberOf(f.value);
        if (target === null) break;
        let n: number | undefined;
        if (f.op === 'eq' || f.op === 'gte' || f.op === 'lte') n = target;
        else if (f.op === 'gt') n = target + 1;
        else if (f.op === 'lt') n = target - 1;
        // « ≠ » est déjà satisfait par une cellule vide
        if (n === undefined) break;
        if (prop.type === 'rating') n = Math.max(0, Math.min(5, Math.round(n)));
        if (prop.type === 'progress') n = Math.max(0, Math.min(100, n));
        cells[prop.id] = n;
        break;
      }
      case 'select':
        if (f.op === 'is' && typeof f.value === 'string' && optionIds(prop).has(f.value)) {
          cells[prop.id] = f.value;
        } else if (f.op === 'isNot' && excludesSchemaDefault(prop, f.value, cells)) {
          cells[prop.id] = undefined;
        }
        break;
      case 'multiSelect':
        if (f.op === 'contains' && typeof f.value === 'string' && optionIds(prop).has(f.value)) {
          cells[prop.id] = [f.value];
        } else if (f.op === 'notContains' && excludesSchemaDefault(prop, f.value, cells)) {
          cells[prop.id] = undefined;
        }
        break;
      case 'date': {
        // créé/modifié ne s'écrivent pas : ces colonnes sont posées par l'app
        if (prop.type !== 'date') break;
        if (typeof f.value !== 'string') break;
        const v =
          f.op === 'on'
            ? dayStamp(f.value) === null
              ? undefined
              : f.value.trim()
            : f.op === 'before'
              ? shiftDay(f.value, -1)
              : f.op === 'after'
                ? shiftDay(f.value, 1)
                : undefined;
        if (v !== undefined) cells[prop.id] = v;
        break;
      }
      default:
        break;
    }
  }

  return cells;
}

// ==================== Nom d'une vue et disposition ====================

/**
 * Les noms qu'une vue reçoit d'office, dans les deux langues de l'application
 * (« Kanban », puis « Kanban 2 » à l'ajout d'une vue). Écrits ici plutôt que
 * relus des traductions : la langue qui n'est pas à l'écran n'est pas chargée,
 * et une vue nommée en anglais doit se reconnaître dans une interface française.
 */
const DEFAULT_VIEW_NAMES: Record<DbViewType, readonly string[]> = {
  table: ['tableau', 'table'],
  board: ['kanban', 'board'],
  calendar: ['calendrier', 'calendar'],
  gallery: ['galerie', 'gallery'],
  chart: ['graphiques', 'graphique', 'charts', 'chart'],
  timeline: ['frise', 'timeline'],
  form: ['formulaire', 'form'],
  query: ['requête', 'requete', 'query'],
};

/**
 * Ce nom est-il un nom donné d'office, numéro compris ? Celui de N'IMPORTE
 * QUELLE disposition : une vue que l'ancien comportement a laissée « Tableau 2 »
 * alors qu'elle était devenue un kanban doit suivre au prochain changement.
 * `label` : le nom d'office dans la langue à l'écran, pour une langue que la
 * liste ne connaît pas encore.
 */
export function isDefaultViewName(name: string, label?: string): boolean {
  const base = name
    .trim()
    .replace(/\s+\d+$/, '')
    .toLocaleLowerCase();
  if (base === '') return true;
  return (
    Object.values(DEFAULT_VIEW_NAMES).some((names) => names.includes(base)) ||
    (label !== undefined && base === label.trim().toLocaleLowerCase())
  );
}

/**
 * Le nom d'une vue dont on change la disposition. Un nom donné D'OFFICE suit la
 * disposition : un « Tableau » devenu kanban ne s'appelle plus « Tableau ». Un
 * nom choisi (« Bugs ouverts ») reste. Numéroté comme à l'ajout d'une vue :
 * « Kanban 2 » quand il y a déjà un kanban.
 *
 * `label` : le nom d'office de la NOUVELLE disposition, `currentLabel` celui de
 * l'ancienne, tous deux dans la langue à l'écran.
 */
export function nameForLayout(
  view: DbView,
  type: DbViewType,
  views: readonly DbView[],
  label: string,
  currentLabel?: string
): string {
  if (type === view.type || !isDefaultViewName(view.name ?? '', currentLabel)) {
    return view.name;
  }
  const same = views.filter((v) => v.id !== view.id && v.type === type).length;
  return same === 0 ? label : `${label} ${same + 1}`;
}
