/**
 * Des colonnes de Filarr aux champs JSON de l'API locale, et retour.
 *
 * - Le NOM d'un champ suit la colonne (`Dernier contact` → `dernier_contact`). Il
 *   est posé à la première lecture et GARDÉ (dans l'état) : renommer une colonne
 *   dans Filarr ne casse pas les logiciels qui lisent l'ancien nom.
 * - La VALEUR suit le type : une sélection rend le libellé de l'option, une
 *   relation rend les identifiants bruts des lignes visées (contrat § 8), un
 *   agrégat est calculé par le moteur de Filarr, et vaut `null` quand sa base
 *   visée n'est pas ouverte à l'accès (il est alors signalé « non résolu »).
 */

import { relationIds } from '../core/dbCore';
import { evaluateFormula } from '../core/formulaEngine';
import { peopleOf } from '../core/people';
import { computeRollup, resolveRelation, type DbEnv } from '../core/relations';
import { vaultFileRef, type DbProperty, type DbRow, type PropertyType } from '../core/types';
import type { StateStore } from '../state';

export type JsonType = 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'string[]' | 'object';

export interface FieldDef {
  prop: DbProperty;
  /** Nom du champ JSON. */
  name: string;
  type: JsonType;
  /** Écrit par l'API (les colonnes calculées ne le sont pas). */
  writable: boolean;
  /** Valeurs permises (libellés des options). */
  options?: string[];
  /** Base visée par une relation (son `dbId`). */
  target?: string;
}

/** Noms réservés de l'objet ligne. */
export const RESERVED_FIELDS = new Set(['id', 'created_at', 'updated_at']);

/** Le nom d'un champ tiré du nom de la colonne : minuscules sans accents, `_` entre les mots. */
export function fieldSlug(name: string): string {
  const folded = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const slug = folded.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48).replace(/_+$/, '');
  if (slug === '') return 'champ';
  return /^[0-9]/.test(slug) ? `c_${slug}` : slug;
}

const TYPE_OF: Record<PropertyType, JsonType> = {
  text: 'string',
  url: 'string',
  email: 'string',
  phone: 'string',
  number: 'number',
  rating: 'number',
  progress: 'number',
  checkbox: 'boolean',
  select: 'string',
  multiSelect: 'string[]',
  date: 'date',
  createdTime: 'datetime',
  updatedTime: 'datetime',
  note: 'string',
  relation: 'string[]',
  rollup: 'number',
  formula: 'string',
  person: 'string[]',
  vaultFile: 'object',
};

const READ_ONLY: ReadonlySet<PropertyType> = new Set(['createdTime', 'updatedTime', 'rollup', 'formula']);

