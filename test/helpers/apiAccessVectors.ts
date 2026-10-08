// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/__tests__/helpers/apiAccessVectors.ts @ 01e4cb5e — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Vecteurs dorés `api-base-1` (§ 10).
 *
 * `buildApiAccessVectors` fabrique le fichier à partir d'entrées FIXES (jeton,
 * clés, éphémères et IV imposés), donc il est déterministe ;
 * `replayApiAccessVectors` le relit comme le feraient le mobile ou la boîte
 * noire, avec leurs propres fournisseurs (chiffrement et courbes injectés).
 * Recopiable : `strict` et `noUncheckedIndexedAccess`.
 */

import {
  accessAuthHash,
  accessAuthorization,
  assignSlugs,
  bindMessage,
  deriveAccessKeys,
  formatAccessToken,
  fromBase64Std,
  grantPlaintext,
  openGrant,
  openSealedBox,
  parseAccessToken,
  RESERVED_SLUGS,
  sealToKey,
  toBase64Std,
  type AccessCurves,
  type GrantPlace,
} from '../../src/core/engine/store/apiAccess';
import {
  dbKeyInfo,
  storeKeys,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type StoreCrypto,
} from '../../src/core/engine/store/crypto';

const range = (start: number, n: number): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

const ACCESS_ID = range(0x10, 16);
const SECRET = range(0x40, 32);
const CREATOR_SIGN_PRIV = range(0x80, 32);
const CREATOR_ENC_PRIV = range(0xa0, 32);
const FEK = range(0x01, 32);
const STORE_ID = toBase64Url(range(0x30, 16));
const GRANT_E = 0;
const GRANT_G = 1;
const FIXED = {
  grant: { ephemeralPriv: range(0xc0, 32), iv: range(0x50, 12) },
  creator: { ephemeralPriv: range(0xd0, 32), iv: range(0x60, 12) },
  manifest: { ephemeralPriv: range(0xe0, 32), iv: range(0x70, 12) },
};

const BASE_TITLES = [
  'Clients',
  'Commandes',
  'Clients',
  'Café & Thé',
  'İstanbul',
  'Straße',
  'ÉLÈVES',
  'élèves',
  'C++ / C#',
  '日本語',
  '',
  '😀',
  'q',
  'Docs',
  '  --Été 2026--  ',
  'Une base dont le titre dépasse largement quarante-huit caractères de long',
];

const VIEW_TITLES = [
  'Tableau',
  'Tableau',
  'Tableau',
  'Actifs ✅',
  'Par ville (2026)',
  '',
  'self',
  'metrics',
  'A—B',
  'Œuvres',
];

const REFUSED_TOKENS = [
  '',
  'flr_live_',
  'flr_test_EBESExQVFhcYGRobHB0eHw_QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8',
  'flr_live_EBESExQVFhcYGRobHB0eHw_QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl',
  'flr_live_EBESExQVFhcYGRobHB0eHw_QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8x',
  'flr_live_EBESExQVFhcYGRobHB0eHx_QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8',
  'flr_live_EBESExQVFhcYGRobHB0eHw_QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl9',
  'flr_live_EBESExQVFhcYGRobHB0eHw.QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8',
];

function manifestJson(accessId: string): string {
  return JSON.stringify({
    v: 1,
    a: accessId,
    s: STORE_ID,
    slug: 'clients',
    title: 'Clients',
    rights: 'rw',
    views: [
      { id: 'v1', name: 'Tableau', type: 'table', slug: 'tableau' },
      {
        id: 'v2',
        name: 'Actifs',
        type: 'table',
        filters: [{ propertyId: 'p_statut', operator: 'equals', value: 'Actif' }],
        slug: 'actifs',
      },
    ],
    updated: '2026-10-07T12:00:00.000Z',
  });
}

