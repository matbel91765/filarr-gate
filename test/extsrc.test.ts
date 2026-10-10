/**
 * Le cœur pur des synchros externes (`source-externe-1`) : la règle d'une cellule
 * (§ 6.3, cas A à G, quatre politiques, file « me demander »), la planification
 * d'un passage (§ 6.4 à § 6.12 : lignes, garde-fous, décisions, file pleine),
 * l'identité des lignes (§ 3), les conversions (§ 4), la validation et la
 * signature des définitions (§ 2.2, § 8.3), les scellés (§ 6.1, § 9.2).
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import {
  applyClocks,
  applyEcho,
  applySourceResults,
  canonicalKey,
  extRowId,
  isoUtc,
  mergeCell,
  openJson,
  planPass,
  queueEntryId,
  sealJson,
  shadowKey,
  signDef,
  sourceIdentity,
  statusAad,
  statusKey,
  toFilarr,
  toSource,
  validateDef,
  valueHash,
  verifyDefSignature,
  type CellInput,
  type Decision,
  type ExtSourceDef,
  type FilarrRow,
  type PlanInput,
  type PropSpec,
  type QueueEntry,
} from '../packages/core/src/engine/extsrc';
import { toBase64Std } from '../packages/core/src/engine/store/apiAccess';
import { formatHlc } from '../packages/core/src/engine/store/hlc';
import { curves, storeCrypto } from '../packages/gate/src/crypto/providers';

const H = (v: unknown) => valueHash(sha256, v);
const hlc = (ms: number, n = 0) => formatHlc(ms, n, 'a1b2c3d4');

const base = (over: Partial<CellInput> = {}): CellInput => ({
  dir: 'both',
  policy: 'source',
  shadow: { h: H('a'), t: hlc(1000) },
  vS: 'a',
  hS: H('a'),
  F: { v: 'a', t: hlc(1000) },
  hF: H('a'),
  tS: null,
  q: null,
  d: null,
  initial: null,
  ...over,
});
const src = (v: unknown) => ({ vS: v, hS: H(v) });
const fil = (v: unknown, t: string | null) => ({ F: { v, t }, hF: H(v) });

describe('mergeCell (§ 6.3)', () => {
  it('A : rien n’a changé', () => {
    expect(mergeCell(base())).toMatchObject({ case: 'A', queue: { op: 'none' } });
  });

  it('B : la source seule a changé — both et in écrivent Filarr, out réécrit la source', () => {
    const b = { ...src('b') };
    expect(mergeCell(base(b))).toMatchObject({ case: 'B', toFilarr: { v: 'b' }, shadow: { h: H('b'), t: null } });
    expect(mergeCell(base({ ...b, dir: 'in' }))).toMatchObject({ case: 'B', toFilarr: { v: 'b' } });
    const out = mergeCell(base({ ...b, dir: 'out' }));
    expect(out).toMatchObject({ case: 'B', toSource: { v: 'a' } });
    expect(out.journal[0]).toMatchObject({ kind: 'replaced_source', old: 'b', new: 'a' });
  });

  it('C : Filarr seul a changé — both et out partent vers la source, in remplace la valeur locale', () => {
    const c = fil('c', hlc(2000));
    expect(mergeCell(base(c))).toMatchObject({ case: 'C', toSource: { v: 'c' }, shadow: { h: H('c'), t: hlc(2000) } });
    const inn = mergeCell(base({ ...c, dir: 'in' }));
    expect(inn).toMatchObject({ case: 'C', toFilarr: { v: 'a' } });
    expect(inn.journal[0]).toMatchObject({ kind: 'replaced_local', old: 'c', new: 'a' });
  });

  it('D : les deux ont changé vers la même valeur — l’ombre avance, la file se vide', () => {
    const out = mergeCell(base({ ...src('d'), ...fil('d', hlc(3000)) }));
    expect(out).toMatchObject({ case: 'D', shadow: { h: H('d'), t: hlc(3000) }, queue: { op: 'remove' } });
    expect(out.toFilarr).toBeUndefined();
    expect(out.toSource).toBeUndefined();
  });

  it('E : conflit — source, filarr, latest (et son égalité), ask', () => {
    const e = { ...src('S'), ...fil('F', hlc(5000)) };
    expect(mergeCell(base({ ...e, policy: 'source' }))).toMatchObject({ case: 'E', toFilarr: { v: 'S' }, newConflict: true });
    expect(mergeCell(base({ ...e, policy: 'filarr' }))).toMatchObject({ case: 'E', toSource: { v: 'F' } });
    expect(mergeCell(base({ ...e, policy: 'latest', tS: 6000 }))).toMatchObject({ toFilarr: { v: 'S' } });
    expect(mergeCell(base({ ...e, policy: 'latest', tS: 4000 }))).toMatchObject({ toSource: { v: 'F' } });
    // `tS ≥ ms(F.t)` : l'égalité donne la source
    expect(mergeCell(base({ ...e, policy: 'latest', tS: 5000 }))).toMatchObject({ toFilarr: { v: 'S' } });
    const ask = mergeCell(base({ ...e, policy: 'ask' }));
    expect(ask).toMatchObject({ case: 'E', queue: { op: 'put', kind: 'queued' }, newConflict: true });
    expect(ask.toFilarr).toBeUndefined();
    expect(ask.toSource).toBeUndefined();
    expect(ask.shadow).toBeUndefined();
    // La perdante va au journal
    expect(mergeCell(base({ ...e, policy: 'source' })).journal[0]).toMatchObject({ kind: 'conflict', side: 'filarr', old: 'F', new: 'S' });
  });

  it('E en in et out : la direction l’emporte, au journal', () => {
    const e = { ...src('S'), ...fil('F', hlc(5000)) };
    expect(mergeCell(base({ ...e, dir: 'in', policy: null }))).toMatchObject({ toFilarr: { v: 'S' } });
    expect(mergeCell(base({ ...e, dir: 'out', policy: null }))).toMatchObject({ toSource: { v: 'F' } });
  });

  it('F et G : sans ombre — égales, l’ombre naît ; différentes, la politique (ou l’accord du premier passage)', () => {
    expect(mergeCell(base({ shadow: null }))).toMatchObject({ case: 'F', shadow: { h: H('a'), t: hlc(1000) } });
    const g = { shadow: null, ...src('S'), ...fil('F', hlc(5000)) };
    expect(mergeCell(base({ ...g, policy: 'filarr' }))).toMatchObject({ case: 'G', toSource: { v: 'F' } });
    expect(mergeCell(base({ ...g, policy: 'ask', initial: 'source' }))).toMatchObject({ case: 'G', toFilarr: { v: 'S' } });
    expect(mergeCell(base({ ...g, policy: null }))).toMatchObject({ journal: [{ kind: 'error', code: 'extdb_policy_missing' }] });
  });

  it('un registre jamais écrit (horloge nulle) : latest donne la source', () => {
    const out = mergeCell(base({ shadow: { h: H('x'), t: null }, ...src('S'), ...fil('F', hlc(9)), policy: 'latest', tS: 1 }));
    expect(out.toSource ?? out.toFilarr).toBeDefined();
  });
});

describe('la file « me demander » (§ 6.12)', () => {
  const S = src('S');
  const F = fil('F', hlc(5000));
  const q: QueueEntry = {
    id: 'q1',
    row: 'r',
    key: 'k',
    col: 'statut',
    prop: 'p',
    source: { v: 'S', h: H('S'), at: null },
    filarr: { v: 'F', h: H('F'), t: hlc(5000) },
    kind: 'cell',
    since: '2026-10-10T00:00:00Z',
    truncated: false,
  };
  const d = (choice: Decision['choice']): Decision => ({ id: 'q1', choice, by: { userId: 'u1', device: 'PC' }, at: '2026-10-10T00:00:01Z', seq: 7 });

  it('décision à jour appliquée : garder Filarr (source ← F) ou prendre la source (Filarr ← S)', () => {
    const keepF = mergeCell(base({ ...S, ...F, policy: 'ask', q, d: d('filarr') }));
    expect(keepF).toMatchObject({ case: 'Q', toSource: { v: 'F' }, queue: { op: 'remove' }, decision: 'applied' });
    expect(keepF.journal[0]).toMatchObject({ kind: 'resolved', by: { userId: 'u1' } });
    expect(mergeCell(base({ ...S, ...F, policy: 'ask', q, d: d('source') }))).toMatchObject({ toFilarr: { v: 'S' }, decision: 'applied' });
  });

  it('décision périmée (un côté a changé) : resolution_stale, la cellule redevient une entrée nouvelle', () => {
    const out = mergeCell(base({ ...src('S2'), ...F, policy: 'ask', q, d: d('filarr') }));
    expect(out.decision).toBe('stale');
    expect(out.journal[0]!.kind).toBe('resolution_stale');
    expect(out.queue).toEqual({ op: 'put', kind: 'requeued' });
    expect(out.toSource).toBeUndefined();
  });

  it('sans décision : intouchable tant que rien ne bouge (I8) ; un côté change : entrée remplacée ; valeurs rejointes : D', () => {
    expect(mergeCell(base({ ...S, ...F, policy: 'ask', q }))).toMatchObject({ case: 'Q', queue: { op: 'none' } });
    expect(mergeCell(base({ ...S, ...fil('F2', hlc(6000)), policy: 'ask', q }))).toMatchObject({ queue: { op: 'put', kind: 'requeued' } });
    expect(mergeCell(base({ ...src('X'), ...fil('X', hlc(6000)), policy: 'ask', q }))).toMatchObject({ case: 'D', queue: { op: 'remove' } });
  });

  it('colonne repassée en automatique : askPending apply tranche par la nouvelle règle, keep garde l’entrée', () => {
    const apply = mergeCell(base({ ...S, ...F, policy: 'source', askPending: 'apply', q }));
    expect(apply).toMatchObject({ toFilarr: { v: 'S' }, queue: { op: 'remove' } });
    expect(apply.journal[0]!.kind).toBe('resolved_by_policy');
    expect(mergeCell(base({ ...S, ...F, policy: 'source', askPending: 'keep', q }))).toMatchObject({ case: 'Q', queue: { op: 'none' } });
  });

  it('l’identifiant se calcule : même conflit, même entrée ; un côté change, entrée nouvelle', () => {
    const a = queueEntryId(sha256, 'xs_x', 'k', 'statut', H('S'), H('F'));
    expect(queueEntryId(sha256, 'xs_x', 'k', 'statut', H('S'), H('F'))).toBe(a);
    expect(queueEntryId(sha256, 'xs_x', 'k', 'statut', H('S2'), H('F'))).not.toBe(a);
  });
});

// ==================== planPass ====================

const PROPS: Record<string, PropSpec> = {
  p_id: { id: 'p_id', type: 'number' },
  p_nom: { id: 'p_nom', type: 'text' },
  p_statut: { id: 'p_statut', type: 'select', options: [{ id: 'o_a', label: 'Actif' }, { id: 'o_p', label: 'Perdu' }] },
};

function def(over: Partial<ExtSourceDef> = {}): ExtSourceDef {
  return {
    v: 1,
    id: 'xs_AAAAAAAAAAAAAAAAAAAAAA',
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

function plan(over: Partial<PlanInput> & { rows?: Array<Record<string, unknown>>; fil?: FilarrRow[] } = {}): ReturnType<typeof planPass> {
  const d = over.def ?? def();
  return planPass({
    def: d,
    identity: sourceIdentity(d, sha256),
    props: PROPS,
    shadow: null,
    queue: [],
    decisions: [],
    source: { rows: (over.rows ?? []).map((raw) => ({ raw })), full: true },
    filarr: over.fil ?? [],
    now: '2026-10-10T12:00:00.000Z',
    passId: 'pass1',
    ack: null,
    sha256,
    ...over,
  });
}

/** Un passage complet simulé : le plan, puis les horloges des écritures dans Filarr. */
function runPass(input: Parameters<typeof plan>[0], tick: () => string) {
  const p = plan(input);
  const ticks = p.toFilarr.map(() => tick());
  return { plan: p, shadow: applyClocks(p, ticks), ticks };
}

