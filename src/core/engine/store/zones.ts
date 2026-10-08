// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/store/zones.ts @ dc68193f — relicencié Apache-2.0 par le titulaire des droits.
/**
 * L'INDEX DE ZONE DE LA TÊTE — contrat `db-store-1`, précision 3.8 (§ 6 bis).
 *
 * Pour chaque bloc, un résumé de ses lignes VIVANTES : combien, l'étendue de
 * l'ordre manuel (`#o`), et, par propriété triable, les bornes de ce que le
 * moteur trie (nombres, dates, cases, options). La tête est scellée : le serveur
 * n'en voit rien.
 *
 * À quoi il sert : sur un appareil qui n'a rien en cache, télécharger d'abord les
 * blocs qui peuvent porter la première page d'une vue triée, et PROUVER, avant
 * d'avoir tout reçu, que les premières lignes sont bien à leur place — une ligne
 * chargée est prouvée quand aucun bloc encore absent ne peut contenir une ligne
 * qui la précède. Jamais à retirer une ligne de l'état, jamais à décider d'une
 * écriture.
 *
 * Les blocs sont placés par HACHAGE de l'identifiant de ligne : chaque bloc est un
 * échantillon du tout, et ses bornes couvrent presque toute l'étendue. Ce qui
 * rend l'index utile n'est donc pas d'écarter des blocs, mais de savoir lesquels
 * portent les k premières lignes : ceux dont la borne basse est sous la k-ième
 * valeur — à peu près k blocs, quelle que soit la taille de la base.
 *
 * Cœur PUR, recopié tel quel par le mobile : aucune fonction importée hors de ce
 * dossier, aucune dépendance au fuseau du rédacteur (une date `AAAA-MM-JJ` compte
 * pour son minuit UTC ; le LECTEUR élargit les bornes de dates de quelques jours,
 * voir `READ_MARGIN_*`).
 */

import type { DbProperty } from '../../types';
import { canonicalJson, codeUnitOrder } from './canonical';
import { hlcToIso } from './hlc';
import {
  FIELD_CREATED,
  FIELD_ORDER,
  isDeleted,
  lastWrite,
  ownRegister,
  type StoreRows,
} from './registers';

// ==================== Le format (§ 6 bis) ====================

export interface NumberZone {
  k: 'n';
  lo?: number;
  hi?: number;
  e: number;
}
/**
 * Dates : deux étendues. `lo`/`hi` sur les dates du CALENDRIER (`AAAA-MM-JJ`, la
 * forme du sélecteur) — leur ordre est le même dans tous les fuseaux, la borne est
 * donc EXACTE ; `tlo`/`thi` sur les autres valeurs (horodatages), que le moteur
 * ramène au jour local : leur borne se lit avec une marge.
 */
export interface DateZone {
  k: 'd';
  lo?: string;
  hi?: string;
  tlo?: string;
  thi?: string;
  e: number;
}
export interface CheckboxZone {
  k: 'b';
  lo: 0 | 1;
  hi: 0 | 1;
}
export interface OptionsZone {
  k: 's' | 'm';
  ids?: string[];
  many?: true;
  e: number;
}
export type FieldZone = NumberZone | DateZone | CheckboxZone | OptionsZone;

export interface SlotZone {
  ver: number;
  n: number;
  o?: [string, string];
  c?: { lo?: string; hi?: string; e: number };
  u?: { lo: string; hi: string };
  f?: Record<string, FieldZone>;
}

export type HeadZones = Record<string, SlotZone>;

/** Au-delà, la clé `zones` est omise entière (la tête est bornée à 1 Mio). */
export const ZONES_MAX_JSON_BYTES = 256 * 1024;
/** Identifiants d'options gardés par propriété et par bloc ; au-delà, `many`. */
export const ZONE_IDS_MAX = 32;

/** Le type de zone d'une propriété, ou `null` si elle n'en a pas. */
export function zoneKindOf(prop: Pick<DbProperty, 'type'>): FieldZone['k'] | null {
  switch (prop.type) {
    case 'number':
    case 'rating':
    case 'progress':
      return 'n';
    case 'date':
      return 'd';
    case 'checkbox':
      return 'b';
    case 'select':
      return 's';
    case 'multiSelect':
      return 'm';
    default:
      return null;
  }
}

