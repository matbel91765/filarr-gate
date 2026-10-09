// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/store/codec.ts @ cf89543a — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Codec du magasin des bases — contrat `db-store-1`, § 5 et § 6.
 *
 *  · JSON CANONIQUE (`canonical.ts`) : clés triées en ordre des unités de code
 *    UTF-16, aucun espace, nombres au format de `JSON.stringify`.
 *  · BLOC : lignes en COLONNES (PAX) alignées sur `ids` triés, puis UTF-8,
 *    deflate-raw (fflate, niveau 6), AES-256-GCM sous `K_slot(p)` avec une AAD
 *    qui lie le magasin, le préfixe et la version.
 *  · TÊTE : schéma (un registre), index des blocs, racine de Merkle, et les
 *    deux clés tirées à la création (`keys.place`, `keys.mac` — précision 3.3).
 *  · PLACEMENT : `HMAC(keys.place, rowId)` lu en bits ; une ligne vit dans le
 *    préfixe de la tête qui commence ses bits. Un bloc de plus de 32 Kio
 *    chiffrés se divise en deux. Une rotation de K_vault ne déplace rien.
 *
 * Le source passe sous `strict` ET `noUncheckedIndexedAccess`.
 */

import { deflateSync, inflateSync } from 'fflate';
import type { DbProperty } from '../../types';
import { canonicalJson, codeUnitOrder } from './canonical';
import { isHlc } from './hlc';
import {
  isSafeKey,
  mergeRow,
  ownRegister,
  ownRow,
  registerWins,
  type RowRegisters,
  type StoreRows,
} from './registers';
import {
  fromBase64Url,
  headAad,
  open,
  seal,
  slotAad,
  slotKey,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type HeadKeys,
  type StoreCrypto,
  type StoreKeys,
} from './crypto';

export { canonicalJson, codeUnitOrder };

/** Au-delà, un bloc se divise (§ 5.1). */
export const SLOT_SPLIT_BYTES = 32 * 1024;
/** Le corps toléré d'un bloc qui ne tient qu'UNE ligne (§ 5.1, point 4). */
export const SLOT_LONE_MAX_BYTES = 256 * 1024;
/** Une empreinte de placement : HMAC-SHA256, 256 bits. */
const PLACE_BITS = 256;

// ==================== Placement ====================

/** Les bits d'une empreinte de placement, du premier octet (poids fort) à la fin. */
export function bitAt(hash: Uint8Array, index: number): '0' | '1' {
  return ((hash[index >> 3] ?? 0) >> (7 - (index & 7))) & 1 ? '1' : '0';
}

/** L'empreinte de placement d'une ligne, sous la clé `keys.place` de la tête. */
export function placeHash(
  c: StoreCrypto,
  placeKey: Uint8Array,
  rowId: string
): Promise<Uint8Array> {
  return c.hmacSha256(placeKey, utf8Encode(rowId));
}

/** Les empreintes de plusieurs lignes, par identifiant. */
export async function placeHashes(
  c: StoreCrypto,
  placeKey: Uint8Array,
  rowIds: Iterable<string>
): Promise<Map<string, Uint8Array>> {
  const ids = [...new Set(rowIds)];
  const hashes = await Promise.all(ids.map((id) => placeHash(c, placeKey, id)));
  const out = new Map<string, Uint8Array>();
  ids.forEach((id, i) => {
    const hash = hashes[i];
    if (hash) out.set(id, hash);
  });
  return out;
}

/**
 * Le préfixe de `prefixes` (un recouvrement sans chevauchement de l'espace des
 * bits) qui commence les bits de `hash`. Lève si l'ensemble n'est pas un
 * recouvrement : une tête corrompue ne doit pas ranger une ligne au hasard.
 */
export function prefixFor(hash: Uint8Array, prefixes: ReadonlySet<string>): string {
  let p = '';
  for (let depth = 0; depth <= PLACE_BITS; depth += 1) {
    if (prefixes.has(p)) return p;
    if (depth === PLACE_BITS) break;
    p += bitAt(hash, depth);
  }
  throw new Error('les préfixes de la tête ne recouvrent pas cette ligne');
}

/**
 * Un ensemble de préfixes recouvre-t-il l'espace exactement une fois ?
 * Vérification EXACTE, sans flottants (une somme de 2^-longueur acceptait un
 * trou de 2^-60) : aucun préfixe n'en commence un autre, et tout nœud intérieur
 * de l'arbre a ses deux enfants peuplés.
 */
