/**
 * Ce que l'API locale voit de la réplique : les bases exposées (celles dont le
 * manifeste est ouvert), leurs champs, leurs vues, et le contexte de liaison
 * qui résout les relations ENTRE bases ouvertes. Une relation vers une base que
 * l'accès n'ouvre pas ne se résout pas : identifiants bruts, agrégats nuls
 * (contrat `api-base-1` § 8).
 */

import type { InlineDbIndexEntry } from '../../../core/src/dbIndex';
import { catalogFromDatabases } from '../../../core/src/engine/sql/catalog';
import type { SqlCatalog } from '../../../core/src/engine/sql/run';
import { buildMcd } from '../../../core/src/merise/mcd';
import { buildMld, type MldTable } from '../../../core/src/merise/mld';
import { makeLinkContext, type DbEnv, type DbLinkContext } from '../../../core/src/relations';
import { parseDbData, type DbProperty, type DbRow, type DbView, type InlineDbData } from '../../../core/src/types';
import type { GateBase, Replicator } from '../replica/replicator';
import type { MirrorStatus } from '../replica/store';
import { fieldsOf, type FieldDef, type FieldNameStore } from './fields';

export interface ViewInfo {
  view: DbView;
  slug: string;
}

export interface BaseInfo {
  base: GateBase;
  storeId: string;
  slug: string;
  title: string;
  rights: 'r' | 'rw';
  properties: DbProperty[];
  rows: DbRow[];
  views: ViewInfo[];
  version: number;
  status: MirrorStatus;
  fields: FieldDef[];
  dbId: string | null;
}

/** Le libellé de la table d'une base non ouverte, dans le SQL (MLD). */
export const MISSING_TABLE_LABEL = 'Base non ouverte';

export class GateModel {
  private propsCache = new Map<string, { key: string; properties: DbProperty[] }>();
  private ctxCache: { key: string; ctx: DbLinkContext } | null = null;
  private sqlCache = new Map<string, { catalog: SqlCatalog; mld: MldTable[]; entries: InlineDbIndexEntry[] }>();

  constructor(
    readonly replicator: Replicator,
    readonly fieldNames: FieldNameStore
  ) {}

  /** Les propriétés du schéma de la tête, relues comme l'application les relit. */
  private propertiesOf(base: GateBase): DbProperty[] {
    const head = base.mirror.head;
    if (!head) return [];
    const key = `${base.mirror.seq}|${head.schema.t}`;
    const cached = this.propsCache.get(base.storeId);
    if (cached?.key === key) return cached.properties;
    const properties = parseDbData(JSON.stringify({ properties: head.schema.properties, rows: [] })).properties;
    this.propsCache.set(base.storeId, { key, properties });
    return properties;
  }

  private info(base: GateBase): BaseInfo | null {
    const m = base.manifest;
    if (!m) return null;
    const properties = this.propertiesOf(base);
    return {
      base,
      storeId: base.storeId,
      slug: m.slug,
      title: m.title,
      rights: base.rights,
      properties,
      rows: base.mirror.rows,
      views: m.views.map((view) => ({ view, slug: m.viewSlugs.get(view.id) ?? view.id })),
      version: base.mirror.seq,
      status: base.mirror.status,
      fields: fieldsOf(this.fieldNames, base.storeId, properties),
      dbId: base.mirror.head?.dbId ?? null,
    };
  }

  /** Les bases exposées (manifeste ouvert), dans l'ordre de leurs slugs. */
  bases(): BaseInfo[] {
    const out: BaseInfo[] = [];
    for (const base of this.replicator.bases.values()) {
      const info = this.info(base);
      if (info) out.push(info);
    }
    return out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  }

  base(slug: string): BaseInfo | undefined {
    const base = this.replicator.bySlug(slug);
    return base ? (this.info(base) ?? undefined) : undefined;
  }

  baseById(storeId: string): BaseInfo | undefined {
    const base = this.replicator.bases.get(storeId);
    return base ? (this.info(base) ?? undefined) : undefined;
  }

  /** Les relations se résolvent entre bases OUVERTES, par l'identité du bloc propriétaire (`head.dbId`). */
  linkContext(): DbLinkContext {
    const key = [...this.replicator.bases.values()].map((b) => `${b.storeId}:${b.mirror.seq}`).join(',');
    if (this.ctxCache?.key === key) return this.ctxCache.ctx;
    const ctx = makeLinkContext((dbId) => {
      const base = this.replicator.byDbId(dbId);
      if (!base || !base.mirror.loaded) return undefined;
      return {
        properties: this.propertiesOf(base),
        rows: base.mirror.rows,
        label: base.manifest?.title ?? '',
        storeId: base.storeId,
      };
    });
    this.ctxCache = { key, ctx };
    return ctx;
  }

  env(info: BaseInfo): DbEnv {
    return { properties: info.properties, ctx: { ...this.linkContext(), selfDbId: info.dbId ?? '' } };
  }

  /** Les données d'une base sous la forme du moteur de vues. */
  data(info: BaseInfo): InlineDbData {
    return { properties: info.properties, rows: info.rows, views: info.views.map((v) => v.view) };
  }

  /**
   * Le catalogue SQL de bases ouvertes — exactement celui de la vue Requête de
   * Filarr (noms de tables et de colonnes du modèle logique, affinités).
   */
  sql(storeIds?: ReadonlySet<string>): { catalog: SqlCatalog; mld: MldTable[]; entries: InlineDbIndexEntry[] } {
    const infos = this.bases().filter((b) => (!storeIds || storeIds.has(b.storeId)) && b.dbId);
    const key = infos.map((b) => `${b.storeId}:${b.version}`).join(',');
    const cached = this.sqlCache.get(key);
    if (cached) return cached;
    const entries: InlineDbIndexEntry[] = infos.map((b) => ({
      dbId: b.dbId!,
      noteId: '',
      noteTitle: b.title,
      title: b.title,
      properties: b.properties,
      rows: b.rows,
    }));
    const mld = buildMld(buildMcd(entries, MISSING_TABLE_LABEL));
    const out = { catalog: catalogFromDatabases(entries, mld), mld, entries };
    if (this.sqlCache.size > 16) this.sqlCache.clear();
    this.sqlCache.set(key, out);
    return out;
  }
}
