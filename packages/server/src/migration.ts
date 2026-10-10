/**
 * Le paquet de réglages d'une boîte noire (`gate-settings-1`, `gate-heberge-1`
 * § 8.6), dans les deux sens.
 *
 * - Ce qui part : les clés d'application (EMPREINTES : un logiciel garde sa clé
 *   `gk_…` en changeant de boîte), les webhooks et leurs secrets (le récepteur
 *   garde sa vérification de signature), les requêtes enregistrées, le filtre de
 *   la fente à fichiers, CORS et l'écriture ; les ombres des synchros externes
 *   (chiffrées sous une clé tirée de `K_db`, que la nouvelle boîte dérive aussi).
 * - Ce qui ne part JAMAIS : le mot de passe d'administration, les clés des bases
 *   externes (D4 : une clé ne transite pas par Filarr ; la nouvelle boîte dit
 *   « clé manquante pour <hôte> »).
 * - Les champs propres à Filarr Gate (préfixe d'une clé, droits SQL et MCP, nom
 *   d'un webhook…) voyagent en champs supplémentaires, que tout lecteur conserve.
 */

import { openSettings, type GateSettings, type SettingsAppKey, type SettingsWebhook } from '../../core/src/engine/gate/settings';
import { sealToKey } from '../../core/src/engine/store/apiAccess';
import { utf8Encode } from '../../core/src/engine/store/crypto';
import { curves, storeCrypto } from '../../gate/src/crypto/providers';
import { ApiError } from '../../gate/src/errors';
import { openToken, wipeIdentity } from '../../gate/src/replica/token';
import { assignSlugs } from '../../core/src/engine/store/apiAccess';
import { randomUUID } from '../../gate/src/util/bytes';
import type { GateCore } from './core';
import type { AppKeyRecord, KeyScope, SavedQuery, WebhookEvent, WebhookRecord } from './state';

const WEBHOOK_EVENTS: readonly WebhookEvent[] = ['row.created', 'row.updated', 'row.deleted', 'gate.quota', 'file.filed', 'sync.done', 'sync.failed'];

export function buildSettingsPackage(core: GateCore): GateSettings {
  const s = core.settings;
  const d = core.state.data;
  const identity = core.replicator.identity;
  return {
    ...(d.importedExtra ?? {}),
    v: 1,
    kind: 'filarr-gate/settings',
    accessId: identity?.accessId ?? '',
    createdAt: new Date().toISOString(),
    appKeys: d.keys.map(
      (k): SettingsAppKey => ({
        id: k.id,
        name: k.name,
        hash: k.hash,
        scopes: k.scopes,
        ratePerMinute: k.rateLimit,
        ips: k.ipAllow,
        expiresAt: k.expiresAt,
        createdAt: k.createdAt,
        prefix: k.prefix,
        sql: k.sql,
        mcp: k.mcp,
        paused: k.paused,
      })
    ),
    webhooks: d.webhooks.map(
      (h): SettingsWebhook => ({
        id: h.id,
        url: h.url,
        secret: h.secret,
        events: h.events,
        base: h.target?.storeId ?? null,
        view: h.target?.viewId ?? null,
        where: h.filter,
        becomes: h.transition,
        resolve: h.expand,
        active: !h.paused,
        name: h.name,
        fields: h.fields,
        createdAt: h.createdAt,
      })
    ),
    queries: d.queries.map((q) => ({ name: q.name, sql: q.sql, id: q.id, slug: q.slug })),
    extdb: core.syncShadows?.() ?? [],
    files: { filter: { deny: [...s.filesDeny], ...(s.filesAllow.length > 0 ? { allow: [...s.filesAllow] } : {}), maxBytes: s.filesMaxBytes } },
    settings: { cors: [...s.corsOrigins], write: s.write },
  };
}

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Applique un paquet : les clés, webhooks et requêtes de même identifiant sont remplacés, les autres ajoutés. */
export function applySettingsPackage(core: GateCore, pkg: GateSettings): { keys: number; webhooks: number; queries: number } {
  const d = core.state.data;
  const now = new Date().toISOString();
  let keys = 0;
  for (const k of pkg.appKeys) {
    if (typeof k.hash !== 'string' || !/^[0-9a-f]{64}$/.test(k.hash)) continue;
    const record: AppKeyRecord = {
      id: str(k.id) || randomUUID(),
      name: str(k.name, 'clé importée'),
      prefix: str(k.prefix, 'gk_…'),
      hash: k.hash,
      scopes: Array.isArray(k.scopes) ? (k.scopes as KeyScope[]) : [],
      sql: k.sql === true,
      mcp: k.mcp === true,
      rateLimit: typeof k.ratePerMinute === 'number' && k.ratePerMinute > 0 ? k.ratePerMinute : 600,
      ipAllow: strList(k.ips),
      expiresAt: typeof k.expiresAt === 'string' ? k.expiresAt : null,
      paused: k.paused === true,
      createdAt: str(k.createdAt, now),
      lastUsedAt: null,
      lastIp: null,
    };
    d.keys = [...d.keys.filter((x) => x.id !== record.id && x.hash !== record.hash), record];
    keys += 1;
  }
  let webhooks = 0;
  for (const h of pkg.webhooks) {
    if (typeof h.url !== 'string' || typeof h.secret !== 'string') continue;
    const record: WebhookRecord = {
      id: str(h.id) || randomUUID(),
      name: str(h.name, 'webhook importé'),
      url: h.url,
      secret: h.secret,
      target: typeof h.base === 'string' && h.base !== '' ? { storeId: h.base, ...(typeof h.view === 'string' && h.view !== '' ? { viewId: h.view } : {}) } : null,
      events: strList(h.events).filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e)),
      filter: typeof h.where === 'string' && h.where.trim() !== '' ? h.where : null,
      transition: h.becomes === true,
      fields: Array.isArray(h.fields) ? strList(h.fields) : null,
      expand: strList(h.resolve),
      paused: h.active === false,
      createdAt: str(h.createdAt, now),
    };
    d.webhooks = [...d.webhooks.filter((x) => x.id !== record.id), record];
    webhooks += 1;
  }
  let queries = 0;
  for (const q of pkg.queries) {
    if (typeof q.name !== 'string' || typeof q.sql !== 'string') continue;
    const taken = new Set(d.queries.map((x) => x.slug));
    let slug = typeof q.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(q.slug) ? q.slug : (assignSlugs([q.name], 'vue')[0] ?? 'requete');
    const existing = d.queries.find((x) => x.slug === slug);
    if (existing && existing.id !== q.id) for (let n = 2; taken.has(slug); n += 1) slug = `${slug.replace(/-\d+$/, '')}-${n}`;
    const record: SavedQuery = { id: str(q.id) || randomUUID(), name: q.name, slug, sql: q.sql, createdAt: now, updatedAt: now };
    d.queries = [...d.queries.filter((x) => x.id !== record.id), record];
    queries += 1;
  }
  // Les réglages qui ne sont pas verrouillés par l'environnement ou le fichier
  const sources = core.config.sources;
  const settable = (k: 'corsOrigins' | 'write' | 'filesDeny' | 'filesAllow' | 'filesMaxBytes') => sources[k] !== 'env' && sources[k] !== 'file';
  const patch: Record<string, unknown> = {};
  if (settable('corsOrigins')) patch.corsOrigins = pkg.settings.cors;
  if (settable('write')) patch.write = pkg.settings.write;
  if (settable('filesDeny')) patch.filesDeny = pkg.files.filter.deny;
  if (settable('filesAllow') && pkg.files.filter.allow) patch.filesAllow = pkg.files.filter.allow;
  if (settable('filesMaxBytes')) patch.filesMaxBytes = pkg.files.filter.maxBytes;
  d.settings = { ...d.settings, ...(patch as object) };
  // Les champs inconnus de cette version voyagent encore au prochain export
  const known = new Set(['v', 'kind', 'accessId', 'createdAt', 'appKeys', 'webhooks', 'queries', 'extdb', 'files', 'settings']);
  const extra = Object.fromEntries(Object.entries(pkg).filter(([k]) => !known.has(k)));
  if (Object.keys(extra).length > 0) d.importedExtra = extra;
  if (pkg.extdb.length > 0) core.restoreSyncShadows?.(pkg.extdb);
  core.state.saveNow();
  void core.host.updateSettings({}).catch(() => undefined);
  return { keys, webhooks, queries };
}

