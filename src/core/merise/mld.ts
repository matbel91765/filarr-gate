// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/merise/mld.ts @ 912fd390 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Du MCD au MLD (modèle logique) — logique PURE.
 *
 * Les règles de passage classiques de Merise :
 *  - une entité devient une TABLE, son identifiant sa clé primaire (`id`) ;
 *  - une association « 0,1 — 0,n » devient une CLÉ ÉTRANGÈRE du côté 0,1 ;
 *  - une association « 0,n — 0,n » devient une TABLE DE JOINTURE dont la clé
 *    primaire réunit les deux clés étrangères.
 *
 * Les colonnes calculées (formules, agrégats) ne deviennent pas des colonnes :
 * elles ne se stockent pas, elles se dérivent — le MLD le dit en commentaire.
 */

import type { PropertyType } from '../types';
import type { Mcd, McdAssociation } from './mcd';

export interface MldColumn {
  name: string;
  /** `id` : clé primaire d'une table d'entité ; `fk` : clé étrangère */
  kind: 'pk' | 'attr' | 'fk';
  /** Type Filarr d'une colonne d'attribut */
  type?: PropertyType;
  /** Clé étrangère : la table visée (toujours sur sa colonne `id`) */
  references?: string;
  /** Fait partie de la clé primaire (table de jointure) */
  primary?: boolean;
  /** La colonne Filarr d'origine (attribut, ou relation d'une clé étrangère) */
  propertyId?: string;
}

export interface MldTable {
  name: string;
  /** La base d'origine ; absente pour une table de jointure */
  entity?: string;
  /** Association d'origine d'une table de jointure */
  association?: string;
  columns: MldColumn[];
  /** Colonnes calculées laissées de côté, pour le commentaire */
  computed: string[];
  /** Base introuvable : table réduite à son identifiant */
  missing?: boolean;
}

/** Un identifiant SQL lisible : minuscules sans accents, `_` entre les mots, jamais vide ni chiffré en tête. */
export function sqlName(label: string, fallback: string): string {
  const base = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (base === '') return fallback;
  return /^[0-9]/.test(base) ? `${fallback}_${base}` : base;
}

function unique(name: string, used: Set<string>): string {
  let out = name;
  for (let n = 2; used.has(out); n += 1) out = `${name}_${n}`;
  used.add(out);
  return out;
}

const maxIsOne = (card: string): boolean => card.endsWith(',1');

/** Le MLD d'un MCD. */
export function buildMld(mcd: Mcd): MldTable[] {
  const tableNames = new Set<string>();
  const tableOf = new Map<string, MldTable>();
  const columnsUsed = new Map<string, Set<string>>();

  for (const entity of mcd.entities) {
    const name = unique(sqlName(entity.name, 'base'), tableNames);
    const used = new Set<string>(['id']);
    const table: MldTable = {
      name,
      entity: entity.id,
      columns: [{ name: 'id', kind: 'pk' }],
      computed: [],
      ...(entity.missing ? { missing: true } : {}),
    };
    for (const attr of entity.attributes) {
      if (attr.computed) {
        table.computed.push(attr.name);
        continue;
      }
      table.columns.push({
        name: unique(sqlName(attr.name, 'colonne'), used),
        kind: 'attr',
        type: attr.type,
        propertyId: attr.id,
      });
    }
    tableOf.set(entity.id, table);
    columnsUsed.set(entity.id, used);
  }

  const junctions: MldTable[] = [];
  for (const assoc of mcd.associations) {
    const [a, b] = assoc.legs;
    const ta = tableOf.get(a.entity);
    const tb = tableOf.get(b.entity);
    if (!ta || !tb) continue;
    if (maxIsOne(a.card) || maxIsOne(b.card)) {
      // Clé étrangère du côté « au plus un »
      const [holder, target, leg] = maxIsOne(a.card) ? [ta, tb, a] : [tb, ta, b];
      const used = columnsUsed.get(leg.entity) ?? new Set<string>();
      holder.columns.push({
        name: unique(`${sqlName(assoc.name, target.name)}_id`, used),
        kind: 'fk',
        references: target.name,
        ...(leg.via ? { propertyId: leg.via } : {}),
      });
      continue;
    }
    junctions.push(junctionTable(assoc, ta.name, tb.name, tableNames));
  }
  return [...tableOf.values(), ...junctions];
}

function junctionTable(
  assoc: McdAssociation,
  ta: string,
  tb: string,
  tableNames: Set<string>
): MldTable {
  const preferred = sqlName(assoc.name, `${ta}_${tb}`);
  // Une association nommée comme une table d'entité (« Client » → `client`) se
  // distingue par les deux tables qu'elle relie
  const name = unique(tableNames.has(preferred) ? `${ta}_${tb}` : preferred, tableNames);
  const used = new Set<string>();
  const first = unique(`${ta}_id`, used);
  // Une association réflexive (une base reliée à elle-même) nomme son second
  // côté d'après l'association : « parent_id » plutôt que « tache_id_2 »
  const secondBase = ta === tb ? `${sqlName(assoc.name, ta)}_id` : `${tb}_id`;
  const second = unique(secondBase, used);
  return {
    name,
    association: assoc.id,
    columns: [
      {
        name: first,
        kind: 'fk',
        references: ta,
        primary: true,
        ...(assoc.legs[0].via ? { propertyId: assoc.legs[0].via } : {}),
      },
      {
        name: second,
        kind: 'fk',
        references: tb,
        primary: true,
        ...(assoc.legs[1].via ? { propertyId: assoc.legs[1].via } : {}),
      },
    ],
    computed: [],
  };
}

/**
 * Notation Merise d'une table : `Commande (id, date, #client_id)`. La clé
 * primaire est rendue SOULIGNÉE par l'appelant (`primary` des morceaux).
 */
export function mldNotation(table: MldTable): {
  name: string;
  parts: Array<{ text: string; primary: boolean; foreign: boolean }>;
} {
  return {
    name: table.name,
    parts: table.columns.map((c) => ({
      text: c.kind === 'fk' ? `#${c.name}` : c.name,
      primary: c.kind === 'pk' || c.primary === true,
      foreign: c.kind === 'fk',
    })),
  };
}
