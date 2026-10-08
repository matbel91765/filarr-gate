// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/store/materialize.ts @ 52570752 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * LA BASE EN LIGNE D'UN MAGASIN — ce qu'un export ou une page publiée matérialise
 * à la place d'un renvoi (contrat `db-store-1`, § 9.6 : « dans le format en ligne
 * d'aujourd'hui »).
 *
 * Pur, sans plateforme, porté tel quel par le mobile : la même base doit donner la
 * même base en ligne sur les trois surfaces (l'empreinte d'une page publiée,
 * « modifiée depuis la publication », se calcule sur ce qu'elle rend). Ordre des
 * clés FIXÉ : les clés de racine inconnues gardées par la tête (`extra`), puis
 * `properties`, `rows` (dans l'ordre manuel de la réplique), `rowTemplates`,
 * `views` et `activeViewId` du renvoi.
 *
 * Le source passe sous `strict` ET `noUncheckedIndexedAccess`.
 */

import type { DbRow } from '../../types';
import type { StoreSchema } from './codec';

export function inlineDataOfStore(
  schema: Pick<StoreSchema, 'properties' | 'rowTemplates' | 'extra'>,
  rows: readonly DbRow[],
  views: unknown,
  activeViewId: unknown
): Record<string, unknown> {
  return {
    ...(schema.extra ?? {}),
    properties: schema.properties,
    rows,
    ...(schema.rowTemplates ? { rowTemplates: schema.rowTemplates } : {}),
    ...(Array.isArray(views) ? { views } : {}),
    ...(typeof activeViewId === 'string' && activeViewId !== '' ? { activeViewId } : {}),
  };
}
