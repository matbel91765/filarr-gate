// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/index.ts @ e42515a6 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Le moteur maison des bases — point d'entrée.
 *
 * `viewRows` choisit le moteur d'une vue : `viewEngine` (lignes, lisible, qui
 * FAIT FOI) pour une base ordinaire, le moteur en colonnes au-delà de
 * `ENGINE_MIN_ROWS` lignes. Les deux rendent exactement les mêmes lignes, dans
 * le même ordre — c'est ce que le test différentiel vérifie sur des milliers de
 * bases tirées au hasard ; le seuil n'est qu'une affaire de coût : construire
 * des colonnes ne paie qu'à partir de quelques milliers de lignes.
 */

import type { DbRow, DbView, InlineDbData } from '../types';
import type { DbLinkContext } from '../relations';
import { applyView } from '../viewEngine';
import { engineApplyView } from './view';

/** À partir de combien de lignes le moteur en colonnes prend la main. */
export const ENGINE_MIN_ROWS = 2000;

export function viewRows(
  data: InlineDbData,
  view: DbView,
  ctx?: DbLinkContext | null,
  search?: string
): DbRow[] {
  return data.rows.length >= ENGINE_MIN_ROWS
    ? engineApplyView(data, view, ctx, search)
    : applyView(data, view, ctx, search);
}

export { engineApplyView, engineViewOrder } from './view';
export { LiveView, type RowChange } from './liveView';
export { certifiedRanks, approximateKey, compareText } from './collation';
export { chooseSortKernel, type SortKernel } from './sortKernels';
