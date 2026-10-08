// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/store/fracIndex.ts @ 9b0ca853 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Index fractionnaires — l'ordre manuel des lignes du magasin (`#o`, contrat
 * `db-store-1`, § 4).
 *
 * Une position est une CHAÎNE sur l'alphabet base 62 (`0-9A-Za-z`, dans l'ordre
 * des codes) qui ne finit jamais par `0`. On en trouve toujours une entre deux
 * autres : déplacer une ligne réécrit SA seule position, jamais celle des
 * autres — c'est ce qui permet à deux appareils de réordonner en même temps sans
 * se marcher dessus. Algorithme du point milieu de `fractional-indexing`
 * (rocicorp, MIT), sans la partie entière.
 */

export const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.endsWith('0') || (b !== null && b.endsWith('0'))) throw new Error('zéro final interdit');
  if (b !== null) {
    // Le plus long préfixe commun, `a` complété de zéros
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a.charAt(0)) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b.charAt(0)) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS.charAt(Math.round(0.5 * (digitA + digitB)));
  // Chiffres consécutifs
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS.charAt(digitA) + midpoint(a.slice(1), null);
}

/** Une position strictement entre `a` et `b` (`null` = sans borne de ce côté). */
export function positionBetween(a: string | null, b: string | null): string {
  return midpoint(a ?? '', b);
}

/**
 * `n` positions RÉGULIÈREMENT espacées, de largeur fixe — la migration d'une
 * base en ligne vers le magasin (§ 10) les pose en une fois. Enchaîner
 * `positionBetween(dernière, null)` allongerait les clés d'un caractère toutes
 * les six lignes.
 */
export function evenPositions(n: number): string[] {
  if (n <= 0) return [];
  let width = 1;
  while (62 ** width < (n + 1) * 2) width += 1;
  const span = 62 ** width;
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    let value = Math.floor(((i + 1) * span) / (n + 1));
    let digits = '';
    for (let k = 0; k < width; k += 1) {
      digits = DIGITS.charAt(value % 62) + digits;
      value = Math.floor(value / 62);
    }
    // Sans zéro final : l'ordre est préservé (largeur fixe, préfixes distincts)
    out.push(digits.replace(/0+$/, '') || DIGITS.charAt(1));
  }
  return out;
}

export const isPosition = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.endsWith('0') &&
  /^[0-9A-Za-z]+$/.test(value);