/** Les champs d'une base, noms gardés d'une lecture à l'autre. */
export function fieldsOf(state: StateStore, storeId: string, properties: readonly DbProperty[]): FieldDef[] {
  const saved = (state.data.fieldNames[storeId] ??= {});
  const taken = new Set<string>(RESERVED_FIELDS);
  for (const p of properties) if (saved[p.id]) taken.add(saved[p.id]!);
  let changed = false;
  const out: FieldDef[] = [];
  for (const prop of properties) {
    let name = saved[prop.id];
    if (!name) {
      const base = fieldSlug(prop.name);
      name = base;
      for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`;
      taken.add(name);
      saved[prop.id] = name;
      changed = true;
    }
    const isBacklink = prop.type === 'relation' && prop.direction === 'in';
    out.push({
      prop,
      name,
      type: TYPE_OF[prop.type] ?? 'string',
      writable: !READ_ONLY.has(prop.type) && !isBacklink,
      ...(prop.type === 'select' || prop.type === 'multiSelect' ? { options: (prop.options ?? []).map((o) => o.label) } : {}),
      ...(prop.type === 'relation' && prop.targetDbId ? { target: prop.targetDbId } : {}),
    });
  }
  if (changed) state.save();
  return out;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** La valeur JSON d'un champ ; `unresolved` reçoit le nom d'un champ dont la base visée n'est pas ouverte. */
export function fieldValue(field: FieldDef, row: DbRow, env: DbEnv, unresolved?: Set<string>): unknown {
  const { prop } = field;
  const raw = row.cells[prop.id];
  switch (prop.type) {
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
    case 'note':
      return str(raw);
    case 'number':
    case 'rating':
    case 'progress':
      return num(raw);
    case 'checkbox':
      return raw === true;
    case 'select':
      return typeof raw === 'string' ? (prop.options?.find((o) => o.id === raw)?.label ?? null) : null;
    case 'multiSelect': {
      const ids = Array.isArray(raw) ? raw : [];
      return ids.map((id) => prop.options?.find((o) => o.id === id)?.label).filter((l): l is string => typeof l === 'string');
    }
    case 'date':
      return str(raw);
    case 'createdTime':
      return row.createdAt ?? null;
    case 'updatedTime':
      return row.updatedAt ?? null;
    case 'person':
      return peopleOf(raw);
    case 'vaultFile':
      return vaultFileRef(raw);
    case 'relation': {
      if (prop.direction !== 'in') {
        // Identifiants BRUTS, que la base visée soit ouverte ou non (§ 8)
        if (prop.targetDbId && !env.ctx?.getDb(prop.targetDbId)) unresolved?.add(field.name);
        return relationIds(raw);
      }
      const res = resolveRelation(prop, row, env);
      if (res.status === 'ok') return res.ids;
      if (res.status === 'unavailable') unresolved?.add(field.name);
      return res.status === 'unavailable' ? null : [];
    }
    case 'rollup': {
      const res = computeRollup(prop, row, env);
      if (res.status === 'ok') return res.value;
      if (res.status === 'text') return res.text;
      if (res.status === 'unavailable') unresolved?.add(field.name);
      return null;
    }
    case 'formula': {
      const res = evaluateFormula(prop.formula ?? '', { properties: env.properties, row });
      return res.ok ? res.value : null;
    }
    default:
      return raw ?? null;
  }
}

/** Une ligne en objet JSON. */
export function rowJson(
  fields: readonly FieldDef[],
  row: DbRow,
  env: DbEnv,
  unresolved?: Set<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = { id: row.id };
  for (const f of fields) out[f.name] = fieldValue(f, row, env, unresolved);
  out.created_at = row.createdAt ?? null;
  out.updated_at = row.updatedAt ?? null;
  return out;
}

export class FieldError extends Error {
  constructor(
    readonly code: 'unknown_field' | 'field_read_only' | 'bad_value' | 'unknown_option',
    readonly field: string,
    message: string
  ) {
    super(message);
    this.name = 'FieldError';
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Une valeur JSON reçue, en valeur de cellule (`null` vide la cellule). */
export function cellFromJson(field: FieldDef, value: unknown): unknown {
  const { prop, name } = field;
  if (!field.writable) throw new FieldError('field_read_only', name, `Le champ ${name} est calculé : il ne s'écrit pas.`);
  if (value === null || value === undefined) return null;
  const bad = (what: string) => new FieldError('bad_value', name, `Le champ ${name} attend ${what}.`);
  switch (prop.type) {
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
    case 'note':
      if (typeof value !== 'string') throw bad('une chaîne');
      return value;
    case 'number':
    case 'rating':
    case 'progress':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad('un nombre');
      return value;
    case 'checkbox':
      if (typeof value !== 'boolean') throw bad('un booléen');
      return value;
    case 'date':
      if (typeof value !== 'string' || !DATE_RE.test(value) || !Number.isFinite(Date.parse(value))) throw bad('une date AAAA-MM-JJ');
      return value;
    case 'select': {
      if (typeof value !== 'string') throw bad('un libellé d’option');
      const opt = prop.options?.find((o) => o.label === value || o.id === value);
      if (!opt) throw new FieldError('unknown_option', name, `« ${value} » n'est pas une option de ${name} (${(prop.options ?? []).map((o) => o.label).join(', ')}).`);
      return opt.id;
    }
    case 'multiSelect': {
      if (!Array.isArray(value)) throw bad('une liste de libellés');
      return value.map((v) => {
        const opt = prop.options?.find((o) => o.label === v || o.id === v);
        if (!opt) throw new FieldError('unknown_option', name, `« ${String(v)} » n'est pas une option de ${name}.`);
        return opt.id;
      });
    }
    case 'relation': {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v !== '')) throw bad('une liste d’identifiants de lignes');
      const ids = relationIds(value);
      if (prop.single && ids.length > 1) throw bad('un seul identifiant (relation à lien unique)');
      return ids;
    }
    case 'person':
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw bad('une liste de noms');
      return value;
    case 'vaultFile':
      if (!vaultFileRef(value)) throw bad('{ fileId, folderId, name }');
      return value;
    default:
      return value;
  }
}
