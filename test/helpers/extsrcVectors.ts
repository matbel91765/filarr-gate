// Écrit dans filarr-gate (origine) — à recopier par filarg et le mobile (lot B2), avec le fichier de vecteurs.
/**
 * Les vecteurs de `source-externe-1` (§ 15) produits par le cœur pur de la boîte
 * noire, et leur rejoueur. Familles portées ici :
 *  1. identité (sourceIdentity par connecteur et source `query`, clés canoniques, rowId, empreintes, file) ;
 *  3. mergeCell : la table du § 6.3 (cas A à G × in, out, both × source, filarr, latest, ask, sans politique,
 *     égalité de latest, registre jamais écrit, accord du premier passage) et la cellule déjà en file ;
 *  3 bis et 4. planPass : les scénarios de la file (pleine, décision en double ou rejouée, conflits de ligne,
 *     rafale et ack.initial) et des lignes (créées, convergence, idempotence, onGone, onFilarrDelete,
 *     garde-fou au seuil et un au-dessus, table vidée, clés en double, publish) ;
 *  5. définitions (chaque code, signature Ed25519 avec une clé de test, autre clé refusée) ;
 *  6 et 7. scellés : K_xs (état, file, décision) et K_shadow, IV imposé ;
 *  8. schéma : managedBy, extra.extSource, #x.extGone relus et réécrits à l'octet près, options créées.
 * La famille 2 (conversions par connecteur) est rejouée par les essais des connecteurs, pas ici.
 *
 * Encodage JSON : un `bigint` s'écrit `{ "$bigint": "…" }` ; un champ `undefined` est omis.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import {
  applyClocks,
  canonicalKey,
  extRowId,
  mergeCell,
  planPass,
  queueAad,
  queueEntryId,
  resolveAad,
  sealJson,
  shadowAad,
  shadowKey,
  signDef,
  sourceIdentity,
  statusAad,
  statusKey,
  validateDef,
  valueHash,
  verifyDefSignature,
  withMintedOptions,
  defSigningMessage,
  openJson,
  type CellInput,
  type Decision,
  type ExtSourceDef,
  type FilarrRow,
  type OptionMint,
  type PlanInput,
  type PropSpec,
  type QueueEntry,
  type Shadow,
} from '../../packages/core/src/engine/extsrc';
import { toBase64Std } from '../../packages/core/src/engine/store/apiAccess';
import { canonicalJson, headJson, parseSlotJson, slotJson, type StoreHead, type StoreSchema } from '../../packages/core/src/engine/store/codec';
import { utf8Decode, type StoreCrypto } from '../../packages/core/src/engine/store/crypto';
import { formatHlc } from '../../packages/core/src/engine/store/hlc';
import type { AccessCurves } from '../../packages/core/src/engine/store/apiAccess';

// ==================== Encodage ====================

export function encodeJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? { $bigint: v.toString(10) } : v)));
}

export function decodeJson<T = unknown>(value: unknown): T {
  return JSON.parse(JSON.stringify(value), (_k, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1 && keys[0] === '$bigint' && typeof o.$bigint === 'string') return BigInt(o.$bigint);
    }
    return v;
  }) as T;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string): Uint8Array => new Uint8Array((s.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const H = (v: unknown) => valueHash(sha256, v);
const hlc = (ms: number, n = 0) => formatHlc(ms, n, 'a1b2c3d4');

// ==================== Le jeu commun ====================

const DEF_ID = 'xs_AAAAAAAAAAAAAAAAAAAAAA';
const NOW = '2026-10-10T12:00:00.000Z';

const PROPS: Record<string, PropSpec> = {
  p_id: { id: 'p_id', type: 'number' },
  p_nom: { id: 'p_nom', type: 'text' },
  p_statut: { id: 'p_statut', type: 'select', options: [{ id: 'o_a', label: 'Actif' }, { id: 'o_p', label: 'Perdu' }] },
};

function def(over: Partial<ExtSourceDef> = {}): ExtSourceDef {
  return {
    v: 1,
    id: DEF_ID,
    rev: 1,
    name: 'Clients',
    connector: 'd1',
    conn: { account: 'acc', database: 'db1' },
    host: 'api.cloudflare.com',
    from: { table: 'clients' },
    key: { cols: ['id'], gen: 'source' },
    marker: null,
    mode: 'both',
    map: [
      { col: 'id', prop: 'p_id', dir: 'in', type: 'number' },
      { col: 'nom', prop: 'p_nom', dir: 'both', type: 'text' },
      { col: 'statut', prop: 'p_statut', dir: 'both', type: 'select' },
    ],
    conflict: 'source',
    rowConflict: 'delete',
    onGone: 'mark',
    onFilarrDelete: 'delete',
    guard: { pct: 20, min: 10 },
    runner: { kind: 'gate', accessId: 'acc_1' },
    schedule: { every: '15m' },
    signer: 'u_1',
    ...over,
  };
}

type PlanArgs = Partial<PlanInput> & { rows?: Array<Record<string, unknown>>; fil?: FilarrRow[]; full?: boolean };

/** L'entrée d'un passage, sans la fonction d'empreinte (le rejoueur la remet). */
type PlanInputJson = Omit<PlanInput, 'sha256'>;