function creatorJson(accessId: string): string {
  return JSON.stringify({
    v: 1,
    a: accessId,
    s: STORE_ID,
    slug: 'clients',
    views: { v1: 'tableau', v2: 'actifs' },
  });
}

export async function buildApiAccessVectors(c: StoreCrypto, curves: AccessCurves) {
  const token = formatAccessToken(ACCESS_ID, SECRET);
  const accessId = toBase64Url(ACCESS_ID);
  const keys = await deriveAccessKeys(c, curves, ACCESS_ID, SECRET);
  const signPub = toBase64Std(curves.ed25519PublicKey(CREATOR_SIGN_PRIV));
  const message = bindMessage(accessId, keys.aPub);
  const store = await storeKeys(c, FEK, STORE_ID, GRANT_E, GRANT_G);
  const place: GrantPlace = { a: accessId, s: STORE_ID, e: GRANT_E, g: GRANT_G };
  const grantText = grantPlaintext(place, store.kDb);
  const creatorPub = toBase64Std(curves.x25519PublicKey(CREATOR_ENC_PRIV));

  return {
    contract: 'api-base-1',
    revision: '2',
    produitPar: 'filarg (bureau), cœur pur engine/store/apiAccess.ts',
    notes: [
      'Octets en hexadécimal (hex), en base64url sans remplissage (accessId, storeId, jeton, clé dans un droit) ou en base64 STANDARD avec remplissage (clés publiques, signature, scellés), comme userKeypair.',
      "Les scellés sont ceux de userKeypair.sealToPublicKey, avec l'éphémère et l'IV IMPOSÉS ici pour que le fichier soit déterministe ; en production ils sont tirés au hasard. Le rejoueur doit RETROUVER chaque scellé sous l'éphémère et l'IV donnés, ET l'ouvrir.",
      'Ed25519 est déterministe (RFC 8032) : la signature `bind.sig` doit être retrouvée à l’identique, et vérifiée.',
      'Les clairs sont du TEXTE JSON : le droit a ses clés dans l’ordre a, s, e, g, k ; le manifeste et la fiche du créateur se relisent par JSON.parse, seul le scellé de ces textes exacts est figé.',
      'Slugs : départagés DANS l’ordre de la liste, à partir de rien (`assignSlugs`) ; les mots de `reserved` comptent comme pris.',
      '`tokensRefused` : parseAccessToken doit rendre null pour chacun (préfixe, longueurs, bits de bourrage non nuls, séparateur).',
    ],
    token: {
      accessIdHex: toHex(ACCESS_ID),
      secretHex: toHex(SECRET),
      accessId,
      token,
      aAuth: toHex(keys.aAuth),
      aEnc: toHex(keys.aEnc),
      aPub: keys.aPub,
      authHash: await accessAuthHash(c, keys.aAuth),
      authorization: accessAuthorization(accessId, keys.aAuth),
    },
    tokensRefused: REFUSED_TOKENS,
    bind: {
      signPrivHex: toHex(CREATOR_SIGN_PRIV),
      signPub,
      message: utf8Decode(message),
      sig: toBase64Std(curves.ed25519Sign(CREATOR_SIGN_PRIV, message)),
    },
    grant: {
      fekHex: toHex(FEK),
      storeId: STORE_ID,
      e: GRANT_E,
      g: GRANT_G,
      info: dbKeyInfo(GRANT_E, GRANT_G),
      kDb: toHex(store.kDb),
      plaintext: grantText,
      ephemeralPrivHex: toHex(FIXED.grant.ephemeralPriv),
      ivHex: toHex(FIXED.grant.iv),
      sealed: await sealToKey(c, curves, keys.aPub, utf8Encode(grantText), FIXED.grant),
    },
    creator: {
      encPrivHex: toHex(CREATOR_ENC_PRIV),
      encPub: creatorPub,
      plaintext: creatorJson(accessId),
      ephemeralPrivHex: toHex(FIXED.creator.ephemeralPriv),
      ivHex: toHex(FIXED.creator.iv),
      sealed: await sealToKey(
        c,
        curves,
        creatorPub,
        utf8Encode(creatorJson(accessId)),
        FIXED.creator
      ),
    },
    manifest: {
      plaintext: manifestJson(accessId),
      ephemeralPrivHex: toHex(FIXED.manifest.ephemeralPriv),
      ivHex: toHex(FIXED.manifest.iv),
      sealed: await sealToKey(
        c,
        curves,
        keys.aPub,
        utf8Encode(manifestJson(accessId)),
        FIXED.manifest
      ),
    },
    slugs: {
      reserved: [...RESERVED_SLUGS],
      maxLength: 48,
      bases: BASE_TITLES.map((title, i) => ({ title, slug: assignSlugs(BASE_TITLES, 'base')[i] })),
      vues: VIEW_TITLES.map((title, i) => ({ title, slug: assignSlugs(VIEW_TITLES, 'vue')[i] })),
    },
  };
}

