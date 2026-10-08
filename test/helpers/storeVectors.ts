// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/__tests__/helpers/storeVectors.ts @ 189ef234 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Vecteurs dorés du contrat `db-store-1` (§ 11) : le bureau les PRODUIT, chaque
 * surface les REJOUE à l'identique (bureau sous V8, mobile sous Jest et Hermes).
 *
 * `buildStoreVectors` fabrique le fichier à partir d'entrées fixes (clés, IV,
 * horloges scriptées) ; `replayStoreVectors` le relit comme le ferait un autre
 * client et rend la liste des écarts. Ce module n'importe que le cœur pur : il
 * se porte tel quel.
 *
 * Les entrées JSON sont écrites EN TEXTE (`input`) et relues par `JSON.parse` :
 * `-0`, une moitié de paire isolée ou `0.30000000000000004` traversent ainsi le
 * fichier sans être réécrits par l'outil qui l'a produit.
 */

import { deflateSync } from 'fflate';
import type { DbRow } from '../../src/core/types';
import { canonicalJson } from '../../src/core/engine/store/canonical';
import {
  headJson,
  headKeyBytes,
  isCover,
  merkleRoot,
  openHead,
  openSlot,
  parseSlotJson,
  placeHash,
  prefixFor,
  sealHead,
  sealSlot,
  slotJson,
  slotMac,
  type StoreHead,
} from '../../src/core/engine/store/codec';
import {
  dbKeyInfo,
  fromBase64Url,
  open,
  personalStoreId,
  slotAad,
  slotKey,
  storeKeys,
  toBase64Url,
  utf8Decode,
  utf8DecodePure,
  utf8Encode,
  vaultStoreId,
  type StoreCrypto,
  type StoreKeys,
} from '../../src/core/engine/store/crypto';
import { evenPositions, positionBetween } from '../../src/core/engine/store/fracIndex';
import { headZones, validZones } from '../../src/core/engine/store/zones';
import { HlcClock, formatHlc, parseHlc } from '../../src/core/engine/store/hlc';
import {
  applyOp,
  materializeRow,
  materializeRows,
  rowToRegisters,
  type StoreOp,
  type StoreRows,
} from '../../src/core/engine/store/registers';

// ==================== Octets ====================

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const range = (from: number, n: number): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (from + i) & 255);

// ==================== Entrées fixes ====================

const FEK = range(0x00, 32);
const K_VAULT = range(0x20, 32);
const DB_ID = 'db-vecteur-1';
const VAULT_ID = 'vault-vecteur-1';
const VAULT_EPOCH = 2;
const SLOT_IV = range(0x40, 12);
/** Les clés de placement et d'empreinte de la tête (précision 3.3), fixes pour les vecteurs. */
const HEAD_KEYS = { mac: toBase64Url(range(0x80, 32)), place: toBase64Url(range(0xa0, 32)) };
const HEAD_KEY_BYTES = headKeyBytes({ keys: HEAD_KEYS });
/** Entrées MALFORMÉES : le décodeur pur doit rendre exactement ce que rend TextDecoder. */
const UTF8_MALFORMED = [
  '80',
  'bf41',
  'c080',
  'c2',
  'c3a9ff41',
  'e282',
  'e0a080',
  'e08080',
  'eda080',
  'f09f98',
  'f0908080',
  'f4908080',
  'f5',
  'ff',
  'efbbbf41',
  '41efbbbf',
];
const HEAD_IV = range(0x50, 12);
const SLOT_PREFIX = '01';
const SLOT_VER = 3;
const HEAD_SEQ = 7;
const COVER = ['00', '01', '1'];

const UTF8_TEXTS = ['', 'ASCII', 'é€😀', 'a\ud800b', '\udc00', '\ud83d', 'z\u0000\u007f\u0080߿ࠀ￿'];

const CANONICAL_INPUTS = [
  '{"b":1,"a":[0.30000000000000004,1e21,5e-7,-0,9007199254740993,1e-7,0.000001,123456789012345680000]}',
  '{"n":[1.7976931348623157e308,5e-324,4.35,100,1e300,-1.5e-10,0.1,2.5e+25]}',
  '{"\\uffff":0,"😀":1,"a":2,"Z":3,"é":4,"10":5,"9":6,"_":7}',
  '{"s":"\\ud800","\\udfff":"x","c":"\\u0000\\u001f\\u007f\\"\\\\/\\b\\f\\n\\r\\t"}',
  '[null,true,false,{},[],"",{"z":{"y":{"x":[]}}}]',
];