export function isCover(prefixes: readonly string[]): boolean {
  if (prefixes.length === 0) return false;
  const sorted = [...prefixes].sort(codeUnitOrder);
  for (let i = 0; i < sorted.length; i += 1) {
    const p = sorted[i]!;
    if (p.length > PLACE_BITS || !/^[01]*$/.test(p)) return false;
    // Les chaînes qui commencent par `q` sont contiguës dans l'ordre trié : comparer aux voisines suffit
    if (i > 0 && p.startsWith(sorted[i - 1]!)) return false;
  }
  const populated = (s: string): boolean => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < s) lo = mid + 1;
      else hi = mid;
    }
    return lo < sorted.length && sorted[lo]!.startsWith(s);
  };
  const inner = new Set<string>();
  for (const p of sorted) for (let k = 0; k < p.length; k += 1) inner.add(p.slice(0, k));
  for (const q of inner) if (!populated(`${q}0`) || !populated(`${q}1`)) return false;
  return true;
}

/** Répartit les lignes du bloc `prefix` entre `prefix0` et `prefix1`, selon le bit de rang `longueur(prefix)`. */
export function splitRows(
  prefix: string,
  rows: StoreRows,
  hashes: ReadonlyMap<string, Uint8Array>
): [StoreRows, StoreRows] {
  if (prefix.length >= PLACE_BITS)
    throw new Error('préfixe au bout des 256 bits : division impossible');
  const zero: StoreRows = {};
  const one: StoreRows = {};
  for (const [id, row] of Object.entries(rows)) {
    if (!isSafeKey(id)) continue;
    const hash = hashes.get(id);
    if (!hash || hash.length * 8 !== PLACE_BITS)
      throw new Error(`empreinte de placement manquante : ${id}`);
    (bitAt(hash, prefix.length) === '0' ? zero : one)[id] = row;
  }
  return [zero, one];
}

// ==================== Bloc ====================

export interface SlotPlain {
  p: string;
  rows: StoreRows;
}

/** Le JSON canonique d'un bloc : colonnes alignées sur les identifiants triés. */
export function slotJson(prefix: string, rows: StoreRows): string {
  const ids = Object.keys(rows).filter(isSafeKey).sort(codeUnitOrder);
  const fields = new Set<string>();
  for (const id of ids)
    for (const f of Object.keys(rows[id] ?? {})) if (isSafeKey(f)) fields.add(f);
  const f: Record<string, { t: Array<string | null>; v: unknown[] }> = {};
  for (const field of [...fields].sort(codeUnitOrder)) {
    const regs = ids.map((id) => ownRegister(rows[id], field));
    f[field] = {
      t: regs.map((reg) => reg?.t ?? null),
      v: regs.map((reg) => (reg === undefined ? null : reg.v)),
    };
  }
  return canonicalJson({ f, ids, p: prefix, v: 1 });
}

export function parseSlotJson(json: string): SlotPlain {
  const data = JSON.parse(json) as {
    v: number;
    p: string;
    ids: unknown[];
    f: Record<string, { t?: unknown; v?: unknown }>;
  };
  if (
    data === null ||
    typeof data !== 'object' ||
    data.v !== 1 ||
    typeof data.p !== 'string' ||
    !Array.isArray(data.ids)
  ) {
    throw new Error('bloc illisible');
  }
  const columns = data.f !== null && typeof data.f === 'object' ? Object.entries(data.f) : [];
  const rows: StoreRows = {};
  data.ids.forEach((id, i) => {
    if (!isSafeKey(id)) return;
    const row: RowRegisters = {};
    for (const [field, col] of columns) {
      if (!isSafeKey(field) || col === null || typeof col !== 'object') continue;
      const t = Array.isArray(col.t) ? col.t[i] : undefined;
      if (isHlc(t)) row[field] = { v: (Array.isArray(col.v) ? col.v[i] : null) ?? null, t };
    }
    // Un identifiant répété (bloc fautif) : les deux colonnes se FUSIONNENT, quel que soit leur rang
    rows[id] = mergeRow(ownRow(rows, id), row);
  });
  return { p: data.p, rows };
}

