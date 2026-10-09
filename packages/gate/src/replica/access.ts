/**
 * Ce que `GET /api-access/self` rend à la boîte noire (contrat `api-base-1` § 3 à § 5) :
 * les droits scellés, ouverts et VÉRIFIÉS à leur place, et le manifeste de chaque
 * magasin.
 *
 * - Un droit scellé dont `a`, `s`, `e` ou `g` ne correspond pas à sa place dans la
 *   liste est REFUSÉ, jamais utilisé (§ 3) : un scellé recopié sous un autre accès,
 *   une autre base ou un autre couple `(e, g)` ne doit rien ouvrir.
 * - Un manifeste qui ne nomme pas cet accès et ce magasin est refusé de même.
 * - Les vues sont relues par le cœur de Filarr (`parseDbData`), comme le fait
 *   l'application ; leur `slug` vient du manifeste, jamais recalculé ici.
 */

import { assignSlugs, openGrant, openSealedBox } from '../../../core/src/engine/store/apiAccess';
import { utf8Decode, type StoreCrypto, type StoreKeys } from '../../../core/src/engine/store/crypto';
import { parseDbData, type DbView } from '../../../core/src/types';
import { curves, storeCrypto } from '../crypto/providers';
import type { AccessIdentity } from './token';

export type Rights = 'r' | 'rw';

export const keyId = (e: number, g: number): string => `${e}|${g}`;

/** Les clés d'un magasin à partir d'une `K_db(e, g)` reçue (et non de la racine, que l'accès n'a pas). */
export async function keysFromKdb(
  c: StoreCrypto,
  storeId: string,
  epoch: number,
  generation: number,
  kDb: Uint8Array
): Promise<StoreKeys> {
  // `K_head` dérive de `K_db` exactement comme dans `storeKeys` (db-store-1 § 3).
  const kHead = await c.hkdf(kDb, new Uint8Array(0), 'filarr/dbstore/v1|head', 32);
  return { storeId, epoch, generation, kDb, kHead };
}

export interface SelfAccess {
  id?: string;
  name?: string;
  expiresAt?: string | null;
  paused?: boolean;
  tier?: string;
  [key: string]: unknown;
}