function planInput(over: PlanArgs = {}): PlanInputJson {
  const d = over.def ?? def();
  const { rows, fil, full, ...rest } = over;
  return {
    def: d,
    identity: sourceIdentity(d, sha256),
    props: PROPS,
    shadow: null,
    queue: [],
    decisions: [],
    source: { rows: (rows ?? []).map((raw) => ({ raw })), full: full ?? true },
    filarr: fil ?? [],
    now: NOW,
    passId: 'pass1',
    ack: null,
    ...rest,
  };
}

const run = (input: PlanInputJson) => planPass({ ...input, sha256 });

/** Une file de plus de 50 entrées s'écrit par sa longueur et l'empreinte de son JSON canonique (le fichier reste lisible). */
export function planOutput(plan: ReturnType<typeof planPass>): unknown {
  const out = encodeJson(plan) as Record<string, unknown>;
  const queue = out.queue as unknown[];
  if (queue.length > 50) out.queue = { $length: queue.length, $sha256: hex(sha256(new TextEncoder().encode(canonicalJson(queue)))) };
  return out;
}

const rows3 = [
  { id: 1, nom: 'Acme', statut: 'Actif' },
  { id: 2, nom: 'Globex', statut: 'Actif' },
  { id: 3, nom: 'Initech', statut: 'Perdu' },
];

