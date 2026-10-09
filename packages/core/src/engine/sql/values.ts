// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/sql/values.ts @ 3e9d65cd — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Valeurs SQL du moteur — les classes de stockage et les règles de SQLite, qui
 * sert d'oracle aux tests (`node:sqlite`).
 *
 *   NULL     → `null`
 *   INTEGER  → `bigint` (la division entière, les entiers exacts viennent seuls)
 *   REAL     → `number`
 *   TEXT     → `string`
 *
 * Un INTEGER et un REAL se comparent par leur valeur ; un nombre passe avant un
 * texte ; deux textes se comparent par l'ordre BINAIRE de SQLite, c'est-à-dire
 * octet par octet en UTF-8 — l'ordre des points de code, PAS celui des unités
 * de code UTF-16 de JavaScript (une différence au-delà de U+FFFF).
 */

export type SqlValue = null | bigint | number | string;

/** Affinité d'une colonne (règles de SQLite, d'après son type déclaré). */
export type Affinity = 'INTEGER' | 'REAL' | 'NUMERIC' | 'TEXT' | 'BLOB';

export function affinityOfDeclared(declared: string): Affinity {
  const t = declared.toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT';
  if (t === '' || t.includes('BLOB')) return 'BLOB';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL';
  return 'NUMERIC';
}

const isNumber = (v: SqlValue): v is bigint | number =>
  typeof v === 'bigint' || typeof v === 'number';

/** Rang de classe de stockage pour l'ordre : NULL < nombre < texte. */
function storageRank(v: SqlValue): number {
  if (v === null) return 0;
  if (isNumber(v)) return 1;
  return 2;
}

/** Ordre BINAIRE de SQLite : points de code (comme les octets UTF-8). */
export function compareBinary(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca === cb) continue;
    // Une demi-paire de substitution (U+D800–U+DFFF) code un point ≥ U+10000 :
    // il passe APRÈS U+E000–U+FFFF, ce que l'ordre UTF-16 brut inverse.
    const sa = ca >= 0xd800 && ca <= 0xdfff;
    const sb = cb >= 0xd800 && cb <= 0xdfff;
    if (sa !== sb) {
      if (sa && cb >= 0xe000) return 1;
      if (sb && ca >= 0xe000) return -1;
    }
    return ca < cb ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function compareNumbers(a: bigint | number, b: bigint | number): number {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  // Mélange : JavaScript compare un bigint et un number sans perte
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Ordre total de SQLite entre deux valeurs (ORDER BY, MIN, MAX, DISTINCT). */
export function compareSql(a: SqlValue, b: SqlValue): number {
  const ra = storageRank(a);
  const rb = storageRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 1) return compareNumbers(a as bigint | number, b as bigint | number);
  return compareBinary(a as string, b as string);
}

