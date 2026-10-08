// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/liveView.ts @ f4ce9d22 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Une vue VIVANTE : filtrée, cherchée et triée une fois, puis tenue à jour LIGNE
 * PAR LIGNE (maintenance incrémentale, à la manière de DBSP).
 *
 * Une cellule modifiée dans une vue triée de 100 000 lignes ne retrie rien : la
 * ligne est retirée de sa place (recherche dichotomique avec ses ANCIENNES
 * clés), réévaluée (passe-t-elle les filtres ? quelles clés ?), puis remise à sa
 * nouvelle place (recherche dichotomique avec les nouvelles). Coût : quelques
 * dizaines de comparaisons et un déplacement de mémoire, au lieu d'un tri entier.
 *
 * L'ORDRE D'ORIGINE (le départage de deux lignes égales) est porté par des
 * ÉTIQUETTES d'ordre (order-maintenance) : une ligne insérée entre deux autres
 * reçoit une étiquette entre les leurs, sans renuméroter la base. Quand les
 * étiquettes n'ont plus de place entre elles, elles sont réparties de nouveau.
 *
 * LA SÉMANTIQUE est celle de `viewEngine` — le prédicat des filtres
 * (`compileViewFilter`), l'ordre (`compileSort`) et le texte de recherche
 * (`haystackReader`) sont les siens, pas des copies. Le test de modèle compare la
 * vue vivante, après CHAQUE opération, au recalcul complet par `applyView`.
 *
 * LIMITE ASSUMÉE : une relation ou un agrégat se lit dans D'AUTRES lignes (une
 * base qui se vise elle-même, des rétroliens) — modifier une ligne peut changer
 * la valeur d'une autre. Si un filtre ou un tri de la vue en touche un, chaque
 * modification refait la vue entière : c'est juste, simplement pas incrémental.
 * Un changement de SCHÉMA (propriétés, options) demande une nouvelle vue vivante.
 */

import type { DbRow, DbView, InlineDbData } from '../types';
import type { DbLinkContext } from '../relations';
import {
  compileSort,
  compileViewFilter,
  haystackReader,
  normalizeSearch,
  type CompiledSort,
  type RowTest,
  type SortKey,
} from '../viewEngine';
import { engineViewOrder } from './view';

export type RowChange =
  /** La ligne à la position `index` de la base est remplacée par `row`. */
  | { kind: 'update'; index: number; row: DbRow }
  /** `row` est insérée à la position `index` (les suivantes reculent d'un cran). */
  | { kind: 'insert'; index: number; row: DbRow }
  /** La ligne à la position `index` disparaît. */
  | { kind: 'delete'; index: number };

/** Écart initial entre deux étiquettes d'ordre. */
const LABEL_GAP = 1 << 20;

export class LiveView {
  private readonly properties: InlineDbData['properties'];
  private readonly ctx: DbLinkContext | null;
  private readonly view: DbView;
  private readonly search: string;
  private filter: RowTest | null = null;
  private sort: CompiledSort | null = null;
  private needle = '';
  private hay: ((row: DbRow) => string) | null = null;
  /** Vrai si une ligne peut changer la valeur d'une AUTRE (relations, agrégats). */
  private readonly global: boolean;

  /** Emplacements (identité interne stable d'une ligne) dans l'ordre de la base. */
  private order: number[] = [];
  /** Par emplacement : la ligne, son étiquette d'ordre, ses clés, et si elle se voit. */
  private rowOf: DbRow[] = [];
  private labelOf: number[] = [];
  private keysOf: Array<SortKey[] | null> = [];
  private shown: boolean[] = [];
  /** Emplacements visibles, dans l'ordre de la vue. */
  private visible: number[] = [];
  private nextSlot = 0;
  /**
   * Retraits où la recherche dichotomique n'a pas trouvé l'emplacement (et où
   * le repli linéaire l'a fait). Toujours 0 si l'invariant tient : le test de
   * modèle le vérifie, pour qu'une erreur de clés ne se cache pas derrière le
   * repli.
   */
  private misses = 0;

  /** Diagnostic : retraits rattrapés par le repli linéaire. */
  get removalMisses(): number {
    return this.misses;
  }

  constructor(data: InlineDbData, view: DbView, ctx?: DbLinkContext | null, search = '') {
    this.properties = data.properties;
    this.ctx = ctx ?? null;
    this.view = view;
    this.search = search;
    this.global = touchesOtherRows(data, view);
    this.rebuild(data.rows);
  }

  /** Les lignes de la vue, dans son ordre. */
  rows(): DbRow[] {
    return this.visible.map((slot) => this.rowOf[slot]);
  }

  /** Les lignes de la BASE, dans leur ordre (le miroir tenu par la vue vivante). */
  baseRows(): DbRow[] {
    return this.order.map((slot) => this.rowOf[slot]);
  }