/** Un premier passage appliqué : les lignes de Filarr et l'ombre qu'il laisse (horloges posées). */
function afterFirstPass(input: PlanInputJson, start = 10_000): { fil: FilarrRow[]; shadow: Shadow; tick: () => string } {
  let t = start;
  const tick = () => hlc((t += 1));
  const p = run(input);
  const ticks = p.toFilarr.map(() => tick());
  const fil: FilarrRow[] = p.created.map((id) => ({ id, deleted: false, regs: {} }));
  p.toFilarr.forEach((op, i) => (fil.find((r) => r.id === op.r)!.regs[op.f] = { v: op.v, t: ticks[i]! }));
  return { fil, shadow: applyClocks(p, ticks), tick };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ==================== Famille 1 : identité ====================

function identityFamily() {
  const sources: Array<Pick<ExtSourceDef, 'connector' | 'conn' | 'from'>> = [
    { connector: 'd1', conn: { account: 'acc', database: 'db1' }, from: { table: 'clients' } },
    { connector: 'postgres', conn: { host: 'DB.lan', db: 'erp', user: 'x' }, from: { table: 'cmd' } },
    { connector: 'postgres', conn: { host: 'db.lan', port: 6543, db: 'erp', user: 'x', schema: 'ventes' }, from: { table: 'cmd' } },
    { connector: 'mysql', conn: { host: 'MySQL.lan', db: 'shop', user: 'x' }, from: { table: 'orders' } },
    { connector: 'supabase', conn: { url: 'https://ABC.supabase.co' }, from: { table: 'leads' } },
    { connector: 'airtable', conn: { base: 'appXYZ', table: 'tblClients' }, from: { table: 'tblClients' } },
    { connector: 'gsheets', conn: { spreadsheet: '1AbC', tab: 'Feuille 1' }, from: { table: 'Feuille 1' } },
    { connector: 'notion', conn: { database: 'abc' }, from: { table: '' } },
    { connector: 'url', conn: { url: 'https://exemple.fr/export.csv#frag', format: { kind: 'csv' } }, from: { table: '' } },
    { connector: 'd1', conn: { account: 'a', database: 'b' }, from: { query: '  SELECT 1  ' } },
  ];
  const keyCases: Array<{ values: unknown[] }> = [
    { values: [42] },
    { values: [12345678901234567890n] },
    { values: [' Élise '] },
    { values: ['A1B2C3D4-0000-4000-8000-ABCDEFABCDEF'] },
    { values: ['FR', 7] },
    { values: ['FR', 7, 'b'] },
    { values: [''] },
    { values: [null] },
    { values: [1.5] },
    { values: [true] },
  ];
  const identity = sourceIdentity(sources[0]!, sha256);
  return {
    sourceIdentity: sources.map((s) => ({ source: s, identity: sourceIdentity(s, sha256) })),
    canonicalKey: keyCases.map(({ values }) => {
      try {
        return { values, key: canonicalKey(values) };
      } catch (err) {
        return { values, error: (err as Error).message };
      }
    }),
    rowId: ['1', 'FR\u001f7', ' Élise '].map((key) => ({ identity, key, rowId: extRowId(sha256, identity, key) })),
    valueHash: [null, '', 'a', 12.5, true, ['o_b', 'o_a'], { b: 1, a: 'é' }].map((value) => ({ value, h: H(value) })),
    queueEntryId: [{ defId: DEF_ID, key: '1', col: 'nom', hS: H('S'), hF: H('F') }, { defId: DEF_ID, key: '1', col: '#row', hS: H(null), hF: H('F') }].map((x) => ({ ...x, id: queueEntryId(sha256, x.defId, x.key, x.col, x.hS, x.hF) })),
  };
}

// ==================== Famille 3 : mergeCell ====================

function cell(over: Partial<CellInput>): CellInput {
  return { dir: 'both', policy: 'source', shadow: { h: H('a'), t: hlc(1000) }, vS: 'a', hS: H('a'), F: { v: 'a', t: hlc(1000) }, hF: H('a'), tS: null, q: null, d: null, initial: null, ...over };
}
const S = (v: unknown) => ({ vS: v, hS: H(v) });
const F = (v: unknown, t: string | null) => ({ F: { v, t }, hF: H(v) });

function mergeFamily() {
  const scenarios: Array<{ name: string; input: Partial<CellInput> }> = [
    { name: 'A', input: {} },
    { name: 'B', input: { ...S('b') } },
    { name: 'C', input: { ...F('c', hlc(2000)) } },
    { name: 'D', input: { ...S('d'), ...F('d', hlc(2000)) } },
    { name: 'E, source plus récente', input: { ...S('s'), ...F('f', hlc(2000)), tS: 3000 } },
    { name: 'E, Filarr plus récent', input: { ...S('s'), ...F('f', hlc(2000)), tS: 1500 } },
    { name: 'E, égalité de latest', input: { ...S('s'), ...F('f', hlc(2000)), tS: 2000 } },
    { name: 'E, sans repère', input: { ...S('s'), ...F('f', hlc(2000)) } },
    { name: 'F', input: { shadow: null, ...S('x'), ...F('x', hlc(2000)) } },
    { name: 'G', input: { shadow: null, ...S('s'), ...F('f', hlc(2000)), tS: 3000 } },
    { name: 'G, registre jamais écrit', input: { shadow: null, ...S('s'), ...F(null, null), tS: 0 } },
  ];
  const table: Array<{ name: string; input: CellInput; output: unknown }> = [];
  for (const sc of scenarios) {
    for (const dir of ['in', 'out'] as const) {
      const input = cell({ ...sc.input, dir, policy: null });
      table.push({ name: `${sc.name} · ${dir}`, input, output: mergeCell(input) });
    }
    for (const policy of ['source', 'filarr', 'latest', 'ask', null] as const) {
      const input = cell({ ...sc.input, dir: 'both', policy });
      table.push({ name: `${sc.name} · both · ${policy ?? 'sans politique'}`, input, output: mergeCell(input) });
    }
  }
  for (const initial of ['source', 'filarr'] as const) {
    const input = cell({ shadow: null, ...S('s'), ...F('f', hlc(2000)), policy: 'ask', initial });
    table.push({ name: `G · both · ask · ack.initial ${initial}`, input, output: mergeCell(input) });
  }

  // La cellule déjà en file (§ 6.12)
  const q: QueueEntry = { id: 'q1', row: 'r', key: 'k', col: 'statut', prop: 'p', source: { v: 'S', h: H('S'), at: null }, filarr: { v: 'F', h: H('F'), t: hlc(5000) }, kind: 'cell', since: '2026-10-10T00:00:00Z', truncated: false };
  const d = (choice: Decision['choice']): Decision => ({ id: 'q1', choice, by: { userId: 'u1', device: 'PC' }, at: '2026-10-10T00:00:01Z', seq: 7 });
  const queued: Array<{ name: string; input: Partial<CellInput> }> = [
    { name: 'décision à jour : garder Filarr', input: { ...S('S'), ...F('F', hlc(5000)), policy: 'ask', q, d: d('filarr') } },
    { name: 'décision à jour : prendre la source', input: { ...S('S'), ...F('F', hlc(5000)), policy: 'ask', q, d: d('source') } },
    { name: 'décision périmée (la source a changé)', input: { ...S('S2'), ...F('F', hlc(5000)), policy: 'ask', q, d: d('filarr') } },
    { name: 'sans décision, valeurs inchangées (I8)', input: { ...S('S'), ...F('F', hlc(5000)), policy: 'ask', q } },
    { name: 'sans décision, Filarr a changé', input: { ...S('S'), ...F('F2', hlc(6000)), policy: 'ask', q } },
    { name: 'sans décision, valeurs rejointes (D)', input: { ...S('X'), ...F('X', hlc(6000)), policy: 'ask', q } },
    { name: 'repassée en automatique, askPending apply', input: { ...S('S'), ...F('F', hlc(5000)), policy: 'source', askPending: 'apply', q } },
    { name: 'repassée en automatique, askPending keep', input: { ...S('S'), ...F('F', hlc(5000)), policy: 'source', askPending: 'keep', q } },
  ];
  for (const sc of queued) {
    const input = cell({ ...sc.input, shadow: { h: H('a'), t: hlc(1000) } });
    table.push({ name: `en file · ${sc.name}`, input, output: mergeCell(input) });
  }
  return table;
}

// ==================== Familles 3 bis et 4 : planPass ====================

function planFamily() {
  const out: Array<{ name: string; input: PlanInputJson; output: unknown }> = [];
  const add = (name: string, input: PlanInputJson) => out.push({ name, input: clone(input), output: planOutput(run(input)) });

  add('premier passage : lignes créées à leur identifiant calculé', planInput({ rows: rows3 }));

  const first = afterFirstPass(planInput({ rows: rows3 }));
  add('I1 : rien ne change, rien n’est écrit', planInput({ rows: rows3, fil: first.fil, shadow: first.shadow }));

  {
    const fil = clone(first.fil);
    fil.find((r) => r.regs.p_id?.v === 1)!.regs.p_nom = { v: 'Acme Corp', t: hlc(20_000) };
    add('I2 : Filarr change, la source est écrite', planInput({ rows: rows3, fil, shadow: first.shadow }));
    add('I2 : rejoué après une panne, la source porte déjà la valeur (D)', planInput({ rows: rows3.map((r) => (r.id === 1 ? { ...r, nom: 'Acme Corp' } : r)), fil, shadow: first.shadow }));
  }

  const two = rows3.filter((r) => r.id !== 3);
  for (const onGone of ['mark', 'delete', 'keep'] as const) {
    add(`ligne disparue : onGone ${onGone}`, planInput({ rows: two, fil: first.fil, shadow: first.shadow, def: def({ onGone, guard: { pct: 100, min: 10 } }) }));
  }
  {
    const marked = run(planInput({ rows: two, fil: first.fil, shadow: first.shadow, def: def({ guard: { pct: 100, min: 10 } }) }));
    add('réapparition : la marque est levée', planInput({ rows: rows3, fil: first.fil, shadow: marked.shadow }));
  }

  {
    const fil = clone(first.fil);
    fil[1]!.deleted = true;
    add('supprimée dans Filarr : onFilarrDelete delete', planInput({ rows: rows3, fil, shadow: first.shadow }));
    add('supprimée dans Filarr : onFilarrDelete ignore', planInput({ rows: rows3, fil, shadow: first.shadow, def: def({ onFilarrDelete: 'ignore' }) }));
    add('supprimée dans Filarr : miroir, restaurée', planInput({ rows: rows3, fil, shadow: first.shadow, def: def({ mode: 'mirror', map: def().map.map((m) => ({ ...m, dir: 'in' as const })) }) }));
  }

  {
    const fil = clone(first.fil);
    fil[0]!.deleted = true;
    const changed = rows3.map((r) => (r.id === 1 ? { ...r, nom: 'Acme Corp' } : r));
    for (const rowConflict of ['delete', 'keep', 'ask'] as const) {
      add(`suppression contre modification : rowConflict ${rowConflict}`, planInput({ rows: changed, fil, shadow: first.shadow, def: def({ rowConflict }) }));
    }
  }

  {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, nom: `C${i + 1}`, statut: 'Actif' }));
    const g = def({ guard: { pct: 20, min: 2 } });
    const base = afterFirstPass(planInput({ rows, def: g }));
    add('garde-fou : au seuil exact, on passe', planInput({ rows: rows.slice(4), fil: base.fil, shadow: base.shadow, def: g }));
    const over = planInput({ rows: rows.slice(5), fil: base.fil, shadow: base.shadow, def: g });
    add('garde-fou : un au-dessus, arrêt avant toute écriture', over);
    add('garde-fou : accord pour ce passage', { ...over, ack: { guard: String(run(over).stop!.question.pass) } });
    add('garde-fou : table vidée', planInput({ rows: [], fil: base.fil, shadow: base.shadow, def: g }));
  }

  {
    const n = 60;
    const rows = Array.from({ length: n }, (_, i) => ({ id: i + 1, nom: `S${i}`, statut: 'Actif' }));
    const identity = sourceIdentity(def(), sha256);
    const fil: FilarrRow[] = rows.map((r, i) => ({ id: extRowId(sha256, identity, String(r.id)), deleted: false, regs: { p_id: { v: r.id, t: hlc(1, i) }, p_nom: { v: `F${i}`, t: hlc(2, i) }, p_statut: { v: 'o_a', t: hlc(2, i) } } }));
    const d = def({ conflict: 'ask' });
    add('rafale de conflits au premier passage : arrêt', planInput({ rows, fil, def: d }));
    add('rafale : ack.initial source tranche le premier passage', planInput({ rows, fil, def: d, ack: { initial: 'source' } }));
  }

  {
    // File pleine : 500 entrées pour d'autres clés ; le conflit nouveau de la ligne 1 n'entre pas
    const identity = sourceIdentity(def(), sha256);
    const id = extRowId(sha256, identity, '1');
    const shadow: Shadow = { v: 1, def: DEF_ID, defRev: 1, marker: null, fullAt: null, passes: 0, rows: { '1': { id, cells: { id: { h: H(1), t: hlc(1) }, nom: { h: H('old'), t: hlc(1) }, statut: { h: H('o_a'), t: hlc(1) } } } }, echo: {}, unstable: {} };
    const queue: QueueEntry[] = Array.from({ length: 500 }, (_, i) => ({ id: `old${i}`, row: `x${i}`, key: `zz${i}`, col: 'nom', prop: 'p_nom', source: { v: 1, h: 'h', at: null }, filarr: { v: 2, h: 'h2', t: null }, kind: 'cell' as const, since: '', truncated: false }));
    add(
      'file pleine : la 501e cellule n’entre pas, n’est écrite d’aucun côté',
      planInput({ rows: [{ id: 1, nom: 'S0', statut: 'Actif' }], full: false, fil: [{ id, deleted: false, regs: { p_id: { v: 1, t: hlc(1) }, p_nom: { v: 'F0', t: hlc(3) }, p_statut: { v: 'o_a', t: hlc(1) } } }], shadow, queue, def: def({ conflict: 'ask' }), passId: 'p' })
    );
  }

  {
    const d = def({ conflict: 'ask' });
    const base = afterFirstPass(planInput({ rows: rows3, def: d }));
    const fil = clone(base.fil);
    fil[0]!.regs.p_nom = { v: 'Acme F', t: hlc(20_000) };
    const changed = rows3.map((r) => (r.id === 1 ? { ...r, nom: 'Acme S' } : r));
    const queuedIn = planInput({ rows: changed, fil, shadow: base.shadow, def: d });
    add('conflit en ask : une entrée de file', queuedIn);
    const queued = run(queuedIn);
    const entry = queued.queue[0]!;
    const decisions: Decision[] = [
      { id: entry.id, choice: 'source', by: { userId: 'u_a' }, at: '', seq: 1 },
      { id: entry.id, choice: 'filarr', by: { userId: 'u_b' }, at: '', seq: 2 },
    ];
    const resolvedIn = planInput({ rows: changed, fil, shadow: queued.shadow, def: d, queue: queued.queue, decisions });
    add('deux décisions pour la même entrée : la première s’applique, la seconde est resolution_duplicate', resolvedIn);
    const resolved = run(resolvedIn);
    const written = hlc(30_000);
    add(
      'décision rejouée après une panne avant l’acquittement : aucun effet',
      planInput({ rows: changed, fil: fil.map((r) => (r.id === fil[0]!.id ? { ...r, regs: { ...r.regs, p_nom: { v: 'Acme S', t: written } } } : r)), shadow: applyClocks(resolved, [written]), def: d, queue: [], decisions })
    );
  }

  add('clé en double et ligne sans clé : laissées de côté', planInput({ rows: [{ id: 1, nom: 'A' }, { id: 1, nom: 'B' }, { id: null, nom: 'C' }] }));
  {
    const d = def({ mode: 'publish', map: def().map.map((m) => ({ ...m, dir: m.col === 'id' ? ('in' as const) : ('out' as const) })) });
    add('publish : onSourceOnly keep n’importe rien', planInput({ rows: rows3, def: d }));
    add('publish : onSourceOnly import', planInput({ rows: rows3, def: { ...d, onSourceOnly: 'import' } }));
    add('publish : ligne neuve dans Filarr insérée dans la source', planInput({ rows: [], def: d, fil: [{ id: 'db-neuve', deleted: false, regs: { p_nom: { v: 'Hooli', t: hlc(5) } } }] }));
  }
  add('libellé inconnu : option créée (ext-opt-)', planInput({ rows: [{ id: 9, nom: 'Hooli', statut: 'Prospect' }] }));
  return out;
}

