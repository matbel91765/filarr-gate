/**
 * Écrire (contrat `api-base-1` § 7) : une requête de l'API devient des écritures
 * « dernier écrit gagne », validées par Filarr comme celles de n'importe quel
 * appareil. Ouvert seulement quand l'interrupteur de la boîte noire est allumé,
 * que le droit de l'accès est `rw`, et que la clé de l'application le permet.
 *
 * Une écriture restreinte à certaines colonnes ou à une vue est appliquée ICI,
 * par la boîte noire : le chiffrement, lui, ouvre tout le magasin (§ 7).
 */

import { defaultCells } from '../../../core/src/dbCore';
import { positionBetween } from '../../../core/src/engine/store/fracIndex';
import { FIELD_CREATED, FIELD_DELETED, FIELD_ORDER, type StoreOp } from '../../../core/src/engine/store/registers';
import { FilarrError, RateLimitError, UnreachableError } from '../replica/http';
import type { Replicator } from '../replica/replicator';
import { KeyMissingError, WriteRefusedError } from '../replica/store';
import { cellFromJson, FieldError, rowJson } from './fields';
import type { BaseInfo, GateModel } from './model';
import { ApiError } from './query';
import { randomBytes, toHex } from '../util/bytes';

/** Un identifiant de ligne neuf, de la forme de ceux de l'application. */
export const newRowId = (): string => `db-${Date.now()}-${BigInt(`0x${toHex(randomBytes(6))}`).toString(36)}`;

export interface WriteResult {
  version: number;
  rows: Array<Record<string, unknown>>;
}

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof FieldError) return new ApiError(400, err.code, err.message, { field: err.field });
  if (err instanceof KeyMissingError)
    return new ApiError(409, 'key_missing', `Écriture impossible : ${err.message}. Le créateur de l'accès doit ouvrir Filarr pour resceller.`, { keys: err.keys });
  if (err instanceof RateLimitError)
    return new ApiError(429, err.code, `Filarr limite cet accès (${err.code})`, { retryAfter: Math.ceil(err.retryAfterMs / 1000) });
  if (err instanceof UnreachableError) return new ApiError(503, 'filarr_unreachable', 'Filarr est injoignable : l’écriture n’est pas faite.');
  if (err instanceof WriteRefusedError) {
    if (err.code === 'store_not_granted') return new ApiError(403, 'base_read_only', 'Filarr n’ouvre cette base qu’en lecture à cet accès.');
    const status = ['api_tier_write', 'api_write_unavailable', 'vault_frozen'].includes(err.code) ? (err.code === 'vault_frozen' ? 409 : 403) : err.status;
    return new ApiError(status, err.code, err.message);
  }
  if (err instanceof FilarrError) return new ApiError(err.status === 429 ? 429 : 502, err.code, `Filarr a refusé l’écriture (${err.code})`);
  return new ApiError(500, 'write_failed', (err as Error).message);
}

export class Writer {
  constructor(
    private readonly model: GateModel,
    private readonly replicator: Replicator,
    private readonly enabled: () => boolean
  ) {}

  private guard(info: BaseInfo): void {
    if (!this.enabled())
      throw new ApiError(403, 'write_disabled', 'L’écriture vers Filarr est éteinte sur cette boîte noire (réglage « write »).');
    if (this.replicator.access?.write === false)
      throw new ApiError(403, 'filarr_write_unavailable', 'Filarr n’ouvre pas l’écriture à cet accès (palier sans écriture, ou écriture des accès API pas encore ouverte).');
    if (info.rights !== 'rw') throw new ApiError(403, 'base_read_only', 'Cet accès ne peut que lire cette base.');
  }