const HLC_FORMATS: Array<[number, number, string]> = [
  [0, 0, '00000000'],
  [1_759_500_000_000, 3, 'a1b2c3d4'],
  [0xffffffffffff, 0xffff, 'ffffffff'],
];

/** Un script d'horloge : des `tick` à une heure physique donnée, des `observe`. */
const HLC_SCRIPT: Array<{ now: number; tick?: true; observe?: string }> = [
  { now: 1000, tick: true },
  { now: 1000, tick: true },
  { now: 999, tick: true }, // l'heure système recule
  { now: 1001, tick: true },
  { now: 1001, observe: formatHlc(5000, 9, 'ffffffff') },
  { now: 1002, tick: true }, // passe après l'heure reçue
  { now: 6000, tick: true },
  { now: 6000, observe: formatHlc(6000 + 25 * 3600 * 1000, 0, '00000001') }, // plus de 24 h d'avance
  { now: 6001, tick: true },
];

const BETWEEN: Array<[string | null, string | null]> = [
  [null, null],
  [null, 'V'],
  ['V', null],
  ['V', 'W'],
  ['V', 'V1'],
  ['0V', '1'],
  [null, '01'],
  ['z', null],
  ['zz', null],
  ['A', 'B'],
  ['Az', 'B'],
];

const T = (ms: number, counter: number, site: string): string => formatHlc(ms, counter, site);

/** Des historiques d'écritures et les ordres d'arrivée à rejouer. */
const MERGE_CASES: Array<{ name: string; ops: StoreOp[]; orders: number[][] }> = [
  {
    name: 'supprimer gagne contre une modification concurrente plus récente',
    ops: [
      { r: 'r1', f: 'titre', v: 'avant', t: T(1, 0, '00000001') },
      { r: 'r1', f: '#d', v: true, t: T(2, 0, '00000001') },
      { r: 'r1', f: 'titre', v: 'pendant', t: T(3, 0, '00000002') },
    ],
    orders: [
      [0, 1, 2],
      [2, 1, 0],
      [1, 2, 0],
    ],
  },
  {
    name: 'restaurer rend la ligne intacte, modification concurrente comprise',
    ops: [
      { r: 'r1', f: 'titre', v: 'avant', t: T(1, 0, '00000001') },
      { r: 'r1', f: '#d', v: true, t: T(2, 0, '00000001') },
      { r: 'r1', f: 'titre', v: 'pendant', t: T(3, 0, '00000002') },
      { r: 'r1', f: '#d', v: false, t: T(4, 0, '00000001') },
    ],
    orders: [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
    ],
  },
  {
    name: 'à heure égale, le JSON canonique le plus grand (précision 3.1)',
    ops: [
      { r: 'r1', f: 'n', v: 10, t: T(5, 0, '00000001') },
      { r: 'r1', f: 'n', v: 2, t: T(5, 0, '00000001') },
      { r: 'r1', f: 's', v: 'x', t: T(5, 0, '00000001') },
      { r: 'r1', f: 's', v: null, t: T(5, 0, '00000001') },
      { r: 'r2', f: '#d', v: false, t: T(6, 0, '00000003') },
      { r: 'r2', f: '#d', v: true, t: T(6, 0, '00000003') },
    ],
    orders: [
      [0, 1, 2, 3, 4, 5],
      [5, 4, 3, 2, 1, 0],
    ],
  },
  {
    name: 'champs réservés et clé inconnue, ordre manuel',
    ops: [
      { r: 'b', f: '#o', v: 'k', t: T(1, 0, '00000001') },
      { r: 'a', f: '#o', v: 'z', t: T(1, 0, '00000001') },
      { r: 'c', f: '#o', v: 'A', t: T(1, 0, '00000001') },
      { r: 'c', f: '#c', v: '2026-10-01T08:00:00.000Z', t: T(1, 0, '00000001') },
      { r: 'c', f: '#a', v: 'b', t: T(2, 0, '00000001') },
      { r: 'c', f: '#p', v: 'note-7', t: T(2, 1, '00000001') },
      { r: 'c', f: '#x.futur', v: { k: [1, 'é'] }, t: T(3, 0, '00000002') },
      { r: 'c', f: 'tags', v: ['o1', 'o2'], t: T(3, 1, '00000002') },
      { r: 'b', f: 'vide', t: T(4, 0, '00000002') },
    ],
    orders: [
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
      [8, 7, 6, 5, 4, 3, 2, 1, 0],
    ],
  },
];