// ==================== Famille 5 : définitions ====================

const SIGNING_KEY_HEX = '07'.repeat(32);
const OTHER_KEY_HEX = '09'.repeat(32);

function defFamily(curves: AccessCurves) {
  const overs: Array<Partial<ExtSourceDef> & Record<string, unknown>> = [
    {},
    { v: 2 as 1 },
    { id: 'xs_court' },
    { name: '' },
    { connector: 'oracle' as 'd1' },
    { conn: { account: 'a' } },
    { host: 'evil.example' },
    { connector: 'url', conn: { url: 'https://10.0.0.1/x.csv', format: { kind: 'csv' } }, host: '10.0.0.1', mode: 'mirror' },
    { connector: 'postgres', conn: { host: 'db.example.com', db: 'erp', user: 'u', tls: 'off-local' }, host: 'db.example.com:5432' },
    { from: { query: 'DELETE FROM t' }, mode: 'mirror' },
    { from: { query: 'SELECT 1' } },
    { key: { cols: [], gen: 'source' } },
    { key: { cols: ['a', 'b', 'c', 'd'], gen: 'source' } },
    { key: { cols: ['absente'], gen: 'source' } },
    { marker: { col: 'maj', kind: 'semaine' as 'iso' } },
    { conflict: 'latest' },
    { map: [] },
    { map: [...def().map, { col: 'autre', prop: 'p_nom', dir: 'both', type: 'text' }] },
    { map: [...def().map, { col: 'nom', prop: 'p_x', dir: 'both', type: 'text' }] },
    { mode: 'mirror' },
    { map: [...def().map, { col: 'z', prop: 'p_z', dir: 'both', type: 'hologramme' }] },
    { map: [...def().map, { col: 'z', prop: 'p_z', dir: 'in', type: 'formula' }] },
    { connector: 'postgres', conn: { host: 'db.lan', db: 'erp', user: 'u' }, host: 'db.lan:5432', runner: { kind: 'hosted' as 'gate', accessId: 'a' } },
    { schedule: { every: '5m' as '15m' } },
    { conflict: undefined },
    { rowConflict: undefined },
    { conflict: 'random' as 'source' },
    { map: def().map.map((m) => (m.col === 'nom' ? { ...m, askPending: 'peut-être' as 'apply' } : m)) },
    { name: 'x'.repeat(60), ignored: Array.from({ length: 2000 }, (_, i) => `colonne_${i}`) },
  ];
  const key = unhex(SIGNING_KEY_HEX);
  const signed = signDef(curves, def(), key);
  const tampered = { ...signed, from: { query: 'SELECT * FROM utilisateurs' } };
  return {
    validate: overs.map((over) => {
      const input = { ...def(), ...over };
      return { def: input, codes: validateDef(input) };
    }),
    signature: {
      signingKeyHex: SIGNING_KEY_HEX,
      publicKey: toBase64Std(curves.ed25519PublicKey(key)),
      message: utf8Decode(defSigningMessage(signed)),
      signed,
      otherPublicKey: toBase64Std(curves.ed25519PublicKey(unhex(OTHER_KEY_HEX))),
      verifyWithPublicKey: true,
      verifyWithOtherKey: verifyDefSignature(curves, signed, toBase64Std(curves.ed25519PublicKey(unhex(OTHER_KEY_HEX)))),
      tampered,
      verifyTampered: verifyDefSignature(curves, tampered, toBase64Std(curves.ed25519PublicKey(key))),
    },
  };
}

