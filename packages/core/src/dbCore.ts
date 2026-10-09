// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/dbCore.ts @ e3502763 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * LE CŒUR PUR DES BASES — ce que les modules sans interface (moteur SQL, schéma
 * Merise, import d'une base SQL, graphe des lignes) prennent du modèle, SANS
 * i18n ni stockage : le mobile les recopie ainsi tels quels, au JS émis
 * identique (contrat de la vue Requête, § 5). `types.ts` réexporte tout.
 *
 * Seuls des types viennent de `types.ts` (effacés à la compilation) : aucun
 * cycle à l'exécution.
 */

import type {
  DbProperty,
  DbRow,
  DbSelectOption,
  DbView,
  DbViewType,
  InlineDbData,
  PropertyType,
} from './types';

/**
 * Un texte traduit : clé, repli anglais, valeurs (la signature de `t` d'i18next).
 * Le cœur pur ne lit jamais i18n : chaque surface passe le sien (contrats
 * `inline-database-harvest` et `inline-database-create`).
 */
export type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

/** Même mécanisme d'ID que les events du calendarBlock */
export function newId(): string {
  return `db-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Identifiants de lignes portés par une cellule relation (dédoublonnés) */
export function relationIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== 'string' || v === '' || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

const TEINTES_VIVES = [
  'blue',
  'green',
  'amber',
  'purple',
  'teal',
  'pink',
  'orange',
  'red',
  'cyan',
  'lime',
  'indigo',
  'rose',
  'emerald',
  'sky',
  'violet',
  'fuchsia',
  'yellow',
];

export function nextOptionColor(options: DbSelectOption[] | undefined): string {
  const prises = new Set((options ?? []).map((o) => o.color));
  return (
    TEINTES_VIVES.find((c) => !prises.has(c)) ??
    TEINTES_VIVES[(options ?? []).length % TEINTES_VIVES.length]!
  );
}

/**
 * Vue neuve, sous le nom qu'on lui donne (déjà traduit par l'appelant) : aucun
 * filtre ni tri, `groupBy` porté seulement par les vues board. `id` : celui de
 * l'appelant (identifiants injectés, contrat `inline-database-create`), sinon tiré.
 */
export function makeNamedView(
  name: string,
  type: DbViewType = 'table',
  groupBy?: string,
  id: string = newId()
): DbView {
  return {
    id,
    name,
    type,
    filters: [],
    sorts: [],
    ...(groupBy ? { groupBy } : {}),
  };
}

/**
 * Nom d'une disposition de vue : clé et repli anglais. UNE seule table pour tout
 * le code (contrat `inline-database-create`, § 1) ; cherchée par une chaîne, pour
 * qu'un `DbViewType` plus court d'une surface ne casse pas la compilation.
 */
export const LAYOUT_NAMES: Readonly<Record<string, readonly [string, string]>> = {
  table: ['notes.inlineDb.table', 'Table'],
  board: ['notes.inlineDb.board', 'Board'],
  calendar: ['notes.inlineDb.calendar', 'Calendar'],
  gallery: ['notes.inlineDb.gallery', 'Gallery'],
  chart: ['notes.inlineDb.chart', 'Chart'],
  timeline: ['notes.inlineDb.timeline', 'Timeline'],
  form: ['notes.inlineDb.form', 'Form'],
  query: ['notes.inlineDb.query', 'Query'],
};

/** Nom d'une vue d'après sa disposition (« Kanban », « Calendrier »…) ; inconnue : son type tel quel. */
export function layoutLabel(type: string, translate: Translate): string {
  const entry = LAYOUT_NAMES[type];
  return entry ? translate(entry[0], entry[1]) : type;
}

/**
 * Cellules d'office d'une nouvelle ligne : une par propriété select/multiSelect
 * dont le defaultOptionId pointe sur une option qui existe encore.
 */
export function defaultCells(properties: DbProperty[]): Record<string, unknown> {
  const cells: Record<string, unknown> = {};
  for (const p of properties) {
    if (p.type !== 'select' && p.type !== 'multiSelect') continue;
    const id = p.defaultOptionId;
    if (!id || !(p.options ?? []).some((o) => o.id === id)) continue;
    cells[p.id] = p.type === 'select' ? id : [id];
  }
  return cells;
}

/**
 * Ligne neuve, identifiant et heure INJECTÉS : `createdAt` posé ici, jamais au
 * montage. `overrides` a le dernier mot sur les défauts du schéma ; une valeur
 * `undefined` y signifie « laisse vide ».
 */
export function makeRow(
  properties: DbProperty[],
  overrides: Record<string, unknown>,
  ids: () => string,
  now: Date
): DbRow {
  const cells = defaultCells(properties);
  for (const [propId, value] of Object.entries(overrides)) {
    if (value === undefined) delete cells[propId];
    else cells[propId] = value;
  }
  return { id: ids(), cells, createdAt: now.toISOString() };
}

/**
 * Écriture — et la seule place qui sait rendre son type à un client plus récent.
 *
 * Une colonne dont le type nous était inconnu a été affichée en « texte », mais
 * son type d'origine attend dans `unknownType` : on le remet dans `type` ici, et
 * on efface la mémoire pour qu'elle ne sorte jamais dans le document. Le
 * document réécrit est donc IDENTIQUE à celui qu'on a lu sur ce point — c'est la
 * seule façon de protéger l'appareil d'en face, qui ne regarde que `type` et
 * n'a aucune raison de connaître nos champs de travail.
 */
export function serializeDbData(data: InlineDbData): string {
  const properties = data.properties.map((p) => {
    if (!p.unknownType) return p;
    const { unknownType, ...reste } = p;
    return { ...reste, type: unknownType as PropertyType };
  });
  // Même promesse un cran plus haut, pour les VUES : le type qu'on ne savait
  // pas peindre repart tel quel, et ses réglages avec lui. Les nôtres passent
  // par-dessus — quelqu'un a pu renommer ou filtrer la vue entre-temps.
  const views = data.views?.map((v) => {
    if (!v.unknownType && !v.unknownFields) return v;
    const { unknownType, unknownFields, ...reste } = v;
    return {
      ...unknownFields,
      ...reste,
      ...(unknownType ? { type: unknownType as DbViewType } : {}),
    };
  });
  /*
    ⚠ CE QUI N'EST **PAS** FAIT ICI, ET POURQUOI.

    L'invariant « une base adossée ne persiste pas ses lignes » a d'abord été
    posé à cet endroit — c'est le passage obligé de toute écriture, donc le plus
    tentant. Le témoin partagé avec le mobile est tombé dans la minute, et il
    avait raison : ce serait une transformation DESTRUCTRICE appliquée à
    l'aveugle sur la foi d'un seul champ. Un `folderSource` posé par erreur, ou
    recopié par un collage, effacerait TOUTES les lignes d'une base ordinaire —
    en silence, et sans retour possible.

    L'invariant vit donc là où le rattachement est CONNU : le chemin de commit
    de la base adossée, qui sait qu'il vient de dériver ses lignes du coffre. Il
    décrit ce que nous ÉCRIVONS, pas une correction imposée à ce que nous
    lisons.
  */
  return JSON.stringify({ ...data, properties, ...(views ? { views } : {}) });
}
