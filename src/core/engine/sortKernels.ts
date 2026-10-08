// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/sortKernels.ts @ 50743c75 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Noyaux de tri du moteur en colonnes — SANS COMPARATEUR.
 *
 * Le tri d'une vue se ramène ici à : une permutation de lignes (`Uint32Array`)
 * et, par niveau, une CLÉ ENTIÈRE par ligne (`Uint32Array`, indexée par ligne)
 * qui respecte déjà l'ordre voulu — sens décroissant et « vides en dernier »
 * compris (voir `view.ts`). Trier par niveaux, du dernier au premier, avec une
 * passe STABLE chacun, rend l'ordre lexicographique, les égalités départagées par
 * l'ordre d'origine : exactement la règle de `viewEngine.applySorts`.
 *
 * Trois noyaux, parce que les moteurs JavaScript ne se valent pas :
 *  · `radix`  — tri par dénombrement LSD, chiffres de 11 bits. Le meilleur sur V8
 *    (bureau, web) : aucun appel de fonction par comparaison, des boucles sur
 *    tableaux typés que le JIT compile en code machine.
 *  · `packed` — clé et position EMPAQUETÉES dans un seul `Float64Array`
 *    (clé × 2²¹ + position, exact sous 2⁵³), trié par `Float64Array.sort()`
 *    sans comparateur. Le tri natif est du C++ dans Hermes (mobile), qui n'a pas
 *    de JIT : la boucle de dénombrement y est interprétée, le tri natif non.
 *  · `comparator` — la référence lisible, et le repli.
 *
 * `chooseSortKernel()` mesure les deux premiers une fois, sur l'appareil, et
 * retient le plus rapide. Aucun Worker, aucun WASM : tout tient sur le seul fil
 * JavaScript que le mobile possède.
 */

export type SortKernel = 'radix' | 'packed' | 'comparator';

const DIGIT_BITS = 11;
const DIGIT_SIZE = 1 << DIGIT_BITS;
const DIGIT_MASK = DIGIT_SIZE - 1;
/** Positions empaquetées : 2²¹ lignes au plus par passe (≈ 2 millions). */
const PACK_SHIFT = 2097152;
export const PACKED_MAX_ROWS = PACK_SHIFT;

/** Nombre de bits utiles d'une clé maximale. */
function bitsFor(maxKey: number): number {
  let bits = 0;
  while (bits < 32 && maxKey >= 2 ** bits) bits += 1;
  return bits;
}

/**
 * Une passe de tri par dénombrement, STABLE, de `perm` vers `out`, sur le
 * chiffre `(clé >>> shift) & masque`.
 */
function countingPass(
  perm: Uint32Array,
  keys: Uint32Array,
  shift: number,
  out: Uint32Array,
  counts: Uint32Array
): void {
  counts.fill(0);
  const n = perm.length;
  for (let i = 0; i < n; i += 1) counts[(keys[perm[i]] >>> shift) & DIGIT_MASK] += 1;
  let sum = 0;
  for (let d = 0; d < DIGIT_SIZE; d += 1) {
    const c = counts[d];
    counts[d] = sum;
    sum += c;
  }
  for (let i = 0; i < n; i += 1) {
    const row = perm[i];
    out[counts[(keys[row] >>> shift) & DIGIT_MASK]++] = row;
  }
}

/** Trie `perm` (en place) par `keys`, stable — tri par dénombrement LSD. */
export function radixSortBy(perm: Uint32Array, keys: Uint32Array, maxKey: number): void {
  const n = perm.length;
  if (n < 2) return;
  const passes = Math.ceil(bitsFor(maxKey) / DIGIT_BITS);
  if (passes === 0) return;
  const counts = new Uint32Array(DIGIT_SIZE);
  let src: Uint32Array = perm;
  let dst: Uint32Array = new Uint32Array(n);
  for (let p = 0; p < passes; p += 1) {
    countingPass(src, keys, p * DIGIT_BITS, dst, counts);
    const t = src;
    src = dst;
    dst = t;
  }
  if (src !== perm) perm.set(src);
}

/**
 * Trie `perm` (en place) par `keys`, stable — clé et position empaquetées, tri
 * natif d'un `Float64Array`. Au-delà de `PACKED_MAX_ROWS` lignes, repli sur le
 * dénombrement.
 */
export function packedSortBy(perm: Uint32Array, keys: Uint32Array, maxKey: number): void {
  const n = perm.length;
  if (n < 2) return;
  if (n > PACKED_MAX_ROWS) {
    radixSortBy(perm, keys, maxKey);
    return;
  }
  const packed = new Float64Array(n);
  for (let i = 0; i < n; i += 1) packed[i] = keys[perm[i]] * PACK_SHIFT + i;
  packed.sort();
  const before = perm.slice();
  for (let i = 0; i < n; i += 1) perm[i] = before[packed[i] % PACK_SHIFT];
}

/** La référence : un tri à comparateur, stable par l'index d'origine. */
export function comparatorSortBy(perm: Uint32Array, keys: Uint32Array): void {
  const n = perm.length;
  if (n < 2) return;
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => keys[perm[a]] - keys[perm[b]] || a - b);
  const before = perm.slice();
  for (let i = 0; i < n; i += 1) perm[i] = before[order[i]];
}

export function sortBy(
  kernel: SortKernel,
  perm: Uint32Array,
  keys: Uint32Array,
  maxKey: number
): void {
  if (kernel === 'radix') radixSortBy(perm, keys, maxKey);
  else if (kernel === 'packed') packedSortBy(perm, keys, maxKey);
  else comparatorSortBy(perm, keys);
}

/**
 * Trie `perm` par niveaux — le PREMIER niveau l'emporte, les égalités restent
 * dans l'ordre d'entrée. Chaque niveau : ses clés par ligne et sa clé maximale.
 */
export function sortByLevels(
  kernel: SortKernel,
  perm: Uint32Array,
  levels: ReadonlyArray<{ keys: Uint32Array; maxKey: number }>
): void {
  for (let l = levels.length - 1; l >= 0; l -= 1) {
    sortBy(kernel, perm, levels[l].keys, levels[l].maxKey);
  }
}

// ==================== Étalonnage ====================

let chosen: SortKernel | null = null;

/**
 * Le noyau le plus rapide SUR CET APPAREIL, mesuré une fois : 20 000 lignes,
 * deux niveaux, clés tirées d'un générateur à graine fixe. Quelques
 * millisecondes, au premier tri d'une session.
 */
export function chooseSortKernel(now: () => number = defaultNow): SortKernel {
  if (chosen) return chosen;
  const n = 20000;
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed;
  };
  const keysA = new Uint32Array(n);
  const keysB = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) {
    keysA[i] = rand() % 5000;
    keysB[i] = rand() % 40;
  }
  const levels = [
    { keys: keysA, maxKey: 4999 },
    { keys: keysB, maxKey: 39 },
  ];
  const time = (kernel: SortKernel): number => {
    let best = Infinity;
    for (let round = 0; round < 3; round += 1) {
      const perm = new Uint32Array(n);
      for (let i = 0; i < n; i += 1) perm[i] = i;
      const t0 = now();
      sortByLevels(kernel, perm, levels);
      best = Math.min(best, now() - t0);
    }
    return best;
  };
  const radix = time('radix');
  const packed = time('packed');
  chosen = packed < radix ? 'packed' : 'radix';
  return chosen;
}

/** Tests et bancs : impose un noyau, ou `null` pour réétalonner. */
export function overrideSortKernel(kernel: SortKernel | null): void {
  chosen = kernel;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