const INLINE_ROW = {
  id: 'r9',
  cells: { titre: 'Ada', n: 3, vide: null, tags: ['o1'] },
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
  parentId: 'r1',
  pageNoteId: 'note-7',
  futur: { a: 1 },
};

const SCHEMA = {
  properties: [
    { id: 'titre', name: 'Titre', type: 'text' },
    {
      id: 'etat',
      name: 'État',
      type: 'select',
      options: [
        { id: 'o1', label: 'À faire', color: 'gray' },
        { id: 'o2', label: 'Fait', color: 'green' },
      ],
    },
    { id: 'n', name: 'Nombre', type: 'number' },
  ],
  rowTemplates: [{ id: 'tpl1', name: 'Modèle', cells: { etat: 'o1' } }],
  extra: { futurRacine: { x: 1 } },
  collation: 'fr',
  t: T(1_759_500_000_000, 0, '0000abcd'),
};

// ==================== Fabrication ====================

function runScript(
  site: string
): Array<{ now: number; tick?: true; observe?: string; out: string | boolean }> {
  let now = 0;
  const clock = new HlcClock(site, () => now);
  return HLC_SCRIPT.map((step) => {
    now = step.now;
    const out = step.tick ? clock.tick() : clock.observe(step.observe!);
    return { ...step, out };
  });
}

function mergeState(ops: StoreOp[], order: number[]): StoreRows {
  const rows: StoreRows = {};
  for (const i of order) applyOp(rows, ops[i]);
  return rows;
}

async function keysHex(c: StoreCrypto, keys: StoreKeys) {
  return {
    storeId: keys.storeId,
    epoch: keys.epoch,
    kDb: toHex(keys.kDb),
    kHead: toHex(keys.kHead),
    kSlot: Object.fromEntries(
      await Promise.all(
        ['', '0', SLOT_PREFIX, '1'].map(async (p) => [p, toHex(await slotKey(c, keys, p))] as const)
      )
    ),
  };
}

/**
 * Précision 3.9 : `K_db(e, g)` et `K_head` aux générations 0, 1 et 2. La
 * génération 0 redonne les clés de `keys` (l'`info` d'avant, inchangée).
 */
async function generationVectors(c: StoreCrypto, ikm: Uint8Array, storeId: string, epoch: number) {
  return Promise.all(
    [0, 1, 2].map(async (g) => {
      const keys = await storeKeys(c, ikm, storeId, epoch, g);
      return {
        e: epoch,
        g,
        info: dbKeyInfo(epoch, g),
        kDb: toHex(keys.kDb),
        kHead: toHex(keys.kHead),
      };
    })
  );
}

/** Le contenu du fichier de vecteurs, déterministe. */
// ==================== Index de zone (précision 3.8) ====================

/** Les propriétés zonées des vecteurs : chaque type, plus une colonne de texte (sans zone). */
const ZONE_PROPS = [
  { id: 'n', name: 'Nombre', type: 'number' },
  { id: 'd', name: 'Échéance', type: 'date' },
  { id: 'b', name: 'Fait', type: 'checkbox' },
  { id: 's', name: 'Statut', type: 'select', options: [{ id: 'o1', label: 'Un', color: 'red' }] },
  { id: 'm', name: 'Étiquettes', type: 'multiSelect', options: [] },
  { id: 'note', name: 'Note', type: 'text' },
];