/** Chiffre un bloc : JSON canonique → UTF-8 → deflate-raw → AES-GCM. */
export async function sealSlot(
  c: StoreCrypto,
  keys: StoreKeys,
  prefix: string,
  ver: number,
  rows: StoreRows,
  iv?: Uint8Array
): Promise<Uint8Array> {
  const compressed = deflateSync(utf8Encode(slotJson(prefix, rows)), { level: 6 });
  return seal(
    c,
    await slotKey(c, keys, prefix),
    compressed,
    slotAad(keys.storeId, prefix, ver),
    iv
  );
}

export async function openSlot(
  c: StoreCrypto,
  keys: StoreKeys,
  prefix: string,
  ver: number,
  body: Uint8Array
): Promise<SlotPlain> {
  const compressed = await open(
    c,
    await slotKey(c, keys, prefix),
    body,
    slotAad(keys.storeId, prefix, ver)
  );
  const plain = parseSlotJson(utf8Decode(inflateSync(compressed)));
  if (plain.p !== prefix) throw new Error('bloc rangé sous un autre préfixe');
  return plain;
}

/** L'empreinte d'un corps chiffré, sous la clé `keys.mac` de la tête (§ 5.3). */
export async function slotMac(
  c: StoreCrypto,
  macKey: Uint8Array,
  body: Uint8Array
): Promise<string> {
  return toBase64Url(await c.hmacSha256(macKey, body));
}

/** Une ligne seule dont le bloc dépasserait 256 Kio chiffrés : le geste est refusé (§ 5.1). */
export class RowTooHeavyError extends Error {
  constructor(
    readonly rowId: string,
    readonly bytes: number
  ) {
    super(`ligne trop lourde pour un bloc : ${rowId} (${bytes} octets chiffrés)`);
    this.name = 'RowTooHeavyError';
  }
}

export interface LaidSlot {
  p: string;
  ver: number;
  rows: StoreRows;
  body: Uint8Array;
}

/**
 * Chiffre les lignes d'un bloc et le DIVISE tant que son corps dépasse 32 Kio
 * (§ 5.1). `ver` vaut pour le bloc s'il reste entier ; un préfixe né d'une
 * division commence à 1 (il n'a pas d'« ancienne » version, § 8). Deux lignes
 * distinctes se séparent toujours : leurs empreintes diffèrent en 256 bits.
 */
export async function layoutSlot(
  c: StoreCrypto,
  keys: StoreKeys,
  prefix: string,
  ver: number,
  rows: StoreRows,
  hashes: ReadonlyMap<string, Uint8Array>
): Promise<LaidSlot[]> {
  const body = await sealSlot(c, keys, prefix, ver, rows);
  if (body.length <= SLOT_SPLIT_BYTES) return [{ p: prefix, ver, rows, body }];
  const ids = Object.keys(rows).filter(isSafeKey);
  if (ids.length <= 1) {
    if (body.length > SLOT_LONE_MAX_BYTES) throw new RowTooHeavyError(ids[0] ?? '', body.length);
    return [{ p: prefix, ver, rows, body }];
  }
  const [zero, one] = splitRows(prefix, rows, hashes);
  return [
    ...(await layoutSlot(c, keys, `${prefix}0`, 1, zero, hashes)),
    ...(await layoutSlot(c, keys, `${prefix}1`, 1, one, hashes)),
  ];
}

// ==================== Tête ====================

export interface SlotEntry {
  /** Époque de la clé sous laquelle le bloc est chiffré. */
  e: number;
  mac: string;
  ver: number;
}

export interface StoreSchema {
  properties: DbProperty[];
  rowTemplates?: unknown[];
  /** Clés de racine inconnues de ce client, gardées telles quelles. */
  extra?: Record<string, unknown>;
  collation?: string;
  /** Heure du registre du schéma. */
  t: string;
}

export interface StoreHead {
  v: 1;
  /** Index de zone, FACULTATIF (précision 3.8, § 6 bis) : lu par `validZones`, jamais par `openHead`. */
  zones?: unknown;
  /** Identité du bloc PROPRIÉTAIRE, posée à la création (§ 6, § 10 bis). */
  dbId: string;
  /** Clés de placement et d'empreinte, tirées à la création, recopiées à chaque tête (3.3). */
  keys: HeadKeys;
  schema: StoreSchema;
  slots: Record<string, SlotEntry>;
  root: string;
  epochs: number[];
  updated: string;
}