// ==================== Familles 6 et 7 : scellés ====================

const K_DB_HEX = '03'.repeat(32);
const STORE = 'store_AAAAAAAAAAAAAAAAAA';
const RUNNER = 'a:acc_1';

async function sealFamily(c: StoreCrypto) {
  const kDb = unhex(K_DB_HEX);
  const kxs = await statusKey(c, kDb, STORE);
  const kShadow = await shadowKey(c, kDb, STORE, DEF_ID);
  const iv = (n: number) => new Uint8Array(12).fill(n);
  const status = { v: 1, def: DEF_ID, defRev: 1, state: 'ok', code: null, at: NOW };
  const queue = { v: 1, def: DEF_ID, entries: [] };
  const decision = { id: 'q1', choice: 'filarr', by: { userId: 'u1', device: 'PC' }, at: NOW };
  const shadow: Shadow = { v: 1, def: DEF_ID, defRev: 1, marker: null, fullAt: NOW, passes: 0, rows: { '1': { id: 'ext-x', cells: { nom: { h: H('Acme'), t: hlc(1000) } } } }, echo: {}, unstable: {} };
  const one = async (key: Uint8Array, plain: unknown, aad: string, n: number) => ({ aad, ivHex: hex(iv(n)), plain, sealed: await sealJson(c, key, plain, aad, iv(n)) });
  return {
    kDbHex: K_DB_HEX,
    storeId: STORE,
    runnerId: RUNNER,
    defId: DEF_ID,
    kxsHex: hex(kxs),
    kShadowHex: hex(kShadow),
    status: await one(kxs, status, statusAad(STORE, RUNNER, 4), 1),
    queue: await one(kxs, queue, queueAad(STORE, RUNNER, 2), 2),
    resolve: await one(kxs, decision, resolveAad(STORE, RUNNER), 3),
    shadow: await one(kShadow, shadow, shadowAad(STORE, DEF_ID), 4),
  };
}

