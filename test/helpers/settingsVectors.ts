// Écrit dans filarr-gate (origine) — à recopier par filarg (lot B2) et le service hébergé, avec le fichier de vecteurs.
/**
 * `gate-heberge-1` § 16, famille 6 : le paquet de réglages `gate-settings-1`. Un
 * clair, son scellé FIXE vers l'identité d'un jeton de test (celui de la famille 4,
 * écrite par le worker), la clé du créateur qui lie cette identité (`bindSig`), et
 * les refus : une identité liée par une autre clé, un paquet d'un autre accès. Un
 * champ inconnu (à la racine, dans une clé, dans le filtre) est CONSERVÉ.
 */

import { openSettings, readSettings, sealSettingsFor, type GateSettings } from '../../packages/core/src/engine/gate/settings';
import { bindMessage, toBase64Std, type AccessCurves } from '../../packages/core/src/engine/store/apiAccess';
import type { StoreCrypto } from '../../packages/core/src/engine/store/crypto';
import { openToken } from '../../packages/gate/src/replica/token';

const unhex = (s: string): Uint8Array => new Uint8Array((s.match(/../g) ?? []).map((x) => parseInt(x, 16)));

/** Le jeton de test de `gate-heberge-1` famille 4 (écrit par le worker de filarg). */
const TOKEN = 'flr_live_jpWco6qxuL_GzdTb4unw9w_rbS7wsnQ197l7PP6AQgPFh0kKzI5QEdOVVxjanF4f4Y';
const CREATOR_SIGNING = '31'.repeat(32);
const OTHER_SIGNING = '32'.repeat(32);

export interface SettingsVectors {
  contrat: 'gate-heberge-1';
  famille: 6;
  lecture: string;
  token: string;
  accessId: string;
  encPublicKey: string;
  creatorSigningKeyHex: string;
  creatorPublicKey: string;
  bindSig: string;
  fixed: { ephemeralPrivHex: string; ivHex: string };
  plain: GateSettings;
  sealed: string;
  refused: { bindSigOtherKey: string; otherAccess: string };
}

