// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/store/registers.ts @ 68abe8ff — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Les lignes du magasin : des REGISTRES « dernier écrit gagne », un par champ —
 * contrat `db-store-1`, § 4.
 *
 * Fusionner deux états, c'est garder pour chaque champ le registre à l'heure la
 * plus grande. L'opération est commutative, associative et idempotente : deux
 * appareils qui ont vu les mêmes écritures, dans n'importe quel ordre, ont le
 * même état. C'est ce qui remplace « un seul appareil élu enregistre » : chacun
 * valide, le serveur départage par compare-and-swap, et la fusion ne perd rien.
 *
 * Champs réservés (commencent par `#`) :
 *   `#c` création (ISO de `createdAt`), `#d` suppression (booléen),
 *   `#o` ordre manuel (index fractionnaire), `#p` page de la ligne,
 *   `#a` ligne parente (sous-élément),
 *   `#x.<clé>` toute autre clé de LIGNE inconnue de ce client, gardée telle quelle.
 * Tout autre champ est l'identifiant d'une propriété ; sa valeur est celle que
 * `cells` porte aujourd'hui.
 *
 * SUPPRIMER CONTRE MODIFIER (décision 1) : une ligne est supprimée dès que `#d`
 * vaut `true`, quelles que soient les heures de ses autres champs ; la restaurer
 * (`#d = false`, plus récent) la rend intacte, modifications concurrentes
 * comprises.
 *
 * CLÉS PIÉGÉES : les lignes arrivent d'autres appareils. Un identifiant
 * `__proto__` ou `constructor` lu par `rows[id] ?? (rows[id] = {})` remonterait
 * au prototype d'`Object`, et l'écriture suivante le polluerait pour toute
 * l'application (vérifié). D'où les seuls accès en propriété PROPRE, et le refus
 * de `__proto__` comme ligne ou comme champ.
 */

import type { DbRow } from '../../types';
import { canonicalJson } from './canonical';
import { hlcToIso, isHlc } from './hlc';

export const FIELD_CREATED = '#c';
export const FIELD_DELETED = '#d';
export const FIELD_ORDER = '#o';
export const FIELD_PAGE = '#p';
export const FIELD_PARENT = '#a';
/** Préfixe d'une clé de ligne inconnue (contrat § 4) : rien ne se perd au passage au magasin. */
export const FIELD_EXTRA = '#x.';

/** Les clés d'une ligne que ce client sait lire (les autres vont dans `#x.<clé>`). */
const KNOWN_ROW_KEYS = new Set(['id', 'cells', 'createdAt', 'updatedAt', 'parentId', 'pageNoteId']);

export interface Register {
  v: unknown;
  t: string;
}

/** Les registres d'UNE ligne, par champ. */
export type RowRegisters = Record<string, Register>;

/** Les lignes d'un magasin (ou d'un bloc), par identifiant. */
export type StoreRows = Record<string, RowRegisters>;

