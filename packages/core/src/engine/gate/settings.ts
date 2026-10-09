// Écrit dans filarr-gate (origine) — cœur pur, à recopier tel quel par filarg (lot B2) et le service hébergé.
/**
 * Le paquet de réglages `gate-settings-1` — contrat `gate-heberge-1` § 8.6.
 *
 * Ce qu'une boîte noire emporte quand l'accès change de mains (migration vers
 * l'auto-hébergement, ou l'inverse) : clés d'application (EMPREINTES seulement),
 * webhooks et leurs secrets, requêtes enregistrées, ombres des synchros
 * externes (chiffrées), filtre des fichiers, réglages. JAMAIS de mot de passe
 * d'administration ni de clé de base externe (D4 : une clé ne transite pas par
 * Filarr).
 *
 * Scellé `sealToPublicKey(JSON, A_pub du destinataire)` — le scellé de
 * `userKeypair` (`sealToKey` d'`apiAccess`). La boîte qui exporte ne scelle que
 * vers une identité dont elle a vérifié `bindSig` avec la clé du créateur
 * authentifiée par `creatorTag` ; la boîte qui importe conserve les champs
 * qu'elle ne connaît pas.
 */

import { bindMessage, fromBase64Std, openSealedBox, sealToKey, type AccessCurves } from '../store/apiAccess';
import { utf8Decode, utf8Encode, type StoreCrypto } from '../store/crypto';

/** Un paquet scellé fait 8 Mio au plus (§ 8.4). */
export const SETTINGS_MAX_BYTES = 8 * 1024 * 1024;

export interface SettingsAppKey {
  id: string;
  name: string;
  /** SHA-256 hex de la clé `gk_…` : la clé elle-même ne voyage jamais. */
  hash: string;
  scopes: unknown;
  ratePerMinute: number;
  ips: string[];
  expiresAt: string | null;
  createdAt: string;
  [extra: string]: unknown;
}

export interface SettingsWebhook {
  id: string;
  url: string;
  secret: string;
  events: string[];
  base: string | null;
  view: string | null;
  where: string | null;
  becomes: boolean;
  resolve: string[];
  active: boolean;
  [extra: string]: unknown;
}

export interface GateSettings {
  v: 1;
  kind: 'filarr-gate/settings';
  accessId: string;
  createdAt: string;
  appKeys: SettingsAppKey[];
  webhooks: SettingsWebhook[];
  queries: Array<{ name: string; sql: string; [extra: string]: unknown }>;
  extdb: Array<{ def: string; rev: number; shadow: string; [extra: string]: unknown }>;
  files: { filter: { deny: string[]; allow?: string[]; maxBytes: number; [extra: string]: unknown }; [extra: string]: unknown };
  settings: { cors: string[]; write: boolean; [extra: string]: unknown };
  [extra: string]: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Lit un paquet ; lève s'il n'en est pas un (version, sorte, accès). Les champs inconnus restent. */
export function readSettings(text: string, expectedAccessId?: string): GateSettings {
  const parsed: unknown = JSON.parse(text);
  if (!isObj(parsed)) throw new Error('paquet de réglages illisible');
  if (parsed.v !== 1) throw new Error(`paquet de réglages de version inconnue (${String(parsed.v)})`);
  if (parsed.kind !== 'filarr-gate/settings') throw new Error('ce n’est pas un paquet de réglages de Filarr Gate');
  if (typeof parsed.accessId !== 'string') throw new Error('paquet de réglages sans accès');
  if (expectedAccessId !== undefined && parsed.accessId !== expectedAccessId) {
    throw new Error('paquet de réglages d’un autre accès');
  }
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const files = isObj(parsed.files) ? parsed.files : {};
  const filter = isObj(files.filter) ? files.filter : {};
  const settings = isObj(parsed.settings) ? parsed.settings : {};
  return {
    ...parsed,
    v: 1,
    kind: 'filarr-gate/settings',
    accessId: parsed.accessId,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString(),
    appKeys: list(parsed.appKeys).filter(isObj) as SettingsAppKey[],
    webhooks: list(parsed.webhooks).filter(isObj) as SettingsWebhook[],
    queries: list(parsed.queries).filter(isObj) as GateSettings['queries'],
    extdb: list(parsed.extdb).filter(isObj) as GateSettings['extdb'],
    files: {
      ...files,
      filter: {
        ...filter,
        deny: list(filter.deny).filter((x): x is string => typeof x === 'string'),
        ...(Array.isArray(filter.allow) ? { allow: filter.allow.filter((x): x is string => typeof x === 'string') } : {}),
        maxBytes: typeof filter.maxBytes === 'number' ? filter.maxBytes : 104_857_600,
      },
    },
    settings: {
      ...settings,
      cors: list(settings.cors).filter((x): x is string => typeof x === 'string'),
      write: settings.write === true,
    },
  };
}

/**
 * Scelle un paquet vers l'identité destinataire, APRÈS avoir vérifié que la clé
 * publique est bien liée à l'accès par le créateur (`bindSig`, base64 standard,
 * clé de signature du créateur authentifiée par `creatorTag`). Lève sinon : une
 * clé substituée par un serveur lirait les secrets des webhooks.
 */
export async function sealSettingsFor(
  c: StoreCrypto,
  curves: AccessCurves,
  settings: GateSettings,
  target: { accessId: string; encPublicKey: string; bindSig: string },
  creatorSigningPublicKey: string
): Promise<string> {
  const ok = curves.ed25519Verify(
    fromBase64Std(target.bindSig),
    bindMessage(target.accessId, target.encPublicKey),
    fromBase64Std(creatorSigningPublicKey)
  );
  if (!ok) throw new Error('identité destinataire non liée par le créateur (bindSig refusée)');
  const sealed = await sealToKey(c, curves, target.encPublicKey, utf8Encode(JSON.stringify(settings)));
  if (sealed.length > SETTINGS_MAX_BYTES * 1.4) throw new Error('paquet de réglages trop lourd (8 Mio au plus)');
  return sealed;
}

/** Ouvre un paquet scellé vers cette boîte (`A_enc`). */
export async function openSettings(
  c: StoreCrypto,
  curves: AccessCurves,
  aEnc: Uint8Array,
  sealed: string,
  expectedAccessId?: string
): Promise<GateSettings> {
  return readSettings(utf8Decode(await openSealedBox(c, curves, aEnc, sealed)), expectedAccessId);
}