// ==================== Famille 8 : schéma ====================

function schemaFamily() {
  const signedDef = def();
  const schema: StoreSchema = {
    properties: [
      { id: 'p_id', name: 'Id', type: 'number', managedBy: { src: DEF_ID, dir: 'in', col: 'id' } },
      { id: 'p_nom', name: 'Nom', type: 'text', managedBy: { src: DEF_ID, dir: 'both', col: 'nom' }, futurChamp: { garde: ['moi'] } },
      { id: 'p_statut', name: 'Statut', type: 'select', options: [{ id: 'o_a', label: 'Actif', color: 'green', inconnu: 1 }], managedBy: { src: DEF_ID, dir: 'both', col: 'statut' } },
      { id: 'p_note', name: 'Note', type: 'text' },
    ] as unknown as StoreSchema['properties'],
    extra: { extSource: { v: 1, defs: [signedDef], sealed: null }, autreRacine: { x: 1 } },
    t: hlc(5000),
  };
  const head = { v: 1, dbId: 'db_clients', keys: { place: 'cA', mac: 'cB' }, schema, slots: { '': { e: 0, mac: 'm', ver: 1 } }, root: 'r', epochs: [0], updated: NOW } as unknown as StoreHead;
  const rows = {
    'ext-AAAAAAAAAAAAAAAAAAAAAA': { p_id: { v: 1, t: hlc(10) }, p_nom: { v: 'Acme', t: hlc(11) } },
    'ext-BBBBBBBBBBBBBBBBBBBBBB': { p_id: { v: 3, t: hlc(10) }, '#x.extGone': { v: { at: NOW, src: DEF_ID }, t: hlc(12) } },
  };
  const minted: OptionMint[] = [{ propId: 'p_statut', option: { id: 'ext-opt-AAAAAAAAAAAA', label: 'Prospect' } }];
  const rewritten = withMintedOptions(schema as unknown as Parameters<typeof withMintedOptions>[0], minted, hlc(6000));
  return {
    headJson: headJson(head),
    slotJson: slotJson('', rows as never),
    minted,
    mintedAt: hlc(6000),
    schemaAfterMint: canonicalJson(rewritten),
  };
}