function plainPackage(accessId: string): GateSettings {
  return {
    v: 1,
    kind: 'filarr-gate/settings',
    accessId,
    createdAt: '2026-10-10T12:00:00.000Z',
    appKeys: [
      {
        id: '0f6d1c2e-5b7a-4c1e-9d3f-2a8b7c6d5e4f',
        name: 'ERP',
        hash: 'a'.repeat(64),
        scopes: [{ target: 'all', read: true }, { target: 'files', deposit: true }],
        ratePerMinute: 600,
        ips: ['10.0.4.0/24'],
        expiresAt: null,
        createdAt: '2026-10-01T08:00:00.000Z',
        prefix: 'gk_erp_ab…',
        sql: true,
        mcp: false,
        paused: false,
        champFutur: { garde: 'moi' },
      },
    ],
    webhooks: [
      {
        id: '6c1f0a9e-2d3b-4e5f-8a7b-1c2d3e4f5a6b',
        url: 'https://erp.exemple.fr/hooks/filarr',
        secret: 'whsec_' + 'b'.repeat(43),
        events: ['row.created', 'row.updated'],
        base: 'AAAAAAAAAAAAAAAAAAAAAA',
        view: null,
        where: "statut = 'Client'",
        becomes: true,
        resolve: ['p_commandes'],
        active: true,
        name: 'Nouveaux clients',
      },
    ],
    queries: [{ name: 'Chiffre par ville', sql: 'SELECT ville, SUM(ca) FROM clients GROUP BY ville', id: 'q1', slug: 'chiffre-par-ville' }],
    extdb: [{ def: 'xs_AAAAAAAAAAAAAAAAAAAAAA', rev: 3, shadow: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' }],
    files: { filter: { deny: ['.exe', '.bat'], maxBytes: 10_485_760, inconnu: 1 } },
    settings: { cors: ['https://erp.exemple.fr'], write: true },
    racineFuture: { v: 2, liste: [1, 2, 3] },
  };
}

export async function buildSettingsVectors(c: StoreCrypto, curves: AccessCurves): Promise<SettingsVectors> {
  const identity = await openToken(TOKEN);
  const signing = unhex(CREATOR_SIGNING);
  const creatorPublicKey = toBase64Std(curves.ed25519PublicKey(signing));
  const bindSig = toBase64Std(curves.ed25519Sign(signing, bindMessage(identity.accessId, identity.aPub)));
  const fixed = { ephemeralPrivHex: '41'.repeat(32), ivHex: '51'.repeat(12) };
  const plain = plainPackage(identity.accessId);
  const target = { accessId: identity.accessId, encPublicKey: identity.aPub, bindSig };
  const sealed = await sealSettingsFor(c, curves, plain, target, creatorPublicKey, { ephemeralPriv: unhex(fixed.ephemeralPrivHex), iv: unhex(fixed.ivHex) });
  const other = await sealSettingsFor(c, curves, { ...plain, accessId: 'AUTREAUTREAUTREAUTREAU' }, target, creatorPublicKey, { ephemeralPriv: unhex(fixed.ephemeralPrivHex), iv: unhex(fixed.ivHex) });
  return {
    contrat: 'gate-heberge-1',
    famille: 6,
    lecture:
      'Paquet gate-settings-1 : `sealed` = sealToPublicKey(JSON du clair, A_pub du jeton), éphémère et IV imposés (base64 standard : éphémère ‖ IV ‖ AES-256-GCM). ' +
      'On l’ouvre avec A_enc du jeton ; les champs inconnus restent. `bindSig` = Ed25519(clé du créateur, "filarr/api/v1|bind|" + accessId + "|" + A_pub). ' +
      'Refus : une identité liée par une autre clé (le scellement n’a pas lieu), un paquet d’un autre accès (l’ouverture lève).',
    token: TOKEN,
    accessId: identity.accessId,
    encPublicKey: identity.aPub,
    creatorSigningKeyHex: CREATOR_SIGNING,
    creatorPublicKey,
    bindSig,
    fixed,
    plain,
    sealed,
    refused: { bindSigOtherKey: toBase64Std(curves.ed25519Sign(unhex(OTHER_SIGNING), bindMessage(identity.accessId, identity.aPub))), otherAccess: other },
  };
}

export async function replaySettingsVectors(c: StoreCrypto, curves: AccessCurves, v: SettingsVectors): Promise<string[]> {
  const bad: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) bad.push(name);
  };
  const identity = await openToken(v.token);
  check('identité du jeton', identity.accessId === v.accessId && identity.aPub === v.encPublicKey);
  check('bindSig', toBase64Std(curves.ed25519Sign(unhex(v.creatorSigningKeyHex), bindMessage(v.accessId, v.encPublicKey))) === v.bindSig);
  const opened = await openSettings(c, curves, identity.aEnc, v.sealed, v.accessId).catch(() => null);
  check('ouverture : le clair, champs inconnus compris', opened !== null && JSON.stringify(opened) === JSON.stringify(readSettings(JSON.stringify(v.plain))));
  check('ouverture : champ inconnu à la racine', (opened as Record<string, unknown> | null)?.racineFuture !== undefined);
  check('ouverture : champ inconnu dans une clé', (opened?.appKeys[0] as Record<string, unknown> | undefined)?.champFutur !== undefined);
  const target = { accessId: v.accessId, encPublicKey: v.encPublicKey, bindSig: v.bindSig };
  const fixed = { ephemeralPriv: unhex(v.fixed.ephemeralPrivHex), iv: unhex(v.fixed.ivHex) };
  check('scellé à l’identique', (await sealSettingsFor(c, curves, v.plain, target, v.creatorPublicKey, fixed).catch(() => '')) === v.sealed);
  let refusedBind = false;
  try {
    await sealSettingsFor(c, curves, v.plain, { ...target, bindSig: v.refused.bindSigOtherKey }, v.creatorPublicKey, fixed);
  } catch {
    refusedBind = true;
  }
  check('refus : identité liée par une autre clé', refusedBind);
  let refusedAccess = false;
  try {
    await openSettings(c, curves, identity.aEnc, v.refused.otherAccess, v.accessId);
  } catch {
    refusedAccess = true;
  }
  check('refus : paquet d’un autre accès', refusedAccess);
  return bad;
}