/** Une écriture : la ligne, le champ, la valeur (absente = vidée), l'heure. */
export interface StoreOp {
  r: string;
  f: string;
  v?: unknown;
  t: string;
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Un identifiant de ligne ou de champ utilisable comme clé sans toucher à un prototype. */
export const isSafeKey = (k: unknown): k is string =>
  typeof k === 'string' && k !== '' && k !== '__proto__';

/** Le registre PROPRE d'une ligne pour ce champ (jamais un héritage du prototype). */
export const ownRegister = (row: RowRegisters | undefined, field: string): Register | undefined =>
  row !== undefined && hasOwn(row, field) ? row[field] : undefined;

/** La ligne PROPRE d'un état. */
export const ownRow = (rows: StoreRows, id: string): RowRegisters | undefined =>
  hasOwn(rows, id) ? rows[id] : undefined;

/**
 * `a` l'emporte-t-il sur `b` ? L'heure la plus grande, en ordre de chaîne ; à
 * heure ÉGALE (un client fautif qui réutilise une heure), le JSON canonique le
 * plus grand (précision 3.1). L'ordre est total : la fusion ne dépend jamais de
 * l'ordre d'arrivée, et `#d = true` l'emporte sur `false` à la même heure.
 */
export const registerWins = (a: Register, b: Register | undefined): boolean =>
  b === undefined || a.t > b.t || (a.t === b.t && canonicalJson(a.v) > canonicalJson(b.v));

/** Applique une écriture ; vrai si l'état a changé. Une écriture plus ancienne est sans effet. */
export function applyOp(rows: StoreRows, op: StoreOp): boolean {
  if (!isHlc(op.t) || !isSafeKey(op.r) || !isSafeKey(op.f)) return false;
  const reg: Register = { v: op.v === undefined ? null : op.v, t: op.t };
  const row = ownRow(rows, op.r) ?? (rows[op.r] = {});
  if (!registerWins(reg, ownRegister(row, op.f))) return false;
  row[op.f] = reg;
  return true;
}

/** Fusion de deux lignes, champ par champ (nouvel objet). */
export function mergeRow(a: RowRegisters | undefined, b: RowRegisters | undefined): RowRegisters {
  const out: RowRegisters = {};
  for (const [field, reg] of Object.entries(a ?? {})) if (isSafeKey(field)) out[field] = reg;
  for (const [field, reg] of Object.entries(b ?? {})) {
    if (isSafeKey(field) && registerWins(reg, ownRegister(out, field))) out[field] = reg;
  }
  return out;
}

/** Fusion de deux états (nouvel objet ; `a` et `b` intacts). */
export function mergeRows(a: StoreRows, b: StoreRows): StoreRows {
  const out: StoreRows = {};
  for (const [id, row] of Object.entries(a)) if (isSafeKey(id)) out[id] = row;
  for (const [id, row] of Object.entries(b))
    if (isSafeKey(id)) out[id] = mergeRow(ownRow(out, id), row);
  return out;
}

/** Fusionne `b` DANS `a` ; renvoie les identifiants des lignes changées. */
export function mergeInto(a: StoreRows, b: StoreRows): string[] {
  const changed: string[] = [];
  for (const [id, row] of Object.entries(b)) {
    if (!isSafeKey(id)) continue;
    const target = ownRow(a, id) ?? (a[id] = {});
    let touched = false;
    for (const [field, reg] of Object.entries(row)) {
      if (isSafeKey(field) && registerWins(reg, ownRegister(target, field))) {
        target[field] = reg;
        touched = true;
      }
    }
    if (touched) changed.push(id);
  }
  return changed;
}

export function isDeleted(row: RowRegisters): boolean {
  return ownRegister(row, FIELD_DELETED)?.v === true;
}

/** La plus grande heure d'une ligne — son `updatedAt`. */
export function lastWrite(row: RowRegisters): string | null {
  let max: string | null = null;
  for (const reg of Object.values(row)) if (max === null || reg.t > max) max = reg.t;
  return max;
}

/**
 * Une ligne de magasin rendue sous la forme `DbRow` du moteur (et de toute
 * l'interface), ou `null` si elle est supprimée. Une valeur vidée (`null`)
 * n'apparaît pas dans `cells`, comme une cellule jamais remplie.
 */
export function materializeRow(id: string, row: RowRegisters): DbRow | null {
  if (isDeleted(row)) return null;
  const cells: Record<string, unknown> = {};
  for (const [field, reg] of Object.entries(row)) {
    if (field.startsWith('#') || !isSafeKey(field)) continue;
    if (reg.v !== null && reg.v !== undefined) cells[field] = reg.v;
  }
  const out: DbRow = { id, cells };
  const created = ownRegister(row, FIELD_CREATED)?.v;
  if (typeof created === 'string') out.createdAt = created;
  const last = lastWrite(row);
  const updated = last ? hlcToIso(last) : null;
  if (updated) out.updatedAt = updated;
  const page = ownRegister(row, FIELD_PAGE)?.v;
  if (typeof page === 'string' && page !== '') out.pageNoteId = page;
  const parent = ownRegister(row, FIELD_PARENT)?.v;
  if (typeof parent === 'string' && parent !== '') out.parentId = parent;
  for (const [field, reg] of Object.entries(row)) {
    if (!field.startsWith(FIELD_EXTRA)) continue;
    const key = field.slice(FIELD_EXTRA.length);
    if (isSafeKey(key) && !KNOWN_ROW_KEYS.has(key) && reg.v !== null && reg.v !== undefined) {
      (out as unknown as Record<string, unknown>)[key] = reg.v;
    }
  }
  return out;
}

/**
 * Les lignes VIVANTES d'un état, dans l'ordre manuel (`#o`, puis l'identifiant
 * pour départager deux positions égales — cas d'une fusion concurrente).
 */
export function materializeRows(rows: StoreRows): DbRow[] {
  const live: Array<{ row: DbRow; order: string }> = [];
  for (const [id, regs] of Object.entries(rows)) {
    if (!isSafeKey(id)) continue;
    const row = materializeRow(id, regs);
    if (!row) continue;
    const order = ownRegister(regs, FIELD_ORDER)?.v;
    live.push({ row, order: typeof order === 'string' ? order : '' });
  }
  live.sort((a, b) =>
    a.order < b.order
      ? -1
      : a.order > b.order
        ? 1
        : a.row.id < b.row.id
          ? -1
          : a.row.id > b.row.id
            ? 1
            : 0
  );
  return live.map((l) => l.row);
}

/**
 * L'écriture INVERSE d'une écriture — l'annulation (§ 9.5). Elle remet la
 * valeur d'avant, sous une heure NEUVE : annuler est une écriture comme une
 * autre, qui gagne contre l'écriture annulée et se propage pareil.
 */
export function inverseOp(before: RowRegisters | undefined, op: StoreOp, now: string): StoreOp {
  const previous = ownRegister(before, op.f);
  return { r: op.r, f: op.f, v: previous ? previous.v : null, t: now };
}

/**
 * Les registres d'une ligne EN LIGNE, pour la migration vers le magasin
 * (contrat § 10) : chaque champ reçoit l'heure `t` (tirée de `updatedAt`), la
 * création va dans `#c`, la position dans `#o`, la page dans `#p`, le parent
 * dans `#a`, et toute clé inconnue dans `#x.<clé>`.
 */
export function rowToRegisters(row: DbRow, t: string, order: string): RowRegisters {
  const out: RowRegisters = {};
  for (const [field, value] of Object.entries(row.cells ?? {})) {
    if (field.startsWith('#') || !isSafeKey(field)) continue; // un identifiant de propriété ne commence jamais par #
    if (value === undefined) continue;
    out[field] = { v: value, t };
  }
  if (typeof row.createdAt === 'string') out[FIELD_CREATED] = { v: row.createdAt, t };
  out[FIELD_ORDER] = { v: order, t };
  if (typeof row.pageNoteId === 'string' && row.pageNoteId !== '')
    out[FIELD_PAGE] = { v: row.pageNoteId, t };
  if (typeof row.parentId === 'string' && row.parentId !== '')
    out[FIELD_PARENT] = { v: row.parentId, t };
  for (const [key, value] of Object.entries(row as unknown as Record<string, unknown>)) {
    if (KNOWN_ROW_KEYS.has(key) || !isSafeKey(key) || value === undefined) continue;
    out[FIELD_EXTRA + key] = { v: value, t };
  }
  return out;
}