describe('planPass (§ 6.4, § 6.5, § 6.9)', () => {
  const rows3 = [
    { id: 1, nom: 'Acme', statut: 'Actif' },
    { id: 2, nom: 'Globex', statut: 'Actif' },
    { id: 3, nom: 'Initech', statut: 'Perdu' },
  ];

  it('premier passage : les lignes de la source sont créées à leur identifiant calculé', () => {
    const p = plan({ rows: rows3 });
    const identity = sourceIdentity(def(), sha256);
    expect(p.created).toEqual(['1', '2', '3'].map((k) => extRowId(sha256, identity, k)));
    expect(p.toFilarr.filter((o) => o.f === 'p_statut').map((o) => o.v)).toEqual(['o_a', 'o_a', 'o_p']);
    expect(p.counts.in.created).toBe(3);
    expect(Object.keys(p.shadow.rows)).toEqual(['1', '2', '3']);
  });

  it('I1, convergence : rien ne change d’aucun côté → le passage suivant n’écrit rien', () => {
    let t = 10_000;
    const tick = () => hlc((t += 1));
    const first = runPass({ rows: rows3 }, tick);
    const fil: FilarrRow[] = first.plan.created.map((id) => ({ id, deleted: false, regs: {} }));
    first.plan.toFilarr.forEach((op, i) => (fil.find((r) => r.id === op.r)!.regs[op.f] = { v: op.v, t: first.ticks[i]! }));
    const second = plan({ rows: rows3, fil, shadow: first.shadow });
    expect(second.toFilarr).toEqual([]);
    expect(second.toSource).toEqual([]);
    expect(second.created).toEqual([]);
  });

  it('I2, idempotence : une panne entre l’écriture à la source et la validation dans Filarr se rejoue sans double écriture', () => {
    let t = 10_000;
    const tick = () => hlc((t += 1));
    const first = runPass({ rows: rows3 }, tick);
    const fil: FilarrRow[] = first.plan.created.map((id) => ({ id, deleted: false, regs: {} }));
    first.plan.toFilarr.forEach((op, i) => (fil.find((r) => r.id === op.r)!.regs[op.f] = { v: op.v, t: first.ticks[i]! }));
    // Filarr change Acme ; le passage écrit la source… puis tombe avant d'enregistrer l'ombre
    const acme = fil.find((r) => r.regs.p_id?.v === 1)!;
    acme.regs.p_nom = { v: 'Acme Corp', t: tick() };
    const p2 = plan({ rows: rows3, fil, shadow: first.shadow });
    expect(p2.toSource).toMatchObject([{ kind: 'update', col: 'nom', value: 'Acme Corp', old: 'Acme' }]);
    // Rejoué avec l'ombre d'AVANT, la source porte déjà la valeur : cas D, rien n'est écrit
    const rows3b = rows3.map((r) => (r.id === 1 ? { ...r, nom: 'Acme Corp' } : r));
    const replay = plan({ rows: rows3b, fil, shadow: first.shadow });
    expect(replay.toSource).toEqual([]);
    expect(replay.toFilarr).toEqual([]);
  });

  it('ligne disparue de la source : onGone mark, delete, keep ; réapparition : marque levée', () => {
    let t = 10_000;
    const tick = () => hlc((t += 1));
    const first = runPass({ rows: rows3 }, tick);
    const fil: FilarrRow[] = first.plan.created.map((id) => ({ id, deleted: false, regs: {} }));
    first.plan.toFilarr.forEach((op, i) => (fil.find((r) => r.id === op.r)!.regs[op.f] = { v: op.v, t: first.ticks[i]! }));
    const two = rows3.filter((r) => r.id !== 3);
    const mark = plan({ rows: two, fil, shadow: first.shadow, def: def({ guard: { pct: 100, min: 10 } }) });
    expect(mark.toFilarr).toEqual([{ r: fil[2]!.id, f: '#x.extGone', v: { at: '2026-10-10T12:00:00.000Z', src: 'xs_AAAAAAAAAAAAAAAAAAAAAA' } }]);
    expect(mark.shadow.rows['3']!.g).toBe(1);
    expect(plan({ rows: two, fil, shadow: first.shadow, def: def({ onGone: 'delete' }) }).toFilarr).toEqual([{ r: fil[2]!.id, f: '#d', v: true }]);
    expect(plan({ rows: two, fil, shadow: first.shadow, def: def({ onGone: 'keep' }) }).toFilarr).toEqual([]);
    const back = plan({ rows: rows3, fil, shadow: mark.shadow });
    expect(back.toFilarr[0]).toEqual({ r: fil[2]!.id, f: '#x.extGone', v: null });
  });

  it('ligne supprimée dans Filarr : onFilarrDelete delete (DELETE à la source) ou ignore ; miroir : restaurée', () => {
    let t = 10_000;
    const tick = () => hlc((t += 1));
    const first = runPass({ rows: rows3 }, tick);
    const fil: FilarrRow[] = first.plan.created.map((id) => ({ id, deleted: false, regs: {} }));
    first.plan.toFilarr.forEach((op, i) => (fil.find((r) => r.id === op.r)!.regs[op.f] = { v: op.v, t: first.ticks[i]! }));
    fil[1]!.deleted = true;
    const del = plan({ rows: rows3, fil, shadow: first.shadow });
    expect(del.toSource).toMatchObject([{ kind: 'delete', key: '2' }]);
    expect(del.shadow.rows['2']!.d).toBe(1);
    expect(plan({ rows: rows3, fil, shadow: first.shadow, def: def({ onFilarrDelete: 'ignore' }) }).toSource).toEqual([]);
    const mirror = plan({ rows: rows3, fil, shadow: first.shadow, def: def({ mode: 'mirror', map: def().map.map((m) => ({ ...m, dir: 'in' as const })) }) });
    expect(mirror.toFilarr[0]).toEqual({ r: fil[1]!.id, f: '#d', v: false });
  });

  it('suppression contre modification (rowConflict) : delete, keep, ask', () => {
    let t = 10_000;
    const tick = () => hlc((t += 1));
    const first = runPass({ rows: rows3 }, tick);
    const fil: FilarrRow[] = first.plan.created.map((id) => ({ id, deleted: false, regs: {} }));
    first.plan.toFilarr.forEach((op, i) => (fil.find((r) => r.id === op.r)!.regs[op.f] = { v: op.v, t: first.ticks[i]! }));
    fil[0]!.deleted = true;
    const changed = rows3.map((r) => (r.id === 1 ? { ...r, nom: 'Acme Corp' } : r));
    expect(plan({ rows: changed, fil, shadow: first.shadow }).toSource).toMatchObject([{ kind: 'delete', key: '1' }]);
    const keep = plan({ rows: changed, fil, shadow: first.shadow, def: def({ rowConflict: 'keep' }) });
    expect(keep.toFilarr[0]).toEqual({ r: fil[0]!.id, f: '#d', v: false });
    expect(keep.toFilarr.some((o) => o.f === 'p_nom' && o.v === 'Acme Corp')).toBe(true);
    const ask = plan({ rows: changed, fil, shadow: first.shadow, def: def({ rowConflict: 'ask' }) });
    expect(ask.queue).toMatchObject([{ kind: 'row_deleted_in_filarr', col: '#row', key: '1' }]);
    expect(ask.toSource).toEqual([]);
  });

  it('garde-fou : au seuil exact on passe, un au-dessus on s’arrête AVANT toute écriture ; l’accord vaut pour ce passage', () => {
    let t = 10_000;
    const tick = () => hlc((t += 1));
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, nom: `C${i + 1}`, statut: 'Actif' }));
    const g = def({ guard: { pct: 20, min: 2 } }); // seuil : max(ceil(20 % × 20), 2) = 4
    const first = runPass({ rows, def: g }, tick);
    const fil: FilarrRow[] = first.plan.created.map((id) => ({ id, deleted: false, regs: {} }));
    first.plan.toFilarr.forEach((op, i) => (fil.find((r) => r.id === op.r)!.regs[op.f] = { v: op.v, t: first.ticks[i]! }));
    const atLimit = plan({ rows: rows.slice(4), fil, shadow: first.shadow, def: g });
    expect(atLimit.stop).toBeNull();
    expect(atLimit.toFilarr.filter((o) => o.f === '#x.extGone')).toHaveLength(4);
    const over = plan({ rows: rows.slice(5), fil, shadow: first.shadow, def: g });
    expect(over.stop).toMatchObject({ code: 'extdb_guard', question: { kind: 'guard', gone: 5, total: 20 } });
    expect(over.toFilarr).toEqual([]);
    expect(over.toSource).toEqual([]);
    const acked = plan({ rows: rows.slice(5), fil, shadow: first.shadow, def: g, ack: { guard: String(over.stop!.question.pass) } });
    expect(acked.stop).toBeNull();
    // Table vidée : arrêt
    expect(plan({ rows: [], fil, shadow: first.shadow, def: g }).stop?.code).toBe('extdb_guard');
  });

  it('rafale de conflits au premier passage : arrêt, puis « trancher ce premier passage avec la source »', () => {
    const n = 60;
    const rows = Array.from({ length: n }, (_, i) => ({ id: i + 1, nom: `S${i}`, statut: 'Actif' }));
    const identity = sourceIdentity(def(), sha256);
    const fil: FilarrRow[] = rows.map((r, i) => ({ id: extRowId(sha256, identity, String(r.id)), deleted: false, regs: { p_id: { v: r.id, t: hlc(1, i) }, p_nom: { v: `F${i}`, t: hlc(2, i) }, p_statut: { v: 'o_a', t: hlc(2, i) } } }));
    const d = def({ conflict: 'ask' });
    const burst = plan({ rows, fil, def: d });
    expect(burst.stop?.code).toBe('extdb_conflict_burst');
    const initial = plan({ rows, fil, def: d, ack: { initial: 'source' } });
    expect(initial.stop).toBeNull();
    expect(initial.toFilarr.filter((o) => o.f === 'p_nom')).toHaveLength(n);
  });

  it('file pleine : la 501e cellule n’entre pas, n’est écrite d’aucun côté, overflow la compte', () => {
    const n = 501;
    const rows = Array.from({ length: n }, (_, i) => ({ id: i + 1, nom: `S${i}`, statut: 'Actif' }));
    const identity = sourceIdentity(def(), sha256);
    const shadowRows: Record<string, { id: string; cells: Record<string, { h: string; t: string }> }> = {};
    const fil: FilarrRow[] = rows.map((r, i) => {
      const id = extRowId(sha256, identity, String(r.id));
      shadowRows[String(r.id)] = { id, cells: { id: { h: H(r.id), t: hlc(1, i) }, nom: { h: H('old'), t: hlc(1, i) }, statut: { h: H('o_a'), t: hlc(1, i) } } };
      return { id, deleted: false, regs: { p_id: { v: r.id, t: hlc(1, i) }, p_nom: { v: `F${i}`, t: hlc(3, i) }, p_statut: { v: 'o_a', t: hlc(1, i) } } };
    });
    const p = plan({
      rows,
      fil,
      def: def({ conflict: 'ask', guard: { pct: 100, min: 10_000 } }),
      shadow: { v: 1, def: 'xs_AAAAAAAAAAAAAAAAAAAAAA', defRev: 1, marker: null, fullAt: null, passes: 0, rows: shadowRows, echo: {}, unstable: {} },
      ack: { initial: 'source' },
    });
    // Ombre présente : l'accord initial ne vaut pas ; la rafale non plus (garde à 50 % pour l'essai)
    expect(p.stop?.code ?? null).toBe('extdb_conflict_burst');
    const unguarded = planPass({
      def: def({ conflict: 'ask' }),
      identity,
      props: PROPS,
      shadow: { v: 1, def: 'xs_AAAAAAAAAAAAAAAAAAAAAA', defRev: 1, marker: null, fullAt: null, passes: 0, rows: shadowRows, echo: {}, unstable: {} },
      queue: Array.from({ length: 500 }, (_, i) => ({ id: `old${i}`, row: `x${i}`, key: `zz${i}`, col: 'nom', prop: 'p_nom', source: { v: 1, h: 'h', at: null }, filarr: { v: 2, h: 'h2', t: null }, kind: 'cell' as const, since: '', truncated: false })),
      decisions: [],
      source: { rows: rows.slice(0, 1).map((raw) => ({ raw })), full: false },
      filarr: fil,
      now: '2026-10-10T12:00:00.000Z',
      passId: 'p',
      ack: null,
      sha256,
    });
    expect(unguarded.overflow).toBe(1);
    expect(unguarded.queue).toHaveLength(500);
    expect(unguarded.toFilarr).toEqual([]);
    expect(unguarded.toSource).toEqual([]);
    expect(unguarded.journal.some((j) => j.kind === 'queue_full')).toBe(true);
  });

  it('deux décisions pour la même entrée : la première s’applique, la seconde est resolution_duplicate', () => {
    let t = 10_000;
    const tick = () => hlc((t += 1));
    const d = def({ conflict: 'ask' });
    const first = runPass({ rows: rows3, def: d }, tick);
    const fil: FilarrRow[] = first.plan.created.map((id) => ({ id, deleted: false, regs: {} }));
    first.plan.toFilarr.forEach((op, i) => (fil.find((r) => r.id === op.r)!.regs[op.f] = { v: op.v, t: first.ticks[i]! }));
    fil[0]!.regs.p_nom = { v: 'Acme F', t: tick() };
    const changed = rows3.map((r) => (r.id === 1 ? { ...r, nom: 'Acme S' } : r));
    const queued = plan({ rows: changed, fil, shadow: first.shadow, def: d });
    expect(queued.queue).toHaveLength(1);
    const entry = queued.queue[0]!;
    const decisions: Decision[] = [
      { id: entry.id, choice: 'source', by: { userId: 'u_a' }, at: '', seq: 1 },
      { id: entry.id, choice: 'filarr', by: { userId: 'u_b' }, at: '', seq: 2 },
    ];
    const resolved = plan({ rows: changed, fil, shadow: queued.shadow, def: d, queue: queued.queue, decisions });
    expect(resolved.toFilarr).toEqual([{ r: fil[0]!.id, f: 'p_nom', v: 'Acme S' }]);
    expect(resolved.queue).toEqual([]);
    expect(resolved.journal.filter((j) => j.kind === 'resolution_duplicate')).toHaveLength(1);
    expect(resolved.handledDecisions).toEqual([1, 2]);
    // Rejouée après une panne avant l'acquittement : aucun effet (le registre écrit porte l'horloge de l'ombre)
    const written = tick();
    const replay = plan({ rows: changed, fil: fil.map((r) => (r.id === fil[0]!.id ? { ...r, regs: { ...r.regs, p_nom: { v: 'Acme S', t: written } } } : r)), shadow: applyClocks(resolved, [written]), def: d, queue: [], decisions });
    expect(replay.toFilarr).toEqual([]);
    expect(replay.toSource).toEqual([]);
  });

  it('écriture refusée par la source (0 ligne) : l’ombre ne bouge pas ; écho : la valeur relue revient dans Filarr, instable au deuxième', () => {
    let t = 10_000;
    const tick = () => hlc((t += 1));
    const first = runPass({ rows: rows3 }, tick);
    const fil: FilarrRow[] = first.plan.created.map((id) => ({ id, deleted: false, regs: {} }));
    first.plan.toFilarr.forEach((op, i) => (fil.find((r) => r.id === op.r)!.regs[op.f] = { v: op.v, t: first.ticks[i]! }));
    fil[0]!.regs.p_nom = { v: 'acme  ', t: tick() };
    const p = plan({ rows: rows3, fil, shadow: first.shadow });
    expect(p.toSource).toHaveLength(1);
    const failed = applySourceResults(p, [{ key: '1', col: 'nom' }]);
    expect(failed.shadow.rows['1']!.cells.nom).toEqual(first.shadow.rows['1']!.cells.nom);
    const echoed = applyEcho(p, [{ key: '1', col: 'nom', rowId: fil[0]!.id, prop: 'p_nom', value: 'acme' }], sha256);
    expect(echoed.toFilarr.at(-1)).toEqual({ r: fil[0]!.id, f: 'p_nom', v: 'acme' });
    expect(echoed.journal.some((j) => j.kind === 'normalized')).toBe(true);
    const again = applyEcho(echoed, [{ key: '1', col: 'nom', rowId: fil[0]!.id, prop: 'p_nom', value: 'acme' }], sha256);
    expect(again.shadow.unstable.nom).toBe(true);
  });

  it('clé en double et ligne sans clé : laissées de côté, au journal', () => {
    const p = plan({ rows: [{ id: 1, nom: 'A' }, { id: 1, nom: 'B' }, { id: null, nom: 'C' }] });
    expect(p.created).toEqual([]);
    expect(p.journal.map((j) => j.code)).toEqual(expect.arrayContaining(['duplicate_key', 'row_without_key']));
  });

  it('publish : onSourceOnly keep n’importe rien, import importe ; ligne neuve dans Filarr insérée dans la source', () => {
    const d = def({ mode: 'publish', map: def().map.map((m) => ({ ...m, dir: m.col === 'id' ? ('in' as const) : ('out' as const) })) });
    expect(plan({ rows: rows3, def: d }).created).toEqual([]);
    expect(plan({ rows: rows3, def: { ...d, onSourceOnly: 'import' } }).created).toHaveLength(3);
    const p = plan({ rows: [], def: d, fil: [{ id: 'db-neuve', deleted: false, regs: { p_nom: { v: 'Hooli', t: hlc(5) } } }] });
    expect(p.toSource).toMatchObject([{ kind: 'insert', rowId: 'db-neuve', values: { nom: 'Hooli' } }]);
  });
});