// ==================== Hors ligne : le paquet en fichier (`filarr-gate export`, `init --import`) ====================

/** Le fichier d'un paquet scellé : ce que `export` écrit et ce que `init --import` relit. */
export interface SealedSettingsFile {
  v: 1;
  kind: 'filarr-gate/settings-sealed';
  accessId: string;
  sealed: string;
  createdAt: string;
}

/**
 * Scelle le paquet de cette boîte pour un AUTRE jeton du même accès (le jeton de
 * la boîte qui prendra le relais). Hors ligne, c'est l'administrateur qui tient le
 * nouveau jeton : la clé publique vient de lui, pas d'un serveur — aucune
 * substitution possible, donc pas de `bindSig` à vérifier ici.
 */
export async function exportForToken(core: GateCore, token: string): Promise<SealedSettingsFile> {
  const target = await openToken(token);
  const identity = core.replicator.identity;
  try {
    if (!identity) throw new ApiError(409, 'no_token', 'Aucun jeton en service : rien à exporter.');
    if (target.accessId !== identity.accessId) throw new ApiError(400, 'other_access', 'Ce jeton est celui d’un autre accès.');
    if (target.aPub === identity.aPub) throw new ApiError(400, 'same_token', 'C’est le jeton de cette boîte : donnez celui de la boîte qui prendra le relais.');
    await core.sync?.cacheShadows();
    const sealed = await sealToKey(storeCrypto, curves, target.aPub, utf8Encode(JSON.stringify(core.settingsPackage())));
    core.journal.add({ kind: 'admin', who: 'migration', what: 'paquet de réglages exporté (fichier)', code: 'ok', note: target.hint });
    return { v: 1, kind: 'filarr-gate/settings-sealed', accessId: identity.accessId, sealed, createdAt: new Date().toISOString() };
  } finally {
    wipeIdentity(target);
  }
}

/** Ouvre un paquet scellé pour CETTE boîte (fichier ou chaîne) et l'applique. */
export async function importSealed(core: GateCore, input: string): Promise<{ keys: number; webhooks: number; queries: number }> {
  const identity = core.replicator.identity;
  if (!identity) throw new ApiError(409, 'no_token', 'Aucun jeton en service : le paquet ne peut pas être ouvert.');
  let sealed = input.trim();
  if (sealed.startsWith('{')) {
    const file = JSON.parse(sealed) as Partial<SealedSettingsFile>;
    if (file.kind !== 'filarr-gate/settings-sealed' || typeof file.sealed !== 'string') throw new ApiError(400, 'bad_package', 'Ce n’est pas un paquet de réglages de Filarr Gate.');
    sealed = file.sealed;
  }
  let pkg: GateSettings;
  try {
    pkg = await openSettings(storeCrypto, curves, identity.aEnc, sealed, identity.accessId);
  } catch (err) {
    throw new ApiError(400, 'package_unreadable', `Paquet illisible pour ce jeton : ${(err as Error).message}`);
  }
  return core.applySettings(pkg);
}
