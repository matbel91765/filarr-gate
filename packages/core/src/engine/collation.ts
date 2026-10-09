// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/collation.ts @ 73bae6d7 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Collation du moteur : l'ordre des textes, celui que l'utilisateur lit.
 *
 * LE COLLATEUR FAIT FOI — le même que `viewEngine` (`numeric` : « Item 2 » avant
 * « Item 10 » ; `base` : accents et casse ignorés). Mais il coûte : chaque appel
 * traverse la frontière vers ICU, et sur le mobile vers JNI ou NSString. Trier d
 * valeurs distinctes en demande d log d.
 *
 * LE DICTIONNAIRE CERTIFIÉ, en deux temps — aucune bibliothèque JavaScript ne
 * fait ainsi, à notre connaissance :
 *  1. un tri par CLÉ APPROCHÉE, calculée sans le collateur (décomposition,
 *     accents retirés, minuscules, ligatures dépliées, nombres alignés à droite)
 *     et comparée en simple ordre des unités de code — du JavaScript pur, sans
 *     frontière à traverser ;
 *  2. une CERTIFICATION par le vrai collateur : chaque valeur est comparée à sa
 *     voisine certifiée (d − 1 appels). Une paire hors d'ordre est RÉPARÉE par
 *     insertion dichotomique dans le préfixe certifié (log d appels).
 *
 * La clé approchée est presque toujours juste pour du texte latin : le coût
 * tombe à environ d appels au lieu de d log d. Elle peut se tromper (autre
 * écriture, ponctuation, règles de langue) : la certification rattrape tout, et
 * le résultat est EXACTEMENT celui du collateur, quelle que soit la clé. Une clé
 * vraiment mauvaise (trop de réparations) bascule sur un tri complet.
 */

let collatorCache: Intl.Collator | null = null;

/** Le collateur de l'application — mêmes réglages que `viewEngine`. */
export function appCollator(): Intl.Collator {
  if (!collatorCache) {
    collatorCache = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  }
  return collatorCache;
}

export function compareText(a: string, b: string): number {
  return appCollator().compare(a, b);
}

// ==================== Clé approchée ====================

const LIGATURES: Record<string, string> = {
  œ: 'oe',
  Œ: 'oe',
  æ: 'ae',
  Æ: 'ae',
  ß: 'ss',
  ø: 'o',
  Ø: 'o',
  đ: 'd',
  Đ: 'd',
  ł: 'l',
  Ł: 'l',
  þ: 'th',
  Þ: 'th',
};
const LIGATURE_RE = /[œŒæÆßøØđĐłŁþÞ]/g;
const COMBINING_RE = /[̀-ͯ]/g;
const DIGITS_RE = /\d+/g;
const DIGIT_TEST_RE = /\d/;
const LEADING_ZEROS_RE = /^0+(?=\d)/;
/** Largeur d'alignement des nombres : au-delà, l'ordre n'est plus garanti, la certification rattrape. */
const NUMBER_WIDTH = 16;

/**
 * La clé approchée d'un texte : comparée en ordre des unités de code, elle suit
 * le collateur dans l'immense majorité des cas latins. Elle n'est qu'une
 * PRÉSOMPTION — la certification décide.
 */
export function approximateKey(s: string): string {
  // Chemin court : de l'ASCII n'a ni accent ni ligature à défaire
  let ascii = true;
  let digits = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c > 127) {
      ascii = false;
      break;
    }
    if (c >= 48 && c <= 57) digits = true;
  }
  let k: string;
  if (ascii) {
    k = s.toLowerCase();
  } else {
    k = s.normalize('NFD').replace(COMBINING_RE, '');
    k = k.replace(LIGATURE_RE, (c) => LIGATURES[c] ?? c).toLowerCase();
    digits = DIGIT_TEST_RE.test(k);
  }
  // `numeric` : une suite de chiffres se compare par sa valeur
  if (digits) {
    k = k.replace(DIGITS_RE, (run) => {
      const trimmed = run.replace(LEADING_ZEROS_RE, '');
      return trimmed.length >= NUMBER_WIDTH ? trimmed : trimmed.padStart(NUMBER_WIDTH, '0');
    });
  }
  return k;
}

// ==================== Rangs certifiés ====================

