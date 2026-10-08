// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/merise/mcd.ts @ 912fd390 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Le schéma des bases à la manière de Merise : le MCD — logique PURE.
 *
 * Une ENTITÉ par base, ses colonnes pour propriétés ; une ASSOCIATION par
 * relation, appariée avec son rétrolien quand il existe (une relation et son
 * envers sont UNE association, vue des deux côtés), avec ses cardinalités.
 *
 * Rien n'est écrit : le schéma se DÉDUIT des bases telles qu'elles sont. Une
 * base visée mais introuvable (note pas encore chargée, base supprimée) reste
 * une entité, marquée — une relation ne disparaît pas du schéma parce que sa
 * cible manque, sinon le schéma mentirait sur ce que la base contient.
 *
 * ── LES CARDINALITÉS ────────────────────────────────────────────────────────
 *
 * Sur la patte entre une entité E et une association R : combien de fois une
 * ligne de E participe à R, au minimum et au maximum. Filarr n'impose jamais de
 * lien obligatoire, donc le minimum vaut toujours 0. Le maximum vient de la
 * relation : « une seule ligne liée » → 0,1 ; sinon 0,n. Du côté visé, rien ne
 * borne le nombre de lignes qui pointent vers une même ligne : 0,n.
 */

import type { InlineDbIndexEntry } from '../dbIndex';
import type { PropertyType } from '../types';

export type Cardinality = '0,1' | '0,n' | '1,1' | '1,n';

export interface McdAttribute {
  id: string;
  name: string;
  type: PropertyType;
  /** Se calcule à partir d'autres colonnes (formule, agrégat) : rien n'est stocké */
  computed: boolean;
  /** Posée par l'application (date de création, de modification) : stockée, jamais saisie */
  auto: boolean;
}

export interface McdEntity {
  /** L'identité de la base (`dbId`) */
  id: string;
  name: string;
  noteId: string;
  noteTitle: string;
  attributes: McdAttribute[];
  rowCount: number;
  /** Visée par une relation, mais absente de l'index */
  missing?: boolean;
  /** Base adossée à un dossier : ses lignes sont des fichiers */
  folder?: boolean;
}

export interface McdLeg {
  entity: string;
  card: Cardinality;
  /** La colonne Relation qui porte ce côté de l'association, s'il y en a une */
  via?: string;
}

export interface McdAssociation {
  /** `<base source>:<colonne relation>` — stable d'un rendu à l'autre */
  id: string;
  name: string;
  legs: [McdLeg, McdLeg];
}

export interface Mcd {
  entities: McdEntity[];
  associations: McdAssociation[];
}

const COMPUTED: ReadonlySet<PropertyType> = new Set<PropertyType>(['formula', 'rollup']);
const AUTO: ReadonlySet<PropertyType> = new Set<PropertyType>(['createdTime', 'updatedTime']);

const byName = <T extends { name: string; id: string }>(a: T, b: T): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

/** Le MCD des bases données. `missingName` : le nom d'une base introuvable, dans la langue de l'appelant. */
export function buildMcd(
  entries: readonly InlineDbIndexEntry[],
  missingName = 'Base introuvable'
): Mcd {
  const entities = new Map<string, McdEntity>();
  for (const entry of entries) {
    entities.set(entry.dbId, {
      id: entry.dbId,
      name: entry.title,
      noteId: entry.noteId,
      noteTitle: entry.noteTitle,
      attributes: entry.properties
        .filter((p) => p.type !== 'relation')
        .map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          computed: COMPUTED.has(p.type),
          auto: AUTO.has(p.type),
        })),
      rowCount: entry.rows.length,
      ...(entry.folderSource ? { folder: true } : {}),
    });
  }

  const ensure = (dbId: string): void => {
    if (entities.has(dbId)) return;
    entities.set(dbId, {
      id: dbId,
      name: missingName,
      noteId: '',
      noteTitle: '',
      attributes: [],
      rowCount: 0,
      missing: true,
    });
  };

  const associations = new Map<string, McdAssociation>();
  // Les relations SORTANTES d'abord : ce sont elles qui fondent l'association
  for (const entry of entries) {
    for (const p of entry.properties) {
      if (p.type !== 'relation' || p.direction === 'in' || !p.targetDbId) continue;
      ensure(p.targetDbId);
      associations.set(`${entry.dbId}:${p.id}`, {
        id: `${entry.dbId}:${p.id}`,
        name: p.name,
        legs: [
          { entity: entry.dbId, card: p.single ? '0,1' : '0,n', via: p.id },
          { entity: p.targetDbId, card: '0,n' },
        ],
      });
    }
  }
  // Puis les rétroliens : l'envers d'une association déjà là, ou seuls quand
  // leur source manque (la base source n'est pas dans l'index)
  for (const entry of entries) {
    for (const p of entry.properties) {
      if (p.type !== 'relation' || p.direction !== 'in' || !p.targetDbId) continue;
      const key = `${p.targetDbId}:${p.sourcePropertyId ?? ''}`;
      const found = associations.get(key);
      if (found && found.legs[1].entity === entry.dbId && found.legs[1].via === undefined) {
        found.legs[1] = { ...found.legs[1], via: p.id };
        continue;
      }
      if (found) continue;
      ensure(p.targetDbId);
      associations.set(key, {
        id: key,
        name: p.name,
        legs: [
          { entity: p.targetDbId, card: '0,n' },
          { entity: entry.dbId, card: '0,n', via: p.id },
        ],
      });
    }
  }

  return {
    entities: [...entities.values()].sort(byName),
    associations: [...associations.values()].sort(byName),
  };
}

/** Le voisinage d'une base : elle, les bases qu'elle relie, et leurs associations. */
export function mcdAround(mcd: Mcd, dbIds: ReadonlySet<string>): Mcd {
  const associations = mcd.associations.filter((a) => a.legs.some((leg) => dbIds.has(leg.entity)));
  const keep = new Set(dbIds);
  for (const a of associations) for (const leg of a.legs) keep.add(leg.entity);
  return { entities: mcd.entities.filter((e) => keep.has(e.id)), associations };
}