/** Trois blocs piégés : valeurs extrêmes, dates impossibles, horodatage à fuseau, ligne supprimée, sans position. */
function zoneSlots(): Array<{
  p: string;
  ver: number;
  rows: Record<string, ReturnType<typeof rowToRegisters>>;
}> {
  const t = (ms: number) => T(ms, 0, '0000abcd');
  const reg = (
    id: string,
    cells: Record<string, unknown>,
    ms: number,
    order: string,
    created?: string
  ) =>
    [
      id,
      rowToRegisters(
        { id, cells, ...(created ? { createdAt: created } : {}) } as DbRow,
        t(ms),
        order
      ),
    ] as const;
  const a = Object.fromEntries([
    reg(
      'a1',
      { n: 3, d: '2026-10-04', b: true, s: 'o1', m: ['x', 'y', 'x'], note: 'a' },
      1_000,
      'V',
      '2026-01-02T00:00:00.000Z'
    ),
    reg(
      'a2',
      { n: -0, d: '2026-02-30', b: false, s: 'inconnue', m: [], note: 'b' },
      2_000,
      'W',
      '2025-12-31T23:59:59.999Z'
    ),
    reg('a3', { n: '12', d: '2026-13-01', m: ['z', 7] }, 3_000, '', 'pas une date'),
    reg('a4', { n: 1e21, d: '2026-10-04T23:30:00+14:00', b: true, s: '' }, 4_000, 'X'),
  ]);
  a.a5 = {
    ...rowToRegisters({ id: 'a5', cells: { n: -99, d: '1999-01-01' } } as DbRow, t(5_000), 'A'),
    '#d': { v: true, t: t(6_000) },
  };
  const many: Record<string, ReturnType<typeof rowToRegisters>> = {};
  for (let i = 0; i < 40; i += 1) {
    many[`b${i}`] = rowToRegisters(
      { id: `b${i}`, cells: { s: `opt${String(i).padStart(2, '0')}`, n: 0.1 + 0.2 } } as DbRow,
      t(10_000 + i),
      `b${String(i).padStart(2, '0')}`
    );
  }
  return [
    { p: '0', ver: 3, rows: a },
    { p: '10', ver: 1, rows: many },
    { p: '11', ver: 7, rows: {} },
  ];
}