// ==================== Le fichier ====================

export interface ExtsrcVectors {
  contrat: 'source-externe-1';
  origine: string;
  lecture: string;
  identite: ReturnType<typeof identityFamily>;
  mergeCell: Array<{ name: string; input: CellInput; output: unknown }>;
  planPass: Array<{ name: string; input: PlanInputJson; output: unknown }>;
  definitions: ReturnType<typeof defFamily>;
  sceaux: Awaited<ReturnType<typeof sealFamily>>;
  schema: ReturnType<typeof schemaFamily>;
}

export async function buildExtsrcVectors(c: StoreCrypto, curves: AccessCurves): Promise<ExtsrcVectors> {
  return encodeJson({
    contrat: 'source-externe-1',
    origine: 'filarr-gate (cœur pur packages/core/src/engine/extsrc), à défaut d’une implémentation dans filarg',
    lecture:
      'Familles 1, 3, 3 bis, 4, 5, 6, 7 et 8 du § 15. Chaque cas : une entrée et la sortie attendue, comparées en JSON (champ undefined omis). ' +
      'Un bigint s’écrit {"$bigint":"…"}. planPass : l’entrée sans la fonction d’empreinte, qui est SHA-256. Scellés : base64url(IV ‖ AES-256-GCM), IV imposé.',
    identite: identityFamily(),
    mergeCell: mergeFamily(),
    planPass: planFamily(),
    definitions: defFamily(curves),
    sceaux: await sealFamily(c),
    schema: schemaFamily(),
  }) as ExtsrcVectors;
}