// ==================== Le rédacteur ====================

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Une valeur de date, lue SANS dépendre du fuseau du rédacteur : une date du
 * calendrier `AAAA-MM-JJ` (la forme du moteur, mois 1..12, jour 1..31) rend son
 * minuit UTC et `calendar: true` ; toute autre chaîne rend `Date.parse`.
 */
export function dateInstant(v: unknown): { t: number; calendar: boolean } | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '') return null;
  const m = ISO_DATE.exec(s);
  if (m) {
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const t = Date.UTC(Number(m[1]), mo - 1, d);
    return Number.isFinite(t) ? { t, calendar: true } : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? { t, calendar: false } : null;
}

const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Les identifiants d'options portés par une cellule (une chaîne, ou un tableau de chaînes). */
function idsOf(v: unknown): string[] {
  if (typeof v === 'string') return v === '' ? [] : [v];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x !== '');
}

/** La zone d'UN bloc, sur ses lignes vivantes, pour les propriétés du schéma. */
export function slotZone(
  rows: StoreRows,
  ver: number,
  properties: readonly DbProperty[]
): SlotZone {
  type Acc =
    | { k: 'n'; lo: number | null; hi: number | null; e: number }
    | {
        k: 'd';
        lo: string | null;
        hi: string | null;
        loT: number;
        hiT: number;
        tlo: string | null;
        thi: string | null;
        tloT: number;
        thiT: number;
        e: number;
      }
    | { k: 'b'; lo: 0 | 1; hi: 0 | 1; seen: boolean }
    | { k: 's' | 'm'; ids: Set<string>; e: number };
  const fields: Array<[string, Acc]> = [];
  for (const prop of properties) {
    const k = zoneKindOf(prop);
    if (k === null || typeof prop.id !== 'string' || prop.id === '') continue;
    if (k === 'n') fields.push([prop.id, { k, lo: null, hi: null, e: 0 }]);
    else if (k === 'd')
      fields.push([
        prop.id,
        {
          k,
          lo: null,
          hi: null,
          loT: Infinity,
          hiT: -Infinity,
          tlo: null,
          thi: null,
          tloT: Infinity,
          thiT: -Infinity,
          e: 0,
        },
      ]);
    else if (k === 'b') fields.push([prop.id, { k, lo: 1, hi: 0, seen: false }]);
    else fields.push([prop.id, { k, ids: new Set<string>(), e: 0 }]);
  }

  let n = 0;
  let oLo: string | null = null;
  let oHi: string | null = null;
  let cLo: string | null = null;
  let cHi: string | null = null;
  let cLoT = Infinity;
  let cHiT = -Infinity;
  let cE = 0;
  let uLo: string | null = null;
  let uHi: string | null = null;

  for (const id of Object.keys(rows)) {
    const regs = rows[id];
    if (!regs || isDeleted(regs)) continue;
    n += 1;
    const order = ownRegister(regs, FIELD_ORDER)?.v;
    const o = typeof order === 'string' ? order : '';
    if (oLo === null || o < oLo) oLo = o;
    if (oHi === null || o > oHi) oHi = o;

    const created = ownRegister(regs, FIELD_CREATED)?.v;
    const ct = typeof created === 'string' ? Date.parse(created) : NaN;
    if (Number.isFinite(ct)) {
      if (ct < cLoT) {
        cLoT = ct;
        cLo = created as string;
      }
      if (ct > cHiT) {
        cHiT = ct;
        cHi = created as string;
      }
    } else cE += 1;

    const last = lastWrite(regs);
    const updated = last ? hlcToIso(last) : null;
    if (updated) {
      if (uLo === null || updated < uLo) uLo = updated;
      if (uHi === null || updated > uHi) uHi = updated;
    }

    for (const [propId, acc] of fields) {
      const v = ownRegister(regs, propId)?.v;
      if (acc.k === 'n') {
        const x = finite(v);
        if (x === null) acc.e += 1;
        else {
          if (acc.lo === null || x < acc.lo) acc.lo = x;
          if (acc.hi === null || x > acc.hi) acc.hi = x;
        }
      } else if (acc.k === 'd') {
        const read = dateInstant(v);
        if (read === null) acc.e += 1;
        else if (read.calendar) {
          if (read.t < acc.loT) {
            acc.loT = read.t;
            acc.lo = (v as string).trim();
          }
          if (read.t > acc.hiT) {
            acc.hiT = read.t;
            acc.hi = (v as string).trim();
          }
        } else {
          if (read.t < acc.tloT) {
            acc.tloT = read.t;
            acc.tlo = (v as string).trim();
          }
          if (read.t > acc.thiT) {
            acc.thiT = read.t;
            acc.thi = (v as string).trim();
          }
        }
      } else if (acc.k === 'b') {
        const x: 0 | 1 = v === true ? 1 : 0;
        if (!acc.seen || x < acc.lo) acc.lo = x;
        if (!acc.seen || x > acc.hi) acc.hi = x;
        acc.seen = true;
      } else {
        const ids = idsOf(v);
        if (ids.length === 0) acc.e += 1;
        for (const x of ids) acc.ids.add(x);
      }
    }
  }

  const zone: SlotZone = { ver, n };
  if (n > 0 && oLo !== null && oHi !== null) zone.o = [oLo, oHi];
  if (n > 0) {
    const c: NonNullable<SlotZone['c']> = { e: cE };
    if (cLo !== null) c.lo = cLo;
    if (cHi !== null) c.hi = cHi;
    zone.c = c;
    if (uLo !== null && uHi !== null) zone.u = { lo: uLo, hi: uHi };
    const f: Record<string, FieldZone> = {};
    for (const [propId, acc] of fields) {
      if (acc.k === 'n') {
        const z: NumberZone = { k: 'n', e: acc.e };
        if (acc.lo !== null) z.lo = acc.lo;
        if (acc.hi !== null) z.hi = acc.hi;
        f[propId] = z;
      } else if (acc.k === 'd') {
        const z: DateZone = { k: 'd', e: acc.e };
        if (acc.lo !== null) z.lo = acc.lo;
        if (acc.hi !== null) z.hi = acc.hi;
        if (acc.tlo !== null) z.tlo = acc.tlo;
        if (acc.thi !== null) z.thi = acc.thi;
        f[propId] = z;
      } else if (acc.k === 'b') {
        f[propId] = { k: 'b', lo: acc.lo, hi: acc.hi };
      } else {
        const z: OptionsZone = { k: acc.k, e: acc.e };
        if (acc.ids.size > ZONE_IDS_MAX) z.many = true;
        else if (acc.ids.size > 0) z.ids = [...acc.ids].sort(codeUnitOrder);
        f[propId] = z;
      }
    }
    if (Object.keys(f).length > 0) zone.f = f;
  }
  return zone;
}