export type ApiAccessVectors = Awaited<ReturnType<typeof buildApiAccessVectors>>;

/** Rejoue un fichier de vecteurs ; rend les écarts (vide = conforme). */
export async function replayApiAccessVectors(
  c: StoreCrypto,
  curves: AccessCurves,
  v: ApiAccessVectors
): Promise<string[]> {
  const bad: string[] = [];
  const check = (what: string, got: unknown, want: unknown): void => {
    const g = typeof got === 'string' ? got : JSON.stringify(got);
    const w = typeof want === 'string' ? want : JSON.stringify(want);
    if (g !== w) bad.push(`${what} : obtenu ${g.slice(0, 120)} ≠ attendu ${w.slice(0, 120)}`);
  };
  /** Un échec d'ouverture devient un écart, jamais une exception du rejoueur. */
  const attempt = async (run: () => Promise<string>): Promise<string> => {
    try {
      return await run();
    } catch (e) {
      return `erreur : ${e instanceof Error ? e.message : String(e)}`;
    }
  };
  const refuses = async (what: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
      bad.push(`${what} : accepté, devait être refusé`);
    } catch {
      // attendu
    }
  };

  // Le jeton
  const parsed = parseAccessToken(v.token.token);
  check('jeton relu', parsed === null ? null : toHex(parsed.accessIdBytes), v.token.accessIdHex);
  check('secret relu', parsed === null ? null : toHex(parsed.secret), v.token.secretHex);
  check('accessId relu', parsed?.accessId ?? null, v.token.accessId);
  check(
    'jeton écrit',
    formatAccessToken(fromHex(v.token.accessIdHex), fromHex(v.token.secretHex)),
    v.token.token
  );
  for (const t of v.tokensRefused)
    check(`jeton refusé ${JSON.stringify(t)}`, parseAccessToken(t), null);

  const keys = await deriveAccessKeys(
    c,
    curves,
    fromHex(v.token.accessIdHex),
    fromHex(v.token.secretHex)
  );
  check('A_auth', toHex(keys.aAuth), v.token.aAuth);
  check('A_enc', toHex(keys.aEnc), v.token.aEnc);
  check('A_pub', keys.aPub, v.token.aPub);
  check('auth_hash', await accessAuthHash(c, keys.aAuth), v.token.authHash);
  check('Authorization', accessAuthorization(v.token.accessId, keys.aAuth), v.token.authorization);

  // bind_sig
  const signPriv = fromHex(v.bind.signPrivHex);
  check('clé de signature', toBase64Std(curves.ed25519PublicKey(signPriv)), v.bind.signPub);
  const message = bindMessage(v.token.accessId, v.token.aPub);
  check('message lié', utf8Decode(message), v.bind.message);
  check('bind_sig retrouvée', toBase64Std(curves.ed25519Sign(signPriv, message)), v.bind.sig);
  check(
    'bind_sig vérifiée',
    curves.ed25519Verify(fromBase64Std(v.bind.sig), message, fromBase64Std(v.bind.signPub)),
    true
  );
  check(
    'bind_sig refusée pour une autre clé publique',
    curves.ed25519Verify(
      fromBase64Std(v.bind.sig),
      bindMessage(v.token.accessId, v.creator.encPub),
      fromBase64Std(v.bind.signPub)
    ),
    false
  );

  // Le droit
  const store = await storeKeys(c, fromHex(v.grant.fekHex), v.grant.storeId, v.grant.e, v.grant.g);
  check('info de K_db', dbKeyInfo(v.grant.e, v.grant.g), v.grant.info);
  check('K_db du droit', toHex(store.kDb), v.grant.kDb);
  const place: GrantPlace = { a: v.token.accessId, s: v.grant.storeId, e: v.grant.e, g: v.grant.g };
  check('clair du droit', grantPlaintext(place, store.kDb), v.grant.plaintext);
  const fixedOf = (x: { ephemeralPrivHex: string; ivHex: string }) => ({
    ephemeralPriv: fromHex(x.ephemeralPrivHex),
    iv: fromHex(x.ivHex),
  });
  check(
    'scellé du droit',
    await sealToKey(c, curves, v.token.aPub, utf8Encode(v.grant.plaintext), fixedOf(v.grant)),
    v.grant.sealed
  );
  check(
    'droit ouvert',
    await attempt(async () => toHex(await openGrant(c, curves, keys.aEnc, v.grant.sealed, place))),
    v.grant.kDb
  );
  await refuses('droit sous une autre génération', () =>
    openGrant(c, curves, keys.aEnc, v.grant.sealed, { ...place, g: place.g + 1 })
  );
  await refuses('droit sous une autre base', () =>
    openGrant(c, curves, keys.aEnc, v.grant.sealed, { ...place, s: v.token.accessId })
  );
  await refuses('droit ouvert par une autre clé', () =>
    openGrant(c, curves, fromHex(v.creator.encPrivHex), v.grant.sealed, place)
  );

  // La fiche du créateur et le manifeste
  const creatorPriv = fromHex(v.creator.encPrivHex);
  check(
    'clé publique du créateur',
    toBase64Std(curves.x25519PublicKey(creatorPriv)),
    v.creator.encPub
  );
  check(
    'scellé de la fiche',
    await sealToKey(
      c,
      curves,
      v.creator.encPub,
      utf8Encode(v.creator.plaintext),
      fixedOf(v.creator)
    ),
    v.creator.sealed
  );
  check(
    'fiche ouverte',
    await attempt(async () =>
      utf8Decode(await openSealedBox(c, curves, creatorPriv, v.creator.sealed))
    ),
    v.creator.plaintext
  );
  check(
    'scellé du manifeste',
    await sealToKey(c, curves, v.token.aPub, utf8Encode(v.manifest.plaintext), fixedOf(v.manifest)),
    v.manifest.sealed
  );
  check(
    'manifeste ouvert',
    await attempt(async () =>
      utf8Decode(await openSealedBox(c, curves, keys.aEnc, v.manifest.sealed))
    ),
    v.manifest.plaintext
  );
  await refuses('manifeste ouvert par le créateur', () =>
    openSealedBox(c, curves, creatorPriv, v.manifest.sealed)
  );

  // Les slugs
  check('mots réservés', v.slugs.reserved, [...RESERVED_SLUGS]);
  const bases = assignSlugs(
    v.slugs.bases.map((b) => b.title),
    'base'
  );
  v.slugs.bases.forEach((b, i) =>
    check(`slug de base ${JSON.stringify(b.title)}`, bases[i], b.slug)
  );
  const vues = assignSlugs(
    v.slugs.vues.map((b) => b.title),
    'vue'
  );
  v.slugs.vues.forEach((b, i) => check(`slug de vue ${JSON.stringify(b.title)}`, vues[i], b.slug));

  return bad;
}