/** Texte d'un REAL, comme `%!.15g` de SQLite (« 3.0 », « 2.5 », « 1.0e+20 »). */
export function realToText(v: number): string {
  if (Number.isNaN(v)) return '';
  if (!Number.isFinite(v)) return v > 0 ? 'Inf' : '-Inf';
  // Le zéro négatif s'écrit « 0.0 », comme dans SQLite
  if (v === 0) return '0.0';
  const abs = Math.abs(v);
  if (abs >= 1e-4 && abs < 1e15) {
    let s = Number(v.toPrecision(15)).toString();
    if (s.includes('e')) s = v.toPrecision(15).replace(/\.?0+$/, '');
    return s.includes('.') ? s : `${s}.0`;
  }
  // Notation scientifique : mantisse avec au moins un chiffre après le point
  const [mant, exp] = v.toExponential(14).split('e');
  let m = mant!.replace(/0+$/, '');
  if (m.endsWith('.')) m += '0';
  const e = Number(exp);
  return `${m}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
}

/** Conversion en TEXTE (concaténation, LIKE, affinité TEXT). */
export function toText(v: SqlValue): string | null {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  return realToText(v);
}

const INT_RE = /^\s*[+-]?\d+\s*$/;
const REAL_RE = /^\s*[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)\s*$/;

/**
 * Affinité NUMERIC appliquée à un texte : converti s'il a l'allure d'un nombre
 * bien formé (blancs autour tolérés), sinon laissé tel quel.
 */
export function numericAffinity(v: SqlValue): SqlValue {
  if (typeof v !== 'string') return v;
  if (INT_RE.test(v)) {
    const big = BigInt(v.trim());
    if (big >= -(2n ** 63n) && big < 2n ** 63n) return big;
    return Number(v);
  }
  if (REAL_RE.test(v)) {
    const n = Number(v);
    // Un réel sans partie fractionnaire, stocké sous affinité NUMERIC, devient entier
    return Number.isInteger(n) && Math.abs(n) < 2 ** 53 ? BigInt(n) : n;
  }
  return v;
}

/**
 * Type numérique d'un texte SANS chercher l'entier (`sqlite3_value_numeric_type`,
 * qu'utilisent SUM, TOTAL et AVG) : « 7 » est un entier, mais « 7.0 » reste un
 * réel — là où l'affinité NUMERIC d'une colonne en ferait l'entier 7.
 */
export function numericType(v: SqlValue): SqlValue {
  if (typeof v !== 'string') return v;
  if (INT_RE.test(v)) {
    const big = BigInt(v.trim());
    return big >= -(2n ** 63n) && big < 2n ** 63n ? big : Number(v);
  }
  if (REAL_RE.test(v)) return Number(v);
  return v;
}

/** Affinité TEXT : un nombre devient son texte. */
export function textAffinity(v: SqlValue): SqlValue {
  return isNumber(v) ? toText(v) : v;
}

/**
 * Stockage dans une colonne d'affinité donnée — ce que fait SQLite à l'INSERT.
 * REAL : un entier devient réel ; INTEGER : un réel exact devient entier.
 */
export function storeAs(v: SqlValue, affinity: Affinity): SqlValue {
  switch (affinity) {
    case 'TEXT':
      return textAffinity(v);
    case 'REAL': {
      const n = numericAffinity(v);
      return typeof n === 'bigint' ? Number(n) : n;
    }
    case 'INTEGER':
    case 'NUMERIC': {
      const n = numericAffinity(v);
      if (typeof n === 'number' && Number.isInteger(n) && Math.abs(n) < 2 ** 53) return BigInt(n);
      return n;
    }
    default:
      return v;
  }
}

/**
 * Valeur NUMÉRIQUE d'une valeur pour l'arithmétique : un texte se lit par son
 * plus long préfixe numérique (« 12abc » → 12, « abc » → 0), comme SQLite.
 */
export function toNumeric(v: SqlValue): bigint | number | null {
  if (v === null) return null;
  if (isNumber(v)) return v;
  const m = /^\s*([+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?))/.exec(v);
  if (!m) return 0n;
  const text = m[1];
  if (/^[+-]?\d+$/.test(text!)) {
    const big = BigInt(text!);
    return big >= -(2n ** 63n) && big < 2n ** 63n ? big : Number(text);
  }
  return Number(text);
}

/** Vérité d'une condition (WHERE, HAVING, CASE) : NULL est faux, 0 est faux. */
export function isTrue(v: SqlValue): boolean {
  if (v === null) return false;
  const n = toNumeric(v);
  return n !== null && n !== 0n && n !== 0;
}

/** Trois valeurs logiques : `true`, `false`, ou `null` (inconnu). */
export function logicalOf(v: SqlValue): boolean | null {
  if (v === null) return null;
  return isTrue(v);
}

export const fromBool = (b: boolean | null): SqlValue => (b === null ? null : b ? 1n : 0n);

/** Égalité au sens de DISTINCT et GROUP BY : NULL égal à NULL. */
export function sameGroup(a: SqlValue, b: SqlValue): boolean {
  return compareSql(a, b) === 0 && storageRank(a) === storageRank(b);
}

/** Clé de regroupement d'une valeur (types distingués, nombres par valeur). */
export function groupKey(v: SqlValue): string {
  if (v === null) return 'n';
  if (typeof v === 'string') return `s${v}`;
  // 3 (INTEGER) et 3.0 (REAL) se regroupent ensemble, comme dans SQLite
  return `d${typeof v === 'bigint' ? v.toString() : Number.isInteger(v) && Math.abs(v) < 2 ** 63 ? BigInt(v).toString() : String(v)}`;
}