export async function buildStoreVectors(c: StoreCrypto) {
  const personalId = await personalStoreId(c, FEK, DB_ID);
  const personal = await storeKeys(c, FEK, personalId, 0);
  const vaultId = await vaultStoreId(c, VAULT_ID, DB_ID);
  const vault = await storeKeys(c, K_VAULT, vaultId, VAULT_EPOCH);

  // Le bloc : les lignes du dernier cas de fusion, plus une ligne migrée
  const lastCase = MERGE_CASES[MERGE_CASES.length - 1];
  const rows = mergeState(lastCase.ops, lastCase.orders[0]);
  rows.r9 = rowToRegisters(
    INLINE_ROW as unknown as DbRow,
    T(Date.parse(INLINE_ROW.updatedAt), 0, '0000abcd'),
    'V'
  );
  const json = slotJson(SLOT_PREFIX, rows);
  const body = await sealSlot(c, personal, SLOT_PREFIX, SLOT_VER, rows, SLOT_IV);
  const compressed = await open(
    c,
    await slotKey(c, personal, SLOT_PREFIX),
    body,
    slotAad(personal.storeId, SLOT_PREFIX, SLOT_VER)
  );
  const mac = await slotMac(c, HEAD_KEY_BYTES.mac, body);

  const emptyBody = await sealSlot(c, personal, '00', 1, {}, range(0x60, 12));
  const lightBody = await sealSlot(c, personal, '1', 2, { r1: rows.c }, range(0x70, 12));
  const slots = {
    '00': { e: 0, mac: await slotMac(c, HEAD_KEY_BYTES.mac, emptyBody), ver: 1 },
    [SLOT_PREFIX]: { e: 0, mac, ver: SLOT_VER },
    '1': { e: 0, mac: await slotMac(c, HEAD_KEY_BYTES.mac, lightBody), ver: 2 },
  };
  const head: StoreHead = {
    v: 1,
    dbId: DB_ID,
    keys: HEAD_KEYS,
    schema: SCHEMA as unknown as StoreHead['schema'],
    slots,
    root: await merkleRoot(c, HEAD_KEY_BYTES.mac, slots),
    epochs: [0],
    updated: '2026-10-04T12:00:00.000Z',
  };
  const headBody = await sealHead(c, personal, HEAD_SEQ, head, HEAD_IV);

  const placementIds = ['r1', 'r2', 'c', 'ligne-é', '😀', 'a\ud800'];
  const placement = await Promise.all(
    placementIds.map(async (rowId) => {
      const hash = await placeHash(c, HEAD_KEY_BYTES.place, rowId);
      let bits = '';
      for (let i = 0; i < 16; i += 1) bits += (hash[i >> 3] >> (7 - (i & 7))) & 1;
      return { rowId, hmac: toHex(hash), bits16: bits, prefix: prefixFor(hash, new Set(COVER)) };
    })
  );

  const t9 = T(Date.parse(INLINE_ROW.updatedAt), 0, '0000abcd');
  const registers = rowToRegisters(INLINE_ROW as unknown as DbRow, t9, 'V');

  return {
    contract: 'db-store-1',
    revision: '3.9',
    produitPar: 'filarg (bureau), cœur pur engine/store',
    notes: [
      'Les octets sont en hexadécimal (hex) ou en base64url sans remplissage (b64).',
      'Les entrées JSON sont du TEXTE à relire par JSON.parse ; la sortie attendue est le JSON canonique exact.',
      "deflate : la sortie exacte de fflate peut changer d'une version à l'autre. Le rejoueur exige le DÉCHIFFREMENT du corps en `compressed`, son inflation en `json`, et le chiffrement de `compressed` sous l'IV donné ; l'égalité de son propre deflate est seulement signalée (`deflateIdentique`).",
      'UTF-8 : celui de TextEncoder (une moitié de paire isolée devient U+FFFD). Ne pas utiliser le repli de strToU8 de fflate 0.8 sans TextEncoder : il code mal les caractères hors du plan de base.',
      'Décodage : celui de TextDecoder, même sur une entrée malformée (`utf8Malformed`) : un U+FFFD par sous-partie maximale invalide, BOM initial retiré.',
      'Précision 3.3 : le placement (`placement.placeKey`) et les empreintes (racine, `mac`) prennent les clés de la TÊTE (`keys.place`, `keys.mac`), jamais une dérivation par époque.',
      'Précision 3.8 : `zones.zones` est le JSON canonique de `headZones` sur les blocs `zones.slots` et les propriétés `zones.properties` ; `zones.stale` est une tête dont une zone est périmée (sa `ver` diffère de celle du bloc) : seules les zones de `zones.stale.valid` sont lues.',
      "Précision 3.9 (contrat api-base-1 § 2) : `generations` donne `K_db(e, g)` et `K_head` aux générations 0, 1 et 2. L'`info` vaut `filarr/dbstore/v1|db|<e>` à g = 0 (les clés de `keys`, inchangées) et `filarr/dbstore/v1|db|<e>|g<g>` au-delà.",
    ],
    utf8Malformed: UTF8_MALFORMED.map((hex) => ({
      hex,
      decoded: new TextDecoder().decode(fromHex(hex)),
    })),
    utf8: UTF8_TEXTS.map((text) => {
      const bytes = utf8Encode(text);
      return { text, hex: toHex(bytes), decoded: utf8Decode(bytes) };
    }),
    base64url: [
      range(0, 0),
      range(0xff, 1),
      range(0xfe, 2),
      range(0xfb, 3),
      range(0, 4),
      range(0x80, 31),
    ].map((bytes) => ({
      hex: toHex(bytes),
      b64: toBase64Url(bytes),
    })),
    canonical: CANONICAL_INPUTS.map((input) => ({
      input,
      canonical: canonicalJson(JSON.parse(input)),
    })),
    hlc: {
      format: HLC_FORMATS.map(([ms, counter, site]) => ({
        ms,
        counter,
        site,
        hlc: formatHlc(ms, counter, site),
      })),
      order: [
        [T(1, 0, '00000002'), T(1, 1, '00000001'), -1],
        [T(2, 0, '00000001'), T(1, 0xffff, 'ffffffff'), 1],
        [T(3, 4, 'abcdef01'), T(3, 4, 'abcdef01'), 0],
        [T(3, 4, 'abcdef01'), T(3, 4, 'abcdef02'), -1],
      ],
      script: { site: '0000abcd', steps: runScript('0000abcd') },
    },
    fracIndex: {
      between: BETWEEN.map(([a, b]) => ({ a, b, key: positionBetween(a, b) })),
      even: [1, 5, 62, 100].map((n) => ({ n, keys: evenPositions(n) })),
    },
    merge: MERGE_CASES.map((mc) => {
      const state = mergeState(mc.ops, mc.orders[0]);
      return {
        name: mc.name,
        ops: mc.ops,
        orders: mc.orders,
        state: canonicalJson(state),
        rows: canonicalJson(materializeRows(state)),
      };
    }),
    materialize: {
      row: JSON.stringify(INLINE_ROW),
      t: t9,
      order: 'V',
      registers: canonicalJson(registers),
      back: canonicalJson(materializeRow('r9', registers)),
    },
    hkdfRfc5869Case3: {
      ikm: toHex(new Uint8Array(22).fill(0x0b)),
      okm: toHex(await c.hkdf(new Uint8Array(22).fill(0x0b), new Uint8Array(0), '', 42)),
    },
    keys: {
      fek: toHex(FEK),
      dbId: DB_ID,
      personal: await keysHex(c, personal),
      kVault: toHex(K_VAULT),
      vaultId: VAULT_ID,
      vault: await keysHex(c, vault),
    },
    generations: {
      personal: await generationVectors(c, FEK, personal.storeId, 0),
      vault: await generationVectors(c, K_VAULT, vault.storeId, VAULT_EPOCH),
    },
    placement: { store: 'personal', placeKey: HEAD_KEYS.place, cover: COVER, rows: placement },
    slot: {
      store: 'personal',
      prefix: SLOT_PREFIX,
      ver: SLOT_VER,
      rows: canonicalJson(rows),
      json,
      compressed: toBase64Url(compressed),
      iv: toHex(SLOT_IV),
      body: toBase64Url(body),
      mac,
    },
    zones: (() => {
      const slotsIn = zoneSlots();
      const zones = headZones(
        slotsIn.map((s) => [s.p, { ver: s.ver, rows: s.rows }] as const),
        ZONE_PROPS as never
      );
      const stale = {
        slots: { '0': { ver: 3 }, '10': { ver: 2 }, '11': { ver: 7 } },
        zones: canonicalJson(zones),
      };
      return {
        properties: canonicalJson(ZONE_PROPS),
        slots: slotsIn.map((s) => ({ p: s.p, ver: s.ver, rows: canonicalJson(s.rows) })),
        zones: canonicalJson(zones),
        stale: {
          ...stale,
          valid: [
            ...validZones({ slots: stale.slots, zones: JSON.parse(stale.zones) }).keys(),
          ].sort(),
        },
      };
    })(),
    head: {
      store: 'personal',
      seq: HEAD_SEQ,
      json: headJson(head),
      iv: toHex(HEAD_IV),
      body: toBase64Url(headBody),
      root: head.root,
      otherSlots: { '00': toBase64Url(emptyBody), '1': toBase64Url(lightBody) },
    },
  };
}