  /**
   * Les valeurs par défaut d'une ligne NEUVE, comme « Nouvelle ligne » dans
   * Filarr (`defaultCells` du cœur, celle de `makeRow`) : l'option par défaut
   * de chaque colonne select ou multiSelect qui en a une — un « Statut » à
   * « À faire » plutôt que vide. Un champ présent dans l'objet reçu, même à
   * `null`, a le dernier mot (`null` = laisser vide, comme `undefined` dans
   * `makeRow`).
   */
  private defaultOps(info: BaseInfo, rowId: string, input: unknown, tick: () => string): StoreOp[] {
    const given = new Set<string>();
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      for (const name of Object.keys(input as Record<string, unknown>)) {
        const field = info.fields.find((f) => f.name === name);
        if (field) given.add(field.prop.id);
      }
    }
    const ops: StoreOp[] = [];
    for (const [propId, value] of Object.entries(defaultCells(info.properties))) {
      if (!given.has(propId)) ops.push({ r: rowId, f: propId, v: value, t: tick() });
    }
    return ops;
  }

  /** Les écritures d'un objet reçu, pour une ligne. */
  private cellOps(info: BaseInfo, rowId: string, input: unknown, tick: () => string): StoreOp[] {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'bad_body', 'Un objet JSON est attendu');
    const ops: StoreOp[] = [];
    for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
      if (name === 'id' || name === 'created_at' || name === 'updated_at') continue;
      const field = info.fields.find((f) => f.name === name);
      if (!field) throw new FieldError('unknown_field', name, `Champ inconnu : ${name}`);
      const cell = cellFromJson(field, value);
      ops.push({ r: rowId, f: field.prop.id, v: cell, t: tick() });
    }
    return ops;
  }

  private async commit(info: BaseInfo, ops: StoreOp[]): Promise<number> {
    const mirror = info.base.mirror;
    try {
      const { seq, diff } = await mirror.commit(ops);
      this.replicator.publishLocalDiff(info.base, diff);
      return seq;
    } catch (err) {
      throw toApiError(err);
    }
  }

  private json(info: BaseInfo, id: string): Record<string, unknown> {
    const fresh = this.model.baseById(info.storeId) ?? info;
    const row = fresh.base.mirror.rowById(id);
    return row ? rowJson(fresh.fields, row, this.model.env(fresh)) : { id };
  }

  async create(info: BaseInfo, body: unknown): Promise<WriteResult> {
    this.guard(info);
    const items = Array.isArray(body) ? body : [body];
    if (items.length === 0) throw new ApiError(400, 'bad_body', 'Aucune ligne');
    if (items.length > 500) throw new ApiError(413, 'too_many_rows', '500 lignes au plus par requête');
    const mirror = info.base.mirror;
    const tick = () => mirror.tick();
    const ops: StoreOp[] = [];
    const ids: string[] = [];
    let order = mirror.lastOrder();
    const now = new Date().toISOString();
    try {
      for (const item of items) {
        const id = newRowId();
        ids.push(id);
        // Les champs reçus d'abord : un objet refusé ne laisse rien partir.
        const given = this.cellOps(info, id, item, tick);
        ops.push(...this.defaultOps(info, id, item, tick), ...given);
        order = positionBetween(order, null);
        ops.push({ r: id, f: FIELD_CREATED, v: now, t: tick() }, { r: id, f: FIELD_ORDER, v: order, t: tick() });
      }
    } catch (err) {
      throw toApiError(err);
    }
    const version = await this.commit(info, ops);
    return { version, rows: ids.map((id) => this.json(info, id)) };
  }

  async update(info: BaseInfo, rowId: string, body: unknown): Promise<WriteResult> {
    this.guard(info);
    const mirror = info.base.mirror;
    if (!mirror.rowById(rowId)) throw new ApiError(404, 'row_not_found', `Ligne introuvable : ${rowId}`);
    let ops: StoreOp[];
    try {
      ops = this.cellOps(info, rowId, body, () => mirror.tick());
    } catch (err) {
      throw toApiError(err);
    }
    if (ops.length === 0) return { version: mirror.seq, rows: [this.json(info, rowId)] };
    const version = await this.commit(info, ops);
    return { version, rows: [this.json(info, rowId)] };
  }

  async remove(info: BaseInfo, rowId: string): Promise<WriteResult> {
    this.guard(info);
    const mirror = info.base.mirror;
    if (!mirror.rowById(rowId)) throw new ApiError(404, 'row_not_found', `Ligne introuvable : ${rowId}`);
    // La suppression gagne contre une modification concurrente ; restaurer reste possible dans Filarr (db-store-1 § 4)
    const version = await this.commit(info, [{ r: rowId, f: FIELD_DELETED, v: true, t: mirror.tick() }]);
    return { version, rows: [] };
  }
}