describe('identité et conversions (§ 3, § 4)', () => {
  it('sourceIdentity pour chaque connecteur, et une source query', () => {
    expect(sourceIdentity(def(), sha256)).toBe('d1|api.cloudflare.com|acc/db1|clients');
    expect(sourceIdentity({ connector: 'postgres', conn: { host: 'DB.lan', db: 'erp', user: 'x' }, from: { table: 'cmd' } }, sha256)).toBe('postgres|db.lan:5432|erp|public.cmd');
    expect(sourceIdentity({ connector: 'notion', conn: { database: 'abc' }, from: { table: '' } }, sha256)).toBe('notion|api.notion.com|abc');
    expect(sourceIdentity({ connector: 'd1', conn: { account: 'a', database: 'b' }, from: { query: '  SELECT 1  ' } }, sha256)).toMatch(/^d1\|api\.cloudflare\.com\|a\/b\|q:[0-9a-f]{64}$/);
  });

  it('clés canoniques : entiers, bigint, texte exact, UUID en minuscules, plusieurs colonnes, vide refusé', () => {
    expect(canonicalKey([42])).toBe('42');
    expect(canonicalKey([12345678901234567890n])).toBe('12345678901234567890');
    expect(canonicalKey([' Élise '])).toBe(' Élise ');
    expect(canonicalKey(['A1B2C3D4-0000-4000-8000-ABCDEFABCDEF'])).toBe('a1b2c3d4-0000-4000-8000-abcdefabcdef');
    expect(canonicalKey(['FR', 7])).toBe('FR\u001f7');
    expect(canonicalKey([''])).toBeNull();
    expect(canonicalKey([null])).toBeNull();
    expect(() => canonicalKey([1.5])).toThrow('key_bad_type');
  });

  it('conversions et allers-retours', () => {
    const opts = { createOptions: true, minted: [] as never[], sha256 };
    expect(toFilarr('', PROPS.p_nom!, opts)).toBeNull();
    expect(toFilarr('12,5', { id: 'n', type: 'number' }, opts)).toBe(12.5);
    expect(toFilarr(9007199254740993n, { id: 'n', type: 'number' }, opts)).toBeNull();
    expect(toFilarr(null, { id: 'c', type: 'checkbox' }, opts)).toBe(false);
    expect(isoUtc('2026-10-10T14:00:00+02:00')).toBe('2026-10-10T12:00:00Z');
    expect(isoUtc('2026-10-10T12:00:00.250Z')).toBe('2026-10-10T12:00:00.250Z');
    expect(toFilarr('Actif', PROPS.p_statut!, opts)).toBe('o_a');
    const minted = toFilarr('Nouveau', PROPS.p_statut!, opts);
    expect(minted).toMatch(/^ext-opt-/);
    expect(toFilarr(['b', 'a'], { id: 'm', type: 'multiSelect', options: [{ id: 'z', label: 'a' }, { id: 'y', label: 'b' }] }, opts)).toEqual(['y', 'z']);
    expect(toFilarr({ b: 1, a: [2] }, PROPS.p_nom!, opts)).toBe('{"a":[2],"b":1}');
    for (const v of ['texte', null]) expect(toFilarr(toSource(v, PROPS.p_nom!), PROPS.p_nom!, opts)).toBe(v);
    expect(toFilarr(toSource('o_p', PROPS.p_statut!), PROPS.p_statut!, opts)).toBe('o_p');
    expect(toSource(null, { id: 'c', type: 'checkbox' })).toBe(false);
  });
});