export interface CertifiedRanks {
  /** Les valeurs dans l'ordre du collateur. */
  order: string[];
  /** Rang dense de chaque valeur de `order` (égalités du collateur partagées). */
  ranks: Int32Array;
  /** Nombre de rangs distincts. */
  d: number;
  /** Appels au collateur (diagnostic, bancs). */
  calls: number;
  /** Paires réparées par insertion. */
  repairs: number;
  /** Vrai si la clé approchée était trop mauvaise et qu'on a tout retrié. */
  fellBack: boolean;
}

/**
 * Trie des valeurs DISTINCTES dans l'ordre du collateur et leur donne des rangs
 * denses — exactement ce que rendrait `values.sort(compare)` suivi d'un
 * regroupement des égaux, avec beaucoup moins d'appels au collateur.
 */
export function certifiedRanks(
  values: readonly string[],
  compare: (a: string, b: string) => number = compareText,
  /** La clé approchée — imposable pour les tests (une clé hostile reste exacte). */
  keyOf: (s: string) => string = approximateKey
): CertifiedRanks {
  let calls = 0;
  const cmp = (a: string, b: string): number => {
    calls += 1;
    return compare(a, b);
  };
  const d0 = values.length;
  if (d0 === 0) {
    return { order: [], ranks: new Int32Array(0), d: 0, calls, repairs: 0, fellBack: false };
  }

  // 1. Tri par clé approchée — sans le collateur, et sans comparateur
  //    JavaScript : clé et index sont mis bout à bout dans une seule chaîne,
  //    triée par le tri natif des chaînes (aucun rappel par comparaison).
  //    L'index, à largeur fixe après un séparateur nul, départage deux clés
  //    égales sans jamais passer devant une clé plus longue.
  const width = String(d0).length;
  const tagged = new Array<string>(d0);
  for (let i = 0; i < d0; i += 1) {
    tagged[i] = keyOf(values[i]) + '\u0000' + String(i).padStart(width, '0');
  }
  tagged.sort();
  const keyed = tagged.map((t) => ({ v: values[Number(t.slice(t.length - width))] }));

  // 2. Certification : chaque valeur contre sa voisine certifiée.
  const out: string[] = [];
  /** `tie[i]` : out[i] est égal (collateur) à out[i − 1] ; `null` = inconnu. */
  const tie: Array<boolean | null> = [];
  let repairs = 0;
  // Au-delà de ce nombre de réparations, la clé est mauvaise : tri complet.
  const repairBudget = Math.max(16, Math.ceil(d0 / 4));
  let fellBack = false;

  for (const { v } of keyed) {
    if (out.length === 0) {
      out.push(v);
      tie.push(false);
      continue;
    }
    const c = cmp(out[out.length - 1], v);
    if (c <= 0) {
      out.push(v);
      tie.push(c === 0);
      continue;
    }
    // Hors d'ordre : insertion dichotomique dans le préfixe certifié.
    repairs += 1;
    if (repairs > repairBudget) {
      fellBack = true;
      break;
    }
    let lo = 0;
    let hi = out.length - 1; // out[hi] > v est déjà établi
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cmp(out[mid], v) <= 0) lo = mid + 1;
      else hi = mid;
    }
    out.splice(lo, 0, v);
    tie.splice(lo, 0, null);
    // La voisine de droite a changé : son égalité est à redemander.
    if (lo + 1 < tie.length) tie[lo + 1] = null;
  }

  if (fellBack) {
    const sorted = values.slice().sort(cmp);
    return finish(
      sorted,
      sorted.map((_, i) => (i === 0 ? false : null)),
      cmp,
      () => ({
        calls,
        repairs,
        fellBack: true,
      })
    );
  }
  return finish(out, tie, cmp, () => ({ calls, repairs, fellBack: false }));
}

function finish(
  order: string[],
  tie: Array<boolean | null>,
  cmp: (a: string, b: string) => number,
  stats: () => { calls: number; repairs: number; fellBack: boolean }
): CertifiedRanks {
  const ranks = new Int32Array(order.length);
  let r = 0;
  for (let i = 0; i < order.length; i += 1) {
    if (i > 0) {
      let equal = tie[i];
      if (equal === null) equal = cmp(order[i - 1], order[i]) === 0;
      if (!equal) r += 1;
    }
    ranks[i] = r;
  }
  return { order, ranks, d: order.length === 0 ? 0 : r + 1, ...stats() };
}