export type StoreVectors = Awaited<ReturnType<typeof buildStoreVectors>>;

// ==================== Rejeu ====================

/** Rejoue un fichier de vecteurs ; rend les écarts (vide = conforme) et ce qui n'est que signalé. */
export async function replayStoreVectors(
  c: StoreCrypto,
  v: StoreVectors
): Promise<{ mismatches: string[]; deflateIdentique: boolean }> {
  const bad: string[] = [];
  const check = (what: string, got: unknown, want: unknown) => {
    const g = typeof got === 'string' ? got : JSON.stringify(got);
    const w = typeof want === 'string' ? want : JSON.stringify(want);
    if (g !== w) bad.push(`${what} : obtenu ${g.slice(0, 120)} ≠ attendu ${w.slice(0, 120)}`);
  };

  for (const m of v.utf8Malformed) {
    check(
      `utf8 malformé ${m.hex} (pur)`,
      JSON.stringify(utf8DecodePure(fromHex(m.hex))),
      JSON.stringify(m.decoded)
    );
    check(
      `utf8 malformé ${m.hex}`,
      JSON.stringify(utf8Decode(fromHex(m.hex))),
      JSON.stringify(m.decoded)
    );
  }
  for (const u of v.utf8) {
    check(`utf8 ${JSON.stringify(u.text)}`, toHex(utf8Encode(u.text)), u.hex);
    check(
      `utf8 décodé ${JSON.stringify(u.text)}`,
      JSON.stringify(utf8Decode(fromHex(u.hex))),
      JSON.stringify(u.decoded)
    );
  }
  for (const b of v.base64url) {
    check(`base64url ${b.hex}`, toBase64Url(fromHex(b.hex)), b.b64);
    check(`base64url retour ${b.b64}`, toHex(fromBase64Url(b.b64)), b.hex);
  }
  for (const k of v.canonical)
    check(`canonique ${k.input}`, canonicalJson(JSON.parse(k.input)), k.canonical);

  for (const f of v.hlc.format) {
    check(`hlc format ${f.ms}`, formatHlc(f.ms, f.counter, f.site), f.hlc);
    check(`hlc lecture ${f.hlc}`, parseHlc(f.hlc), { ms: f.ms, counter: f.counter, site: f.site });
  }
  for (const [a, b, sign] of v.hlc.order) {
    check(`hlc ordre ${a} ${b}`, a < b ? -1 : a > b ? 1 : 0, sign);
  }
  {
    let now = 0;
    const clock = new HlcClock(v.hlc.script.site, () => now);
    v.hlc.script.steps.forEach((step, i) => {
      now = step.now;
      const out = step.tick ? clock.tick() : clock.observe(step.observe!);
      check(`hlc script pas ${i}`, out, step.out);
    });
  }

  for (const p of v.fracIndex.between)
    check(`position entre ${p.a} et ${p.b}`, positionBetween(p.a, p.b), p.key);
  for (const e of v.fracIndex.even)
    check(`positions régulières ${e.n}`, evenPositions(e.n), e.keys);

  for (const m of v.merge) {
    for (const order of m.orders) {
      const state = mergeState(m.ops, order);
      check(`fusion « ${m.name} » ordre ${order.join(',')}`, canonicalJson(state), m.state);
      check(
        `lignes « ${m.name} » ordre ${order.join(',')}`,
        canonicalJson(materializeRows(state)),
        m.rows
      );
    }
  }

  {
    const row = JSON.parse(v.materialize.row) as DbRow;
    const regs = rowToRegisters(row, v.materialize.t, v.materialize.order);
    check('ligne en ligne → registres', canonicalJson(regs), v.materialize.registers);
    check('registres → ligne', canonicalJson(materializeRow(row.id, regs)), v.materialize.back);
  }

  check(
    'HKDF RFC 5869 cas 3',
    toHex(await c.hkdf(fromHex(v.hkdfRfc5869Case3.ikm), new Uint8Array(0), '', 42)),
    v.hkdfRfc5869Case3.okm
  );

  const fek = fromHex(v.keys.fek);
  const personalId = await personalStoreId(c, fek, v.keys.dbId);
  check('storeId personnel', personalId, v.keys.personal.storeId);
  const personal = await storeKeys(c, fek, personalId, v.keys.personal.epoch);
  const vaultId = await vaultStoreId(c, v.keys.vaultId, v.keys.dbId);
  check('storeId de coffre', vaultId, v.keys.vault.storeId);
  const vault = await storeKeys(c, fromHex(v.keys.kVault), vaultId, v.keys.vault.epoch);
  for (const [name, keys, want] of [
    ['personnel', personal, v.keys.personal],
    ['coffre', vault, v.keys.vault],
  ] as const) {
    check(`K_db ${name}`, toHex(keys.kDb), want.kDb);
    check(`K_head ${name}`, toHex(keys.kHead), want.kHead);
    for (const [p, hex] of Object.entries(want.kSlot))
      check(`K_slot(${p}) ${name}`, toHex(await slotKey(c, keys, p)), hex);
  }

  // Précision 3.9 : générations ; g = 0 redonne les clés d'avant
  for (const [name, ikm, storeId, want, base] of [
    ['personnel', fek, personalId, v.generations.personal, v.keys.personal],
    ['coffre', fromHex(v.keys.kVault), vaultId, v.generations.vault, v.keys.vault],
  ] as const) {
    for (const gen of want) {
      const keys = await storeKeys(c, ikm, storeId, gen.e, gen.g);
      check(`info ${name} (e ${gen.e}, g ${gen.g})`, dbKeyInfo(gen.e, gen.g), gen.info);
      check(`K_db ${name} (e ${gen.e}, g ${gen.g})`, toHex(keys.kDb), gen.kDb);
      check(`K_head ${name} (e ${gen.e}, g ${gen.g})`, toHex(keys.kHead), gen.kHead);
      if (gen.g === 0) check(`g = 0 ${name} = clés d'avant`, gen.kDb, base.kDb);
    }
  }

  // Précision 3.3 : placement et empreintes sous les clés de la TÊTE
  const headKeys = headKeyBytes(JSON.parse(v.head.json) as StoreHead);
  check('clé de placement = celle de la tête', v.placement.placeKey, toBase64Url(headKeys.place));
  check('recouvrement des vecteurs', isCover(v.placement.cover), true);
  for (const p of v.placement.rows) {
    const hash = await placeHash(c, headKeys.place, p.rowId);
    check(`placement ${JSON.stringify(p.rowId)}`, toHex(hash), p.hmac);
    check(
      `préfixe ${JSON.stringify(p.rowId)}`,
      prefixFor(hash, new Set(v.placement.cover)),
      p.prefix
    );
  }

  // Le bloc : encodage, déchiffrement, inflation, chiffrement sous l'IV donné, empreinte
  const s = v.slot;
  const rows = JSON.parse(s.rows) as StoreRows;
  check('JSON du bloc', slotJson(s.prefix, rows), s.json);
  check('relecture du JSON du bloc', canonicalJson(parseSlotJson(s.json).rows), s.rows);
  const body = fromBase64Url(s.body);
  const key = await slotKey(c, personal, s.prefix);
  const aad = slotAad(personal.storeId, s.prefix, s.ver);
  let compressed: Uint8Array | null = null;
  try {
    compressed = await open(c, key, body, aad);
  } catch (e) {
    bad.push(`déchiffrement du bloc : ${(e as Error).message}`);
  }
  if (compressed) check('clair compressé du bloc', toBase64Url(compressed), s.compressed);
  try {
    const opened = await openSlot(c, personal, s.prefix, s.ver, body);
    check('bloc ouvert', canonicalJson(opened.rows), s.rows);
  } catch (e) {
    bad.push(`ouverture du bloc : ${(e as Error).message}`);
  }
  const resealed = await c.aesGcmEncrypt(key, fromHex(s.iv), fromBase64Url(s.compressed), aad);
  check(
    'chiffrement du bloc sous l’IV donné',
    toBase64Url(new Uint8Array([...fromHex(s.iv), ...resealed])),
    s.body
  );
  check('empreinte du bloc', await slotMac(c, headKeys.mac, body), s.mac);
  const deflateIdentique =
    toBase64Url(deflateSync(utf8Encode(s.json), { level: 6 })) === s.compressed;

  // La tête : JSON canonique, chiffrement sous l'IV donné, ouverture avec vérification de la racine
  const h = v.head;
  const head = JSON.parse(h.json) as StoreHead;
  check('JSON de la tête', headJson(head), h.json);
  check('racine de Merkle', await merkleRoot(c, headKeys.mac, head.slots), h.root);
  check(
    'chiffrement de la tête sous l’IV donné',
    toBase64Url(await sealHead(c, personal, h.seq, head, fromHex(h.iv))),
    h.body
  );
  try {
    const opened = await openHead(c, personal, h.seq, fromBase64Url(h.body));
    check('tête ouverte', headJson(opened), h.json);
    for (const [p, b64] of Object.entries(h.otherSlots)) {
      check(
        `empreinte du bloc ${p} contre la tête`,
        await slotMac(c, headKeys.mac, fromBase64Url(b64)),
        opened.slots[p]?.mac
      );
    }
  } catch (e) {
    bad.push(`ouverture de la tête : ${(e as Error).message}`);
  }

  // L'index de zone (précision 3.8) : recalculé sur les mêmes blocs, et la zone périmée écartée
  const z = v.zones;
  const recomputed = headZones(
    z.slots.map((s) => [s.p, { ver: s.ver, rows: JSON.parse(s.rows) }] as const),
    JSON.parse(z.properties)
  );
  check('zones (3.8)', canonicalJson(recomputed), z.zones);
  check(
    'zones périmées écartées (3.8)',
    [...validZones({ slots: z.stale.slots, zones: JSON.parse(z.stale.zones) }).keys()].sort(),
    z.stale.valid
  );

  return { mismatches: bad, deflateIdentique };
}