export interface SelfResponse {
  access?: SelfAccess;
  grants?: unknown;
  manifests?: unknown;
  limits?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

export interface OpenedGrant {
  storeId: string;
  rights: Rights;
  keys: Map<string, StoreKeys>;
}

export interface RefusedSeal {
  storeId: string;
  what: 'grant' | 'manifest';
  e?: number;
  g?: number;
  reason: string;
}

const STORE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const isNat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Ouvre chaque droit scellé de `self`, à SA place ; rend les refus à part. */
export async function openGrants(
  identity: AccessIdentity,
  raw: unknown
): Promise<{ grants: Map<string, OpenedGrant>; refused: RefusedSeal[] }> {
  const grants = new Map<string, OpenedGrant>();
  const refused: RefusedSeal[] = [];
  if (!Array.isArray(raw)) return { grants, refused };
  for (const item of raw) {
    const g = item as { storeId?: unknown; rights?: unknown; keys?: unknown } | null;
    if (!g || typeof g.storeId !== 'string' || !STORE_ID_RE.test(g.storeId)) continue;
    const storeId = g.storeId;
    // Un droit inconnu se lit comme le plus étroit : la lecture
    const rights: Rights = g.rights === 'rw' ? 'rw' : 'r';
    const keys = new Map<string, StoreKeys>();
    for (const k of Array.isArray(g.keys) ? g.keys : []) {
      const entry = k as { e?: unknown; g?: unknown; sealed?: unknown } | null;
      const e = entry?.e;
      const gen = entry?.g === undefined ? 0 : entry.g;
      if (!entry || !isNat(e) || !isNat(gen) || typeof entry.sealed !== 'string') {
        refused.push({ storeId, what: 'grant', reason: 'entrée de clé illisible' });
        continue;
      }
      try {
        const kDb = await openGrant(storeCrypto, curves, identity.aEnc, entry.sealed, {
          a: identity.accessId,
          s: storeId,
          e,
          g: gen,
        });
        keys.set(keyId(e, gen), await keysFromKdb(storeCrypto, storeId, e, gen, kDb));
      } catch (err) {
        refused.push({ storeId, what: 'grant', e, g: gen, reason: (err as Error).message });
      }
    }
    grants.set(storeId, { storeId, rights, keys });
  }
  return { grants, refused };
}

export interface ManifestInfo {
  storeId: string;
  rev: number;
  slug: string;
  title: string;
  rights: Rights;
  views: DbView[];
  /** `viewId → slug`, tel que le manifeste le donne. */
  viewSlugs: Map<string, string>;
  updated: string | null;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Ouvre le manifeste d'un magasin (§ 4) ; lève s'il n'est pas à sa place. */
export async function openManifest(
  identity: AccessIdentity,
  storeId: string,
  sealed: string,
  rev: number
): Promise<ManifestInfo> {
  const text = utf8Decode(await openSealedBox(storeCrypto, curves, identity.aEnc, sealed));
  const m = JSON.parse(text) as Record<string, unknown>;
  if (m.v !== 1) throw new Error(`manifeste de version inconnue (${String(m.v)})`);
  if (m.a !== identity.accessId || m.s !== storeId) throw new Error('manifeste hors de sa place');
  const rawViews = Array.isArray(m.views) ? (m.views as Array<Record<string, unknown>>) : [];
  const views = parseDbData(JSON.stringify({ properties: [], rows: [], views: rawViews })).views ?? [];
  // Le slug d'une vue vient du manifeste. Un slug absent ou malformé (publication fautive)
  // reçoit celui que le contrat calcule, dans l'ordre des vues, sans jamais en prendre un déjà pris.
  const given = new Map<string, string>();
  for (const v of rawViews) {
    if (typeof v.id === 'string' && typeof v.slug === 'string' && SLUG_RE.test(v.slug)) given.set(v.id, v.slug);
  }
  const fallback = assignSlugs(views.map((v) => v.name), 'vue');
  const viewSlugs = new Map<string, string>();
  const taken = new Set<string>();
  views.forEach((v, i) => {
    let slug = given.get(v.id) ?? fallback[i] ?? 'vue';
    for (let n = 2; taken.has(slug); n += 1) slug = `${given.get(v.id) ?? fallback[i] ?? 'vue'}-${n}`;
    taken.add(slug);
    viewSlugs.set(v.id, slug);
  });
  const title = typeof m.title === 'string' ? m.title : '';
  return {
    storeId,
    rev,
    slug: typeof m.slug === 'string' && SLUG_RE.test(m.slug) ? m.slug : assignSlugs([title], 'base')[0] ?? 'base',
    title,
    rights: m.rights === 'rw' ? 'rw' : 'r',
    views,
    viewSlugs,
    updated: typeof m.updated === 'string' ? m.updated : null,
  };
}

/** Les manifestes de `self`, ouverts ; un manifeste refusé est rendu à part. */
export async function openManifests(
  identity: AccessIdentity,
  raw: unknown
): Promise<{ manifests: Map<string, ManifestInfo>; refused: RefusedSeal[] }> {
  const manifests = new Map<string, ManifestInfo>();
  const refused: RefusedSeal[] = [];
  if (!Array.isArray(raw)) return { manifests, refused };
  for (const item of raw) {
    const m = item as { storeId?: unknown; sealed?: unknown; rev?: unknown } | null;
    if (!m || typeof m.storeId !== 'string' || typeof m.sealed !== 'string') continue;
    try {
      manifests.set(m.storeId, await openManifest(identity, m.storeId, m.sealed, isNat(m.rev) ? m.rev : 0));
    } catch (err) {
      refused.push({ storeId: m.storeId, what: 'manifest', reason: (err as Error).message });
    }
  }
  return { manifests, refused };
}