describe('définitions (§ 2.2, § 8.3)', () => {
  it('une définition juste ne rend aucun code', () => {
    expect(validateDef(def())).toEqual([]);
  });

  it.each([
    [{ v: 2 }, 'bad_version'],
    [{ id: 'xs_court' }, 'bad_id'],
    [{ name: '' }, 'bad_name'],
    [{ connector: 'oracle' }, 'bad_connector'],
    [{ conn: { account: 'a' } }, 'bad_conn'],
    [{ host: 'evil.example' }, 'host_mismatch'],
    [{ connector: 'url', conn: { url: 'https://10.0.0.1/x.csv', format: { kind: 'csv' } }, host: '10.0.0.1', mode: 'mirror' }, 'host_forbidden'],
    [{ connector: 'postgres', conn: { host: 'db.example.com', db: 'erp', user: 'u', tls: 'off-local' }, host: 'db.example.com:5432' }, 'tls_off_not_local'],
    [{ from: { query: 'DELETE FROM t' }, mode: 'mirror' }, 'query_not_select'],
    [{ from: { query: 'SELECT 1' } }, 'query_with_write_mode'],
    [{ key: { cols: [], gen: 'source' } }, 'key_missing'],
    [{ key: { cols: ['a', 'b', 'c', 'd'], gen: 'source' } }, 'key_too_many'],
    [{ key: { cols: ['absente'], gen: 'source' } }, 'key_not_mapped'],
    [{ marker: { col: 'maj', kind: 'semaine' } }, 'marker_bad_kind'],
    [{ conflict: 'latest' }, 'latest_without_time_marker'],
    [{ map: [] }, 'map_empty'],
    [{ map: [...def().map, { col: 'autre', prop: 'p_nom', dir: 'both', type: 'text' }] }, 'map_duplicate_prop'],
    [{ map: [...def().map, { col: 'nom', prop: 'p_x', dir: 'both', type: 'text' }] }, 'map_duplicate_col'],
    [{ mode: 'mirror' }, 'dir_forbidden_for_mode'],
    [{ map: [...def().map, { col: 'z', prop: 'p_z', dir: 'both', type: 'hologramme' }] }, 'type_unmappable'],
    [{ map: [...def().map, { col: 'z', prop: 'p_z', dir: 'in', type: 'formula' }] }, 'computed_prop_inbound'],
    [{ connector: 'postgres', conn: { host: 'db.lan', db: 'erp', user: 'u' }, host: 'db.lan:5432', runner: { kind: 'hosted', accessId: 'a' } }, 'runner_unsupported'],
    [{ schedule: { every: '5m' } }, 'schedule_too_fast'],
    [{ conflict: undefined }, 'conflict_policy_missing'],
    [{ rowConflict: undefined }, 'row_conflict_missing'],
    [{ conflict: 'random' }, 'bad_policy'],
    [{ map: def().map.map((m) => (m.col === 'nom' ? { ...m, askPending: 'peut-être' } : m)) }, 'ask_pending_bad'],
    [{ name: 'x'.repeat(60), ignored: Array.from({ length: 2000 }, (_, i) => `colonne_${i}`) }, 'too_large'],
  ] as Array<[Partial<ExtSourceDef>, string]>)('%j → %s', (over, code) => {
    expect(validateDef({ ...def(), ...over })).toContain(code);
  });

  it('signée par le bon compte : vérifiée ; une autre clé, ou un champ changé : refusée', () => {
    const key = new Uint8Array(32).fill(7);
    const other = new Uint8Array(32).fill(9);
    const signed = signDef(curves, def(), key);
    const pub = toBase64Std(curves.ed25519PublicKey(key));
    expect(verifyDefSignature(curves, signed, pub)).toBe(true);
    expect(verifyDefSignature(curves, signed, toBase64Std(curves.ed25519PublicKey(other)))).toBe(false);
    expect(verifyDefSignature(curves, { ...signed, from: { query: 'SELECT * FROM utilisateurs' } }, pub)).toBe(false);
  });
});

describe('scellés (§ 6.1, § 9.2)', () => {
  it('état sous K_xs avec son AAD ; ombre sous K_shadow ; une autre AAD ne s’ouvre pas', async () => {
    const kDb = new Uint8Array(32).fill(3);
    const kxs = await statusKey(storeCrypto, kDb, 'store_AAAAAAAAAAAAAAAAAA');
    const sealed = await sealJson(storeCrypto, kxs, { state: 'ok' }, statusAad('s', 'a:x', 4));
    expect(await openJson(storeCrypto, kxs, sealed, statusAad('s', 'a:x', 4))).toEqual({ state: 'ok' });
    await expect(openJson(storeCrypto, kxs, sealed, statusAad('s', 'a:x', 5))).rejects.toThrow();
    const ks = await shadowKey(storeCrypto, kDb, 's', 'xs_1');
    expect(ks).not.toEqual(kxs);
  });
});