/** Les clés de la tête en octets ; lève si elles ne sont pas deux fois 32 octets. */
export function headKeyBytes(head: Pick<StoreHead, 'keys'>): {
  mac: Uint8Array;
  place: Uint8Array;
} {
  const mac = typeof head.keys?.mac === 'string' ? fromBase64Url(head.keys.mac) : null;
  const place = typeof head.keys?.place === 'string' ? fromBase64Url(head.keys.place) : null;
  if (!mac || mac.length !== 32 || !place || place.length !== 32)
    throw new Error('tête illisible : clés');
  return { mac, place };
}

/** Le schéma est UN registre (§ 6) : le plus récent l'emporte ; à heure égale, le JSON canonique le plus grand. */
export function mergeSchema(a: StoreSchema, b: StoreSchema): StoreSchema {
  const value = ({ t: _t, ...rest }: StoreSchema): Omit<StoreSchema, 't'> => rest;
  return registerWins({ v: value(b), t: b.t }, { v: value(a), t: a.t }) ? b : a;
}

/** Racine de Merkle : HMAC (clé `keys.mac`) de la concaténation triée de `p:mac`. */
export async function merkleRoot(
  c: StoreCrypto,
  macKey: Uint8Array,
  slots: Record<string, SlotEntry>
): Promise<string> {
  const parts = Object.entries(slots)
    .map(([p, entry]) => `${p}:${entry.mac}`)
    .sort(codeUnitOrder)
    .join('');
  return toBase64Url(await c.hmacSha256(macKey, utf8Encode(parts)));
}

export function headJson(head: StoreHead): string {
  return canonicalJson(head);
}

export async function sealHead(
  c: StoreCrypto,
  keys: StoreKeys,
  seq: number,
  head: StoreHead,
  iv?: Uint8Array
): Promise<Uint8Array> {
  return seal(c, keys.kHead, utf8Encode(headJson(head)), headAad(keys.storeId, seq), iv);
}

const isSlotEntry = (entry: unknown): entry is SlotEntry => {
  const e = entry as SlotEntry | null;
  return (
    e !== null &&
    typeof e === 'object' &&
    Number.isInteger(e.ver) &&
    e.ver >= 1 &&
    Number.isInteger(e.e) &&
    e.e >= 0 &&
    typeof e.mac === 'string'
  );
};

export async function openHead(
  c: StoreCrypto,
  keys: StoreKeys,
  seq: number,
  body: Uint8Array
): Promise<StoreHead> {
  const head = JSON.parse(
    utf8Decode(await open(c, keys.kHead, body, headAad(keys.storeId, seq)))
  ) as StoreHead;
  if (
    head === null ||
    typeof head !== 'object' ||
    head.v !== 1 ||
    typeof head.dbId !== 'string' ||
    !head.schema ||
    !isHlc(head.schema.t) ||
    !head.slots ||
    typeof head.slots !== 'object' ||
    !Object.values(head.slots).every(isSlotEntry)
  ) {
    throw new Error('tête illisible');
  }
  const { mac } = headKeyBytes(head);
  if (!isCover(Object.keys(head.slots)))
    throw new Error('tête incohérente : préfixes sans recouvrement');
  if ((await merkleRoot(c, mac, head.slots)) !== head.root)
    throw new Error('tête altérée : racine fausse');
  return head;
}

/**
 * Ouvre une tête de COFFRE sans savoir sous quelle époque elle a été scellée :
 * la plus récente d'abord, puis les précédentes (§ 3). Rend la tête et les
 * clés qui l'ont ouverte ; lève avec la dernière erreur si aucune ne l'ouvre.
 */
export async function openHeadAnyEpoch(
  c: StoreCrypto,
  keyring: readonly StoreKeys[],
  seq: number,
  body: Uint8Array
): Promise<{ head: StoreHead; keys: StoreKeys }> {
  const byNewest = [...keyring].sort((a, b) => b.epoch - a.epoch);
  let last: unknown = new Error('aucune clé pour ouvrir la tête');
  for (const keys of byNewest) {
    try {
      return { head: await openHead(c, keys, seq, body), keys };
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/** Vérifie un corps reçu contre l'entrée de la tête — un serveur ne peut pas en substituer un autre. */
export async function verifySlot(
  c: StoreCrypto,
  macKey: Uint8Array,
  entry: SlotEntry,
  body: Uint8Array
): Promise<boolean> {
  return (await slotMac(c, macKey, body)) === entry.mac;
}

export { fromBase64Url, toBase64Url };