/** Le fichier : les familles une à une, un cas (ou un champ) par ligne. */
export function formatVectors(v: object): string {
  const lines: string[] = [];
  const entries = Object.entries(v);
  entries.forEach(([k, value], i) => {
    const comma = i < entries.length - 1 ? ',' : '';
    if (Array.isArray(value)) lines.push(`  ${JSON.stringify(k)}: [`, value.map((x) => `    ${JSON.stringify(x)}`).join(',\n'), `  ]${comma}`);
    else if (value !== null && typeof value === 'object') {
      const sub = Object.entries(value as Record<string, unknown>);
      lines.push(`  ${JSON.stringify(k)}: {`, sub.map(([sk, sv]) => `    ${JSON.stringify(sk)}: ${JSON.stringify(sv)}`).join(',\n'), `  }${comma}`);
    } else lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(value)}${comma}`);
  });
  return `{\n${lines.join('\n')}\n}\n`;
}

// ==================== Le rejoueur ====================

const same = (a: unknown, b: unknown) => JSON.stringify(encodeJson(a)) === JSON.stringify(b);

export async function replayExtsrcVectors(c: StoreCrypto, curves: AccessCurves, raw: ExtsrcVectors): Promise<string[]> {
  const v = raw;
  const bad: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) bad.push(name);
  };

  // 1. identité
  for (const x of v.identite.sourceIdentity) check(`identité ${x.identity}`, sourceIdentity(x.source, sha256) === x.identity);
  for (const x of v.identite.canonicalKey) {
    const values = decodeJson<unknown[]>(x.values);
    let got: { key: string | null } | { error: string };
    try {
      got = { key: canonicalKey(values) };
    } catch (err) {
      got = { error: (err as Error).message };
    }
    check(`clé ${JSON.stringify(x.values)}`, same(got, 'error' in x ? { error: x.error } : { key: x.key }));
  }
  for (const x of v.identite.rowId) check(`rowId ${x.key}`, extRowId(sha256, x.identity, x.key) === x.rowId);
  for (const x of v.identite.valueHash) check(`empreinte ${JSON.stringify(x.value)}`, H(x.value) === x.h);
  for (const x of v.identite.queueEntryId) check(`entrée de file ${x.col}`, queueEntryId(sha256, x.defId, x.key, x.col, x.hS, x.hF) === x.id);

  // 3. mergeCell
  for (const x of v.mergeCell) check(`mergeCell ${x.name}`, same(mergeCell(decodeJson<CellInput>(x.input)), x.output));

  // 3 bis, 4. planPass
  for (const x of v.planPass) check(`planPass ${x.name}`, JSON.stringify(planOutput(planPass({ ...decodeJson<PlanInputJson>(x.input), sha256 }))) === JSON.stringify(x.output));

  // 5. définitions
  for (const x of v.definitions.validate) check(`définition ${JSON.stringify(x.codes)}`, same(validateDef(decodeJson(x.def)), x.codes));
  const s = v.definitions.signature;
  const key = unhex(s.signingKeyHex);
  check('signature : clé publique', toBase64Std(curves.ed25519PublicKey(key)) === s.publicKey);
  check('signature : message', utf8Decode(defSigningMessage(s.signed)) === s.message);
  check('signature : signée à l’identique', same(signDef(curves, { ...s.signed, sig: undefined } as ExtSourceDef, key), s.signed));
  check('signature : vérifiée', verifyDefSignature(curves, s.signed, s.publicKey) === s.verifyWithPublicKey && s.verifyWithPublicKey);
  check('signature : autre clé refusée', verifyDefSignature(curves, s.signed, s.otherPublicKey) === false && s.verifyWithOtherKey === false);
  check('signature : champ changé refusé', verifyDefSignature(curves, s.tampered, s.publicKey) === false && s.verifyTampered === false);

  // 6, 7. scellés
  const z = v.sceaux;
  const kDb = unhex(z.kDbHex);
  const kxs = await statusKey(c, kDb, z.storeId);
  const kShadow = await shadowKey(c, kDb, z.storeId, z.defId);
  check('K_xs', hex(kxs) === z.kxsHex);
  check('K_shadow', hex(kShadow) === z.kShadowHex);
  for (const [name, k, item, aad] of [
    ['état', kxs, z.status, statusAad(z.storeId, z.runnerId, 4)],
    ['file', kxs, z.queue, queueAad(z.storeId, z.runnerId, 2)],
    ['décision', kxs, z.resolve, resolveAad(z.storeId, z.runnerId)],
    ['ombre', kShadow, z.shadow, shadowAad(z.storeId, z.defId)],
  ] as const) {
    check(`scellé ${name} : AAD`, item.aad === aad);
    check(`scellé ${name} : à l’identique`, (await sealJson(c, k, item.plain, aad, unhex(item.ivHex))) === item.sealed);
    check(`scellé ${name} : s’ouvre`, same(await openJson(c, k, item.sealed, aad).catch(() => '(illisible)'), item.plain));
    let refused = false;
    try {
      await openJson(c, k, item.sealed, `${aad}x`);
    } catch {
      refused = true;
    }
    check(`scellé ${name} : autre AAD refusée`, refused);
  }

  // 8. schéma à l'octet près
  const head = JSON.parse(v.schema.headJson) as StoreHead;
  check('schéma : tête réécrite à l’octet près', headJson(head) === v.schema.headJson);
  const slot = parseSlotJson(v.schema.slotJson);
  check('schéma : bloc avec #x.extGone réécrit à l’octet près', slotJson(slot.p, slot.rows) === v.schema.slotJson);
  const after = withMintedOptions(head.schema as unknown as Parameters<typeof withMintedOptions>[0], v.schema.minted, v.schema.mintedAt);
  check('schéma : options créées, le reste intact', canonicalJson(after) === v.schema.schemaAfterMint);
  return bad;
}