  /** Applique une modification d'UNE ligne. */
  apply(change: RowChange): void {
    if (this.global) {
      // Une autre ligne a pu changer de valeur : on refait tout, exactement.
      const rows = this.baseRows();
      if (change.kind === 'update') rows[change.index] = change.row;
      else if (change.kind === 'insert') rows.splice(change.index, 0, change.row);
      else rows.splice(change.index, 1);
      this.rebuild(rows);
      return;
    }
    if (change.kind === 'update') {
      const slot = this.order[change.index];
      this.hide(slot);
      this.rowOf[slot] = change.row;
      this.evaluate(slot);
      return;
    }
    if (change.kind === 'insert') {
      const slot = this.nextSlot++;
      this.rowOf[slot] = change.row;
      this.labelOf[slot] = this.labelBetween(change.index);
      this.order.splice(change.index, 0, slot);
      this.shown[slot] = false;
      this.keysOf[slot] = null;
      this.evaluate(slot);
      return;
    }
    const slot = this.order[change.index];
    this.hide(slot);
    this.order.splice(change.index, 1);
  }

  // ---------- Interne ----------

  /** Tout recalculer à partir des lignes de la base. */
  private rebuild(rows: DbRow[]): void {
    const data = { properties: this.properties, rows } as InlineDbData;
    this.filter = compileViewFilter(data, this.view, this.ctx);
    this.sort = compileSort(data, this.view.sorts, this.ctx);
    this.needle = normalizeSearch(this.search);
    this.hay = this.needle === '' ? null : haystackReader(this.properties);
    this.order = [];
    this.rowOf = [];
    this.labelOf = [];
    this.keysOf = [];
    this.shown = new Array<boolean>(rows.length).fill(false);
    this.nextSlot = rows.length;
    for (let i = 0; i < rows.length; i += 1) {
      // À la construction, l'emplacement d'une ligne EST sa position
      this.order.push(i);
      this.rowOf[i] = rows[i];
      this.labelOf[i] = (i + 1) * LABEL_GAP;
      this.keysOf[i] = null;
    }
    // L'ordre initial vient du moteur en colonnes (tri sans comparateur), qui
    // rend exactement l'ordre de `viewEngine` ; les clés ne sont lues que pour
    // les lignes visibles, celles que les modifications compareront ensuite.
    const order = engineViewOrder(data, this.view, this.ctx, this.search);
    this.visible = Array.from(order);
    for (const slot of this.visible) {
      this.shown[slot] = true;
      if (this.sort) this.keysOf[slot] = this.sort.keysOf(rows[slot]);
    }
  }

  private passes(row: DbRow): boolean {
    if (this.filter && !this.filter(row)) return false;
    if (this.hay && !this.hay(row).includes(this.needle)) return false;
    return true;
  }

  /** L'ordre de la vue : les clés, puis l'ordre d'origine (étiquette). */
  private compareSlots(a: number, b: number): number {
    if (this.sort) {
      const c = this.sort.compare(this.keysOf[a] as SortKey[], this.keysOf[b] as SortKey[]);
      if (c !== 0) return c;
    }
    return this.labelOf[a] - this.labelOf[b];
  }

  /** Première position de `visible` dont l'emplacement vient APRÈS `slot`. */
  private lowerBound(slot: number): number {
    let lo = 0;
    let hi = this.visible.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compareSlots(this.visible[mid], slot) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Retire un emplacement de la vue — avec ses clés ACTUELLES, qui l'y ont placé. */
  private hide(slot: number): void {
    if (!this.shown[slot]) return;
    const at = this.lowerBound(slot);
    // L'étiquette est unique : la position trouvée est exactement la sienne
    if (this.visible[at] === slot) {
      this.visible.splice(at, 1);
    } else {
      this.misses += 1;
      this.visible.splice(this.visible.indexOf(slot), 1);
    }
    this.shown[slot] = false;
    this.keysOf[slot] = null;
  }

  /** Réévalue un emplacement et le remet à sa place s'il se voit. */
  private evaluate(slot: number): void {
    const row = this.rowOf[slot];
    if (!this.passes(row)) return;
    this.keysOf[slot] = this.sort ? this.sort.keysOf(row) : null;
    this.visible.splice(this.lowerBound(slot), 0, slot);
    this.shown[slot] = true;
  }

  /** Une étiquette entre les lignes des positions `index − 1` et `index`. */
  private labelBetween(index: number): number {
    const before = index > 0 ? this.labelOf[this.order[index - 1]] : 0;
    const after =
      index < this.order.length ? this.labelOf[this.order[index]] : before + 2 * LABEL_GAP;
    const mid = (before + after) / 2;
    if (mid > before && mid < after) return mid;
    // Plus de place : on répartit de nouveau toutes les étiquettes, puis on
    // recommence. La vue ne bouge pas (l'ordre relatif est conservé).
    this.order.forEach((slot, i) => {
      this.labelOf[slot] = (i + 1) * LABEL_GAP;
    });
    return this.labelBetween(index);
  }
}

/** Un filtre ou un tri de la vue lit-il d'autres lignes (relation, agrégat) ? */
function touchesOtherRows(data: InlineDbData, view: DbView): boolean {
  const props = new Map(data.properties.map((p) => [p.id, p]));
  const derived = (id: string) => {
    const type = props.get(id)?.type;
    return type === 'relation' || type === 'rollup';
  };
  if (view.sorts.some((s) => derived(s.propertyId))) return true;
  if (view.filters.some((f) => derived(f.propertyId))) return true;
  return (view.filterGroups ?? []).some((g) => g.filters.some((f) => derived(f.propertyId)));
}