/**
 * Les zones de TOUS les blocs d'une tête, ou `undefined` si leur JSON canonique
 * dépasse le plafond (la clé est alors omise entière).
 */
export function headZones(
  slots: Iterable<readonly [string, { ver: number; rows: StoreRows }]>,
  properties: readonly DbProperty[],
  /** Zones déjà calculées, par `p|ver|signature du schéma` : un bloc inchangé ne se recalcule pas. */
  cache?: Map<string, SlotZone>
): HeadZones | undefined {
  const signature = schemaSignature(properties);
  const out: HeadZones = {};
  const kept = new Set<string>();
  for (const [p, slot] of slots) {
    const key = `${p}|${slot.ver}|${signature}`;
    kept.add(key);
    let zone = cache?.get(key);
    if (!zone) {
      zone = slotZone(slot.rows, slot.ver, properties);
      cache?.set(key, zone);
    }
    out[p] = zone;
  }
  if (cache) for (const key of [...cache.keys()]) if (!kept.has(key)) cache.delete(key);
  if (utf8Length(canonicalJson(out)) > ZONES_MAX_JSON_BYTES) return undefined;
  return out;
}

/** Ce qui, dans le schéma, change les zones : l'identité et le type des propriétés zonées. */
export function schemaSignature(properties: readonly DbProperty[]): string {
  return properties
    .map((p) => (zoneKindOf(p) === null ? '' : `${p.id}:${zoneKindOf(p)}`))
    .filter((x) => x !== '')
    .join(',');
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

// ==================== Le lecteur ====================

const isInt = (x: unknown, min: number): x is number =>
  typeof x === 'number' && Number.isInteger(x) && x >= min;
const isStr = (x: unknown): x is string => typeof x === 'string';

function readField(raw: unknown): FieldZone | null {
  if (!raw || typeof raw !== 'object') return null;
  const z = raw as Record<string, unknown>;
  if (z.k === 'n') {
    if (!isInt(z.e, 0)) return null;
    const lo = z.lo;
    const hi = z.hi;
    if ((lo !== undefined && finite(lo) === null) || (hi !== undefined && finite(hi) === null))
      return null;
    if ((lo === undefined) !== (hi === undefined)) return null;
    return { k: 'n', e: z.e, ...(lo !== undefined ? { lo: lo as number, hi: hi as number } : {}) };
  }
  if (z.k === 'd') {
    if (!isInt(z.e, 0)) return null;
    if ((z.lo === undefined) !== (z.hi === undefined)) return null;
    if ((z.tlo === undefined) !== (z.thi === undefined)) return null;
    if (
      z.lo !== undefined &&
      (!isStr(z.lo) || !isStr(z.hi) || !ISO_DATE.test(z.lo) || !ISO_DATE.test(z.hi as string))
    )
      return null;
    if (z.tlo !== undefined && (!isStr(z.tlo) || !isStr(z.thi))) return null;
    return {
      k: 'd',
      e: z.e,
      ...(z.lo !== undefined ? { lo: z.lo as string, hi: z.hi as string } : {}),
      ...(z.tlo !== undefined ? { tlo: z.tlo as string, thi: z.thi as string } : {}),
    };
  }
  if (z.k === 'b') {
    if ((z.lo !== 0 && z.lo !== 1) || (z.hi !== 0 && z.hi !== 1) || z.lo > z.hi) return null;
    return { k: 'b', lo: z.lo, hi: z.hi };
  }
  if (z.k === 's' || z.k === 'm') {
    if (!isInt(z.e, 0)) return null;
    if (z.many === true) return { k: z.k, e: z.e, many: true };
    if (z.ids === undefined) return { k: z.k, e: z.e };
    if (!Array.isArray(z.ids) || !z.ids.every(isStr)) return null;
    return { k: z.k, e: z.e, ids: [...(z.ids as string[])] };
  }
  return null;
}

/**
 * Les zones VALABLES d'une tête : bien formées, et dont `ver` est celle du bloc
 * dans `slots`. Une zone périmée, mal formée ou d'un bloc inconnu est ignorée —
 * le bloc se traite alors comme s'il n'en avait pas (il peut tout contenir).
 */
export function validZones(head: {
  slots: Record<string, { ver: number }>;
  zones?: unknown;
}): Map<string, SlotZone> {
  const out = new Map<string, SlotZone>();
  const raw = head.zones;
  if (!raw || typeof raw !== 'object') return out;
  for (const [p, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = Object.prototype.hasOwnProperty.call(head.slots, p) ? head.slots[p] : undefined;
    if (!entry || !value || typeof value !== 'object') continue;
    const z = value as Record<string, unknown>;
    if (z.ver !== entry.ver || !isInt(z.n, 0)) continue;
    const zone: SlotZone = { ver: entry.ver, n: z.n };
    if (z.o !== undefined) {
      if (!Array.isArray(z.o) || z.o.length !== 2 || !z.o.every(isStr)) continue;
      zone.o = [z.o[0] as string, z.o[1] as string];
    } else if (z.n > 0) continue; // des lignes sans étendue d'ordre : zone incomplète
    if (z.c !== undefined) {
      const c = z.c as Record<string, unknown>;
      if (!c || typeof c !== 'object' || !isInt(c.e, 0)) continue;
      if ((c.lo !== undefined && !isStr(c.lo)) || (c.hi !== undefined && !isStr(c.hi))) continue;
      zone.c = {
        e: c.e,
        ...(isStr(c.lo) ? { lo: c.lo } : {}),
        ...(isStr(c.hi) ? { hi: c.hi } : {}),
      };
    }
    if (z.u !== undefined) {
      const u = z.u as Record<string, unknown>;
      if (!u || typeof u !== 'object' || !isStr(u.lo) || !isStr(u.hi)) continue;
      zone.u = { lo: u.lo, hi: u.hi };
    }
    if (z.f !== undefined) {
      if (!z.f || typeof z.f !== 'object') continue;
      const f: Record<string, FieldZone> = {};
      for (const [propId, fz] of Object.entries(z.f as Record<string, unknown>)) {
        const read = readField(fz);
        if (read && propId !== '__proto__') f[propId] = read;
      }
      zone.f = f;
    }
    out.set(p, zone);
  }
  return out;
}
