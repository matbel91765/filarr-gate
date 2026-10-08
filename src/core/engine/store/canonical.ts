// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/store/canonical.ts @ 68abe8ff — relicencié Apache-2.0 par le titulaire des droits.
/**
 * JSON CANONIQUE du magasin des bases — contrat `db-store-1`, § 5.2.
 *
 * Clés triées en ordre des unités de code UTF-16 (`<` de JavaScript, jamais
 * `localeCompare`), aucun espace, nombres au format de `JSON.stringify`. Deux
 * surfaces qui encodent le même état produisent les mêmes octets — c'est ce que
 * les vecteurs dorés vérifient sous V8 et Hermes. Sert aussi à départager deux
 * registres de même heure (§ 4) : il ne dépend d'aucune bibliothèque.
 */

/** Comparaison des chaînes en unités de code UTF-16 — l'ordre de `<`. */
export const codeUnitOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => codeUnitOrder(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return 'null';
}
