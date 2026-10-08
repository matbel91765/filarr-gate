// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/table.ts @ 50743c75 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * La base, rangée en COLONNES TYPÉES — le stockage du moteur maison.
 *
 * Une colonne par propriété, construite à la première demande (une vue n'en
 * touche que quelques-unes), puis gardée tant que les données ne changent pas :
 * la table vit exactement aussi longtemps que l'objet `InlineDbData` dont elle
 * est tirée (`tableFor`, `WeakMap`). Rien n'est recopié de la ligne qu'on ne
 * lise ensuite : les objets ligne d'origine restent la seule source, et seule la
 * fenêtre affichée en ressort (`view.ts`).
 *
 * Les encodages, et pourquoi ceux-là :
 *  · nombres, jours, horodatages, agrégats → `Float64Array`, `NaN` = vide ;
 *  · case à cocher → `Uint8Array` (cochée = 1) ;
 *  · choix → `Uint16Array`/`Uint32Array` : 0 = aucun, sinon RANG + 1 de l'option
 *    dans le schéma (le rang est l'ordre de tri des choix) ;
 *  · choix multiples → CSR : décalages + codes des options CONNUES, et le plus
 *    petit rang par ligne (la clé de tri) ;
 *  · texte et assimilés → DICTIONNAIRE : un code par ligne, les valeurs
 *    distinctes une seule fois. Un filtre « contient » s'évalue alors une fois
 *    par valeur distincte, pas une fois par ligne ;
 *  · relations → dictionnaire des titres liés, avec un code pour « cible
 *    inconnue » (rien à comparer : le filtre est inerte).
 *
 * La SÉMANTIQUE de chaque lecture est celle de `viewEngine`, qui fait foi — elle
 * est recopiée ici et vérifiée ligne à ligne par le test différentiel.
 */

import type { DbProperty, DbRow, InlineDbData } from '../types';
import type { DbEnv, DbLinkContext } from '../relations';
import { relationText, rollupNumber } from '../relations';
import { cellValueFor, dayStamp, fullStamp, numberOf, optionIds, textOf } from '../cellValues';
import { isEmptyCell } from '../viewEngine';
import { certifiedRanks } from './collation';

export interface NumberColumn {
  kind: 'number';
  values: Float64Array;
}

export interface BoolColumn {
  kind: 'bool';
  values: Uint8Array;
}

export interface DayColumn {
  kind: 'day';
  /** Jour civil (ms du minuit local, `dayStamp`), `NaN` = vide. */
  day: Float64Array;
}

export interface TimeColumn {
  kind: 'time';
  /** Jour civil de l'horodatage (filtres de la famille date). */
  day: Float64Array;
  /** Horodatage complet (tri : deux modifications du même jour se départagent). */
  full: Float64Array;
}

export interface SelectColumn {
  kind: 'select';
  /** 0 = aucune option connue ; sinon rang + 1. */
  codes: Uint16Array | Uint32Array;
  /** id d'option → code. */
  codeOf: Map<string, number>;
}

export interface MultiColumn {
  kind: 'multi';
  offsets: Uint32Array;
  /** Codes (rang + 1) des options CONNUES, dans l'ordre de la cellule. */
  codes: Uint32Array;
  /** Plus petit rang porté, −1 = aucun (vide). */
  minRank: Int32Array;
  codeOf: Map<string, number>;
}

export interface TextColumn {
  kind: 'text';
  /** Code de dictionnaire par ligne ; 0 = texte vide. */
  codes: Uint32Array;
  /** Valeurs distinctes (`textOf`), l'entrée 0 est la chaîne vide. */
  dict: string[];
}

export interface RelationColumn {
  kind: 'relation';
  /** 0 = cible inconnue (`relationText` nul) ; sinon code de dictionnaire. */
  codes: Uint32Array;
  /** L'entrée 0 n'est jamais lue ; l'entrée 1 est la chaîne vide. */
  dict: string[];
}

export interface RollupColumn {
  kind: 'rollup';
  values: Float64Array;
}

export type Column =
  | NumberColumn
  | BoolColumn
  | DayColumn
  | TimeColumn
  | SelectColumn
  | MultiColumn
  | TextColumn
  | RelationColumn
  | RollupColumn;

export class EngineTable {
  readonly n: number;
  readonly rows: DbRow[];
  readonly properties: DbProperty[];
  /** Même règle que `viewEngine.propertyIndex` : la dernière propriété d'un id l'emporte. */
  readonly props: Map<string, DbProperty>;
  readonly env: DbEnv;
  private readonly columns = new Map<string, Column>();
  private readonly empties = new Map<string, Uint8Array>();
  private readonly collations = new Map<string, { rank: Int32Array; d: number }>();
  /** Jours déjà analysés, par chaîne brute — le temps de vie de la table. */
  private readonly days = new Map<string, number | null>();

  constructor(data: InlineDbData, ctx?: DbLinkContext | null) {
    this.rows = data.rows;
    this.n = data.rows.length;
    this.properties = data.properties;
    this.props = new Map(data.properties.map((p) => [p.id, p]));
    this.env = { properties: data.properties, ...(ctx ? { ctx } : {}) };
  }

  /** La colonne d'une propriété, construite à la première demande. */
  column(prop: DbProperty): Column {
    let col = this.columns.get(prop.id);
    if (!col) {
      col = this.build(prop);
      this.columns.set(prop.id, col);
    }
    return col;
  }

  /**
   * Rangs de collation de TOUTES les valeurs d'une colonne de texte (ou de
   * relation), calculés une fois par table : un tri suivant, une autre vue, une
   * recherche qui restreint la sélection les relisent sans rappeler le
   * collateur. Le texte vide (et la cible inconnue d'une relation) n'a pas de
   * rang (−1) : c'est un vide.
   */
  collation(prop: DbProperty): { rank: Int32Array; d: number } {
    let ranks = this.collations.get(prop.id);
    if (!ranks) {
      const col = this.column(prop);
      if (col.kind !== 'text' && col.kind !== 'relation') {
        ranks = { rank: new Int32Array(0), d: 0 };
      } else {
        const first = col.kind === 'relation' ? 2 : 1;
        const values = col.dict.slice(first);
        const certified = certifiedRanks(values);
        const rankOf = new Map<string, number>();
        certified.order.forEach((v, i) => rankOf.set(v, certified.ranks[i]));
        const rank = new Int32Array(col.dict.length).fill(-1);
        for (let c = first; c < col.dict.length; c += 1)
          rank[c] = rankOf.get(col.dict[c]) as number;
        ranks = { rank, d: certified.d };
      }
      this.collations.set(prop.id, ranks);
    }
    return ranks;
  }

  /** « Vide » au sens de `viewEngine.isEmptyCell`, par ligne (1 = vide). */
  empty(prop: DbProperty): Uint8Array {
    let mask = this.empties.get(prop.id);
    if (!mask) {
      mask = new Uint8Array(this.n);
      for (let i = 0; i < this.n; i += 1) {
        mask[i] = isEmptyCell(prop, this.rows[i], this.env) ? 1 : 0;
      }
      this.empties.set(prop.id, mask);
    }
    return mask;
  }

  private dayOf(value: unknown): number {
    if (typeof value !== 'string') return NaN;
    let day = this.days.get(value);
    if (day === undefined) {
      day = dayStamp(value);
      this.days.set(value, day);
    }
    return day === null ? NaN : day;
  }

  private build(prop: DbProperty): Column {
    const { n, rows } = this;
    switch (prop.type) {
      case 'number':
      case 'rating':
      case 'progress': {
        const values = new Float64Array(n);
        for (let i = 0; i < n; i += 1) {
          const v = numberOf(cellValueFor(prop, rows[i]));
          values[i] = v === null ? NaN : v;
        }
        return { kind: 'number', values };
      }
      case 'checkbox': {
        const values = new Uint8Array(n);
        for (let i = 0; i < n; i += 1) values[i] = cellValueFor(prop, rows[i]) === true ? 1 : 0;
        return { kind: 'bool', values };
      }
      case 'date': {
        const day = new Float64Array(n);
        for (let i = 0; i < n; i += 1) day[i] = this.dayOf(cellValueFor(prop, rows[i]));
        return { kind: 'day', day };
      }
      case 'createdTime':
      case 'updatedTime': {
        const day = new Float64Array(n);
        const full = new Float64Array(n);
        for (let i = 0; i < n; i += 1) {
          const value = cellValueFor(prop, rows[i]);
          day[i] = this.dayOf(value);
          const t = fullStamp(value);
          full[i] = t === null ? NaN : t;
        }
        return { kind: 'time', day, full };
      }
      case 'select': {
        const codeOf = optionCodes(prop);
        const codes = codeOf.size < 65535 ? new Uint16Array(n) : new Uint32Array(n);
        for (let i = 0; i < n; i += 1) {
          const value = cellValueFor(prop, rows[i]);
          codes[i] = typeof value === 'string' ? (codeOf.get(value) ?? 0) : 0;
        }
        return { kind: 'select', codes, codeOf };
      }
      case 'multiSelect': {
        const codeOf = optionCodes(prop);
        const known = optionIds(prop);
        const offsets = new Uint32Array(n + 1);
        const minRank = new Int32Array(n);
        const flat: number[] = [];
        for (let i = 0; i < n; i += 1) {
          offsets[i] = flat.length;
          const value = cellValueFor(prop, rows[i]);
          let min = -1;
          if (Array.isArray(value)) {
            for (const x of value) {
              // `selectedOptionIds` : les seules chaînes qui sont des options connues
              if (typeof x !== 'string' || !known.has(x)) continue;
              const code = codeOf.get(x) as number;
              flat.push(code);
              if (min === -1 || code - 1 < min) min = code - 1;
            }
          }
          minRank[i] = min;
        }
        offsets[n] = flat.length;
        return { kind: 'multi', offsets, codes: Uint32Array.from(flat), minRank, codeOf };
      }
      case 'relation': {
        const codes = new Uint32Array(n);
        const dict: string[] = ['', ''];
        const codeOf = new Map<string, number>([['', 1]]);
        for (let i = 0; i < n; i += 1) {
          const text = relationText(prop, rows[i], this.env);
          if (text === null) continue; // code 0 : cible inconnue
          let code = codeOf.get(text);
          if (code === undefined) {
            code = dict.length;
            dict.push(text);
            codeOf.set(text, code);
          }
          codes[i] = code;
        }
        return { kind: 'relation', codes, dict };
      }
      case 'rollup': {
        const values = new Float64Array(n);
        for (let i = 0; i < n; i += 1) {
          const v = rollupNumber(prop, rows[i], this.env);
          values[i] = v === null ? NaN : v;
        }
        return { kind: 'rollup', values };
      }
      default: {
        // texte, adresse, courriel, téléphone, personne, et tout ce qui se lit
        // comme du texte (lien de note, fichier, formule, type inconnu)
        const codes = new Uint32Array(n);
        const dict: string[] = [''];
        const codeOf = new Map<string, number>([['', 0]]);
        for (let i = 0; i < n; i += 1) {
          const text = textOf(cellValueFor(prop, rows[i]));
          let code = codeOf.get(text);
          if (code === undefined) {
            code = dict.length;
            dict.push(text);
            codeOf.set(text, code);
          }
          codes[i] = code;
        }
        return { kind: 'text', codes, dict };
      }
    }
  }
}

/** id d'option → rang + 1, la PREMIÈRE occurrence d'un id fait foi (`findIndex`). */
function optionCodes(prop: DbProperty): Map<string, number> {
  const codes = new Map<string, number>();
  (prop.options ?? []).forEach((o, i) => {
    if (!codes.has(o.id)) codes.set(o.id, i + 1);
  });
  return codes;
}

const tables = new WeakMap<InlineDbData, { ctx: DbLinkContext | null; table: EngineTable }>();

/**
 * La table d'une base, gardée tant que l'objet de données ET le contexte de
 * liaison sont les mêmes (une relation lit les bases visées : un autre contexte
 * peut rendre d'autres titres).
 */
export function tableFor(data: InlineDbData, ctx?: DbLinkContext | null): EngineTable {
  const key = ctx ?? null;
  const cached = tables.get(data);
  if (cached && cached.ctx === key) return cached.table;
  const table = new EngineTable(data, key);
  tables.set(data, { ctx: key, table });
  return table;
}
