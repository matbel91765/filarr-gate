// Écrit dans filarr-gate (origine) — cœur pur, à recopier tel quel par filarg (lot B2).
/**
 * La planification d'un passage (`planPass`) — contrat `source-externe-1` § 5,
 * § 6.4 à § 6.12. Fonction PURE de ses entrées (définition, ombre, file,
 * décisions, lignes lues des deux côtés, heure) : deux exécutants qui ont les
 * mêmes entrées font le même plan (I4).
 *
 * Le plan dit quoi écrire dans Filarr et dans la source, l'ombre et la file
 * suivantes, le journal, et l'éventuel ARRÊT d'un garde-fou (avant toute
 * écriture, des deux côtés, § 6.9). L'exécutant applique ensuite :
 *  1. les écritures dans la source, sous condition de la valeur lue
 *     (`applySourceResults` retire de l'ombre celles qui n'ont pas pris) ;
 *  2. l'écho d'une valeur normalisée par la source (`applyEcho`) ;
 *  3. une validation dans Filarr, puis les horloges des registres écrits
 *     (`applyClocks`).
 */

import { canonicalJson } from '../store/canonical';
import { toFilarr, toSource, type OptionMint, type PropSpec } from './convert';
import { canonicalKey, extRowId, KeyTypeError, queueEntryId, valueHash, type Sha256 } from './identity';
import { mergeCell } from './merge';
import { policyOf } from './def';
import {
  QUEUE_MAX,
  VALUE_TRUNCATE_BYTES,
  type Decision,
  type ExtSourceDef,
  type MapEntry,
  type QueueEntry,
  type Shadow,
  type ShadowCell,
  type ShadowRow,
  type SyncJournalEntry,
} from './types';

export const FIELD_EXT_GONE = '#x.extGone';
export const FIELD_DELETED = '#d';

/** Une ligne lue dans la source : ses valeurs brutes, par colonne. */
export interface SourceRow {
  raw: Record<string, unknown>;
}

/** Une ligne de Filarr : ses registres (`propId` → valeur et horloge), supprimée ou non. */
export interface FilarrRow {
  id: string;
  deleted: boolean;
  regs: Record<string, { v: unknown; t: string }>;
}

export interface PlanInput {
  def: ExtSourceDef;
  /** `sourceIdentity(def)`. */
  identity: string;
  /** Les propriétés de la base (`propId` → type et options). */
  props: Record<string, PropSpec>;
  shadow: Shadow | null;
  queue: readonly QueueEntry[];
  /** Les décisions de la boîte aux lettres, dans l'ordre du serveur. */
  decisions: readonly Decision[];
  source: { rows: readonly SourceRow[]; full: boolean };
  filarr: readonly FilarrRow[];
  now: string;
  passId: string;
  ack: { initial?: 'source' | 'filarr'; guard?: string } | null;
  sha256: Sha256;
  /** Créer les options inconnues (vrai d'office en `mirror` et `both`). */
  createOptions?: boolean;
}

/** Une écriture dans Filarr : un registre (`f` : `propId`, `#d`, `#x.extGone`). */
export interface FilarrOp {
  r: string;
  f: string;
  v: unknown;
}

export type SourceOp =
  | { kind: 'update'; key: string; keyValues: Record<string, unknown>; col: string; value: unknown; old: unknown; rowId: string; prop: string }
  | { kind: 'insert'; rowId: string; values: Record<string, unknown> }
  | { kind: 'delete'; key: string; keyValues: Record<string, unknown>; rowId: string };

export interface PlanCounts {
  rows: number;
  in: { changed: number; created: number; gone: number };
  out: { changed: number; inserted: number; deleted: number };
  conflicts: number;
}

export interface PassPlan {
  stop: null | { code: 'extdb_guard' | 'extdb_conflict_burst'; question: Record<string, unknown> };
  toFilarr: FilarrOp[];
  /** Lignes CRÉÉES dans Filarr (l'exécutant pose `#c` et la position). */
  created: string[];
  toSource: SourceOp[];
  minted: OptionMint[];
  shadow: Shadow;
  queue: QueueEntry[];
  /** Conflits nouveaux qui attendent une place dans la file pleine. */
  overflow: number;
  journal: SyncJournalEntry[];
  counts: PlanCounts;
  /** Les décisions traitées (appliquées, périmées ou en double) : à acquitter. */
  handledDecisions: number[];
  /** Cellules écrites dans Filarr dont l'ombre attend l'horloge du registre (`clé|col` → index dans `toFilarr`). */
  pendingClocks: Record<string, number>;
  /** L'ombre d'avant de chaque cellule écrite dans la source (`clé|col`), pour revenir si l'écriture n'a pas pris. */
  sourceUndo: Record<string, ShadowCell | null>;
}

const emptyShadow = (def: ExtSourceDef): Shadow => ({ v: 1, def: def.id, defRev: def.rev, marker: null, fullAt: null, passes: 0, rows: {}, echo: {}, unstable: {} });

function cloneShadow(s: Shadow): Shadow {
  return JSON.parse(JSON.stringify(s)) as Shadow;
}

/** Le repère d'une ligne en millisecondes (temps) ou tel quel (entier). */
export function markerValue(def: ExtSourceDef, raw: Record<string, unknown>): number | null {
  if (!def.marker) return null;
  const v = raw[def.marker.col];
  if (v === null || v === undefined || v === '') return null;
  switch (def.marker.kind) {
    case 'iso': {
      const ms = v instanceof Date ? v.getTime() : Date.parse(String(v).replace(' ', 'T'));
      return Number.isFinite(ms) ? ms : null;
    }
    case 'epoch_ms':
      return Number(v);
    case 'epoch_s':
      return Number(v) * 1000;
    case 'int':
      return Number(v);
    default:
      return null;
  }
}

const timeMarker = (def: ExtSourceDef): boolean => !!def.marker && def.marker.kind !== 'int';

function truncate(v: unknown): { v: unknown; truncated: boolean } {
  const text = canonicalJson(v);
  if (text.length <= VALUE_TRUNCATE_BYTES) return { v, truncated: false };
  return { v: typeof v === 'string' ? v.slice(0, VALUE_TRUNCATE_BYTES) : text.slice(0, VALUE_TRUNCATE_BYTES), truncated: true };
}

export function planPass(input: PlanInput): PassPlan {
  const { def, sha256, now } = input;
  const H = (v: unknown): string => valueHash(sha256, v);
  const shadow = input.shadow ? cloneShadow(input.shadow) : emptyShadow(def);
  const hadShadow = input.shadow !== null && Object.keys(input.shadow.rows).length > 0;
  const journal: SyncJournalEntry[] = [];
  const log = (e: Omit<SyncJournalEntry, 'at' | 'pass'>) => journal.push({ at: now, pass: input.passId, ...e });
  const filOps: FilarrOp[] = [];
  const toSourceOps: SourceOp[] = [];
  const created: string[] = [];
  const minted: OptionMint[] = [];
  const pendingClocks: Record<string, number> = {};
  const sourceUndo: Record<string, ShadowCell | null> = {};
  const counts: PlanCounts = { rows: 0, in: { changed: 0, created: 0, gone: 0 }, out: { changed: 0, inserted: 0, deleted: 0 }, conflicts: 0 };
  const convertOpts = { createOptions: input.createOptions ?? (def.mode === 'mirror' || def.mode === 'both'), minted, sha256 };
  const mapped = def.map.filter((m) => input.props[m.prop] !== undefined);
  const keyCols = def.key.cols;
  const keyProps = keyCols.map((c) => def.map.find((m) => m.col === c)?.prop ?? '');
  let disappearances = 0;
  let newConflicts = 0;

  // ---------- La source, par clé ----------
  const src = new Map<string, { row: SourceRow; keyValues: Record<string, unknown>; vS: Record<string, unknown>; hS: Record<string, string>; tS: number | null }>();
  const dupSrc = new Set<string>();
  let markerMax: number | null = typeof shadow.marker === 'number' ? shadow.marker : null;
  for (const row of input.source.rows) {
    let key: string | null;
    try {
      key = canonicalKey(keyCols.map((c) => row.raw[c]));
    } catch (err) {
      if (err instanceof KeyTypeError) {
        log({ kind: 'error', code: 'key_bad_type' });
        continue;
      }
      throw err;
    }
    if (key === null) {
      log({ kind: 'error', code: 'row_without_key' });
      continue;
    }
    if (src.has(key)) {
      dupSrc.add(key);
      continue;
    }
    const vS: Record<string, unknown> = {};
    const hS: Record<string, string> = {};
    for (const m of mapped) {
      const v = toFilarr(row.raw[m.col], input.props[m.prop]!, convertOpts);
      vS[m.col] = v;
      hS[m.col] = H(v);
    }
    const tS = markerValue(def, row.raw);
    if (tS !== null && (markerMax === null || tS > markerMax)) markerMax = tS;
    src.set(key, { row, keyValues: Object.fromEntries(keyCols.map((c) => [c, row.raw[c]])), vS, hS, tS: timeMarker(def) ? tS : null });
  }
  for (const k of dupSrc) {
    src.delete(k);
    log({ kind: 'error', code: 'duplicate_key', row: k });
  }

  // ---------- Filarr, par clé ----------
  const filByKey = new Map<string, FilarrRow>();
  const filById = new Map<string, FilarrRow>();
  const noKey: FilarrRow[] = [];
  const dupFil = new Set<string>();
  for (const r of input.filarr) {
    filById.set(r.id, r);
    let key: string | null = null;
    try {
      key = canonicalKey(keyProps.map((p) => {
        const v = r.regs[p]?.v;
        return Array.isArray(v) ? v[0] : v;
      }));
    } catch {
      key = null;
    }
    if (key === null) {
      if (!r.deleted) noKey.push(r);
      continue;
    }
    const prev = filByKey.get(key);
    if (prev && !prev.deleted && !r.deleted) {
      dupFil.add(key);
      continue;
    }
    if (!prev || prev.deleted) filByKey.set(key, r);
  }
  for (const k of dupFil) {
    filByKey.delete(k);
    log({ kind: 'error', code: 'duplicate_key', row: k });
  }
  // Une ligne de l'ombre se retrouve aussi par son identifiant (clé effacée par un vieux client)
  for (const [key, o] of Object.entries(shadow.rows)) {
    if (!filByKey.has(key) && !dupFil.has(key)) {
      const r = filById.get(o.id);
      if (r) filByKey.set(key, r);
    }
  }

  // ---------- Les décisions : la première par entrée, dans l'ordre du serveur ----------
  const queueById = new Map(input.queue.map((q) => [q.id, q]));
  const firstDecision = new Map<string, Decision>();
  const handled: number[] = [];
  for (const d of input.decisions) {
    handled.push(d.seq);
    const seen = firstDecision.get(d.id);
    if (seen) {
      log({ kind: 'resolution_duplicate', by: seen.by, code: d.id });
      continue;
    }
    if (!queueById.has(d.id)) {
      // Plus dans la file : déjà tranchée ailleurs, ou résolue d'elle-même
      log({ kind: 'resolution_duplicate', by: d.by, code: d.id });
      continue;
    }
    firstDecision.set(d.id, d);
  }

  // ---------- La file suivante ----------
  const nextQueue = new Map<string, QueueEntry>();
  const queueByCell = new Map<string, QueueEntry>();
  for (const q of input.queue) queueByCell.set(`${q.key}|${q.col}`, q);
  let overflow = 0;
  // Les entrées que ce passage ne touche pas restent ; elles comptent pour la place
  const touched = new Set<string>();
  const countUntouched = (): number => input.queue.filter((q) => !touched.has(q.id) && !nextQueue.has(q.id)).length;
  /** Une entrée de file : elle remplace l'ancienne de la même cellule, ou prend une place libre (500 au plus). */
  const putQueue = (e: QueueEntry, replaces: QueueEntry | null): boolean => {
    if (replaces) nextQueue.delete(replaces.id);
    if (!replaces && nextQueue.size + countUntouched() >= QUEUE_MAX) {
      overflow += 1;
      return false;
    }
    nextQueue.set(e.id, e);
    return true;
  };

  const cellEntry = (key: string, rowId: string, m: MapEntry, vS: unknown, hS: string, F: { v: unknown; t: string | null }, hF: string, tS: number | null): QueueEntry => {
    const s = truncate(vS);
    const f = truncate(F.v);
    return {
      id: queueEntryId(sha256, def.id, key, m.col, hS, hF),
      row: rowId,
      key,
      col: m.col,
      prop: m.prop,
      source: { v: s.v, h: hS, at: tS !== null ? new Date(tS).toISOString() : null },
      filarr: { v: f.v, h: hF, t: F.t },
      kind: 'cell',
      since: now,
      truncated: s.truncated || f.truncated,
    };
  };

  // ---------- Les cellules d'une ligne présente des deux côtés ----------
  const mergeRow = (key: string, s: NonNullable<ReturnType<typeof src.get>>, f: FilarrRow, o: ShadowRow | undefined): void => {
    const orow: ShadowRow = o ?? { id: f.id, cells: {} };
    if (!o) shadow.rows[key] = orow;
    for (const m of mapped) {
      if (keyCols.includes(m.col)) {
        // La clé : toujours `in`, et l'ombre la suit
        const reg = f.regs[m.prop];
        orow.cells[m.col] = { h: s.hS[m.col]!, t: reg?.t ?? null };
        continue;
      }
      const prop = input.props[m.prop]!;
      const reg = f.regs[m.prop];
      const F = { v: reg?.v ?? null, t: reg?.t ?? null };
      const hF = H(F.v);
      const unstable = shadow.unstable[m.col] === true;
      const dir = unstable && m.dir !== 'in' ? 'in' : m.dir;
      const policy = def.mode === 'both' && m.dir === 'both' ? policyOf(def, m.col) : null;
      const q = queueByCell.get(`${key}|${m.col}`) ?? null;
      const out = mergeCell({
        dir: def.mode === 'mirror' ? 'in' : def.mode === 'publish' ? (m.dir === 'in' ? 'in' : 'out') : dir,
        policy,
        ...(m.askPending ? { askPending: m.askPending } : {}),
        shadow: orow.cells[m.col] ?? null,
        vS: s.vS[m.col],
        hS: s.hS[m.col]!,
        F,
        hF,
        tS: s.tS,
        q,
        d: q ? (firstDecision.get(q.id) ?? null) : null,
        initial: !hadShadow ? (input.ack?.initial ?? null) : null,
      });
      if (q) touched.add(q.id);
      const cellKey = `${key}|${m.col}`;
      for (const j of out.journal) log({ ...j, row: f.id, col: m.col });
      if (out.newConflict) newConflicts += 1;
      if (out.queue.op === 'put') {
        const entry = cellEntry(key, f.id, m, s.vS[m.col], s.hS[m.col]!, F, hF, s.tS);
        const ok = putQueue(entry, q);
        if (!ok) continue;
        continue; // I8 : rien n'est écrit, l'ombre ne bouge pas
      }
      if (out.queue.op === 'remove' && q) nextQueue.delete(q.id);
      else if (q && out.queue.op === 'none') nextQueue.set(q.id, q);
      if (out.toFilarr) {
        pendingClocks[cellKey] = filOps.length;
        filOps.push({ r: f.id, f: m.prop, v: out.toFilarr.v });
        counts.in.changed += 1;
      }
      if (out.toSource) {
        sourceUndo[cellKey] = orow.cells[m.col] ?? null;
        toSourceOps.push({ kind: 'update', key, keyValues: s.keyValues, col: m.col, value: toSource(out.toSource.v, prop), old: s.row.raw[m.col], rowId: f.id, prop: m.prop });
        counts.out.changed += 1;
      }
      if (out.shadow !== undefined) {
        if (out.shadow === null) delete orow.cells[m.col];
        else orow.cells[m.col] = out.shadow;
      }
    }
  };

  const filarrModifiedSince = (f: FilarrRow, o: ShadowRow): boolean =>
    mapped.some((m) => !keyCols.includes(m.col) && (f.regs[m.prop]?.t ?? null) !== (o.cells[m.col]?.t ?? null));
  const sourceModifiedSince = (s: NonNullable<ReturnType<typeof src.get>>, o: ShadowRow): boolean =>
    mapped.some((m) => !keyCols.includes(m.col) && s.hS[m.col] !== (o.cells[m.col]?.h ?? null));
  const filarrValues = (f: FilarrRow): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const m of mapped) if (m.dir !== 'in' || keyCols.includes(m.col)) out[m.col] = toSource(f.regs[m.prop]?.v ?? null, input.props[m.prop]!);
    return out;
  };
  const rowConflictEntry = (key: string, rowId: string, kind: 'row_deleted_in_filarr' | 'row_gone_from_source', sVals: unknown, fVals: unknown): QueueEntry => {
    const hS = H(sVals);
    const hF = H(fVals);
    return {
      id: queueEntryId(sha256, def.id, key, '#row', hS, hF),
      row: rowId,
      key,
      col: '#row',
      prop: null,
      source: { v: truncate(sVals).v, h: hS, at: null },
      filarr: { v: truncate(fVals).v, h: hF, t: null },
      kind,
      since: now,
      truncated: false,
    };
  };
  const writeGone = (f: FilarrRow, key: string, o: ShadowRow | undefined): void => {
    const onGone = def.onGone ?? 'mark';
    if (onGone === 'mark') {
      filOps.push({ r: f.id, f: FIELD_EXT_GONE, v: { at: now, src: def.id } });
      if (o) o.g = 1;
      disappearances += 1;
    } else if (onGone === 'delete') {
      filOps.push({ r: f.id, f: FIELD_DELETED, v: true });
      delete shadow.rows[key];
      disappearances += 1;
    } else {
      delete shadow.rows[key];
    }
    counts.in.gone += 1;
    log({ kind: 'gone', row: f.id, code: onGone });
  };
  const sourceSnapshot = (s: NonNullable<ReturnType<typeof src.get>>): Record<string, unknown> => Object.fromEntries(mapped.map((m) => [m.col, s.vS[m.col]]));
  /** Une ligne supprimée dans Filarr, RESTAURÉE avec les valeurs de la source (`#d` repasse à faux). */
  const restoreFromSource = (key: string, s: NonNullable<ReturnType<typeof src.get>>, f: FilarrRow): void => {
    filOps.push({ r: f.id, f: FIELD_DELETED, v: false });
    const orow: ShadowRow = { id: f.id, cells: {} };
    shadow.rows[key] = orow;
    for (const m of mapped) {
      pendingClocks[`${key}|${m.col}`] = filOps.length;
      filOps.push({ r: f.id, f: m.prop, v: s.vS[m.col] });
      orow.cells[m.col] = { h: s.hS[m.col]!, t: null };
    }
    log({ kind: 'restored', row: f.id });
  };

  // ---------- Ligne par ligne ----------
  const keys = new Set<string>([...Object.keys(shadow.rows), ...src.keys(), ...filByKey.keys()]);
  for (const key of [...keys].sort()) {
    if (dupSrc.has(key) || dupFil.has(key)) continue;
    const s = src.get(key);
    const f = filByKey.get(key);
    const o = shadow.rows[key];
    const rowQ = queueByCell.get(`${key}|#row`) ?? null;
    if (rowQ) touched.add(rowQ.id);
    const rowDecision = rowQ ? (firstDecision.get(rowQ.id) ?? null) : null;

    // Une ligne en conflit de ligne : intouchable tant qu'aucune décision ne la vise (I8)
    if (rowQ && !rowDecision) {
      nextQueue.set(rowQ.id, rowQ);
      continue;
    }
    if (rowQ && rowDecision) {
      nextQueue.delete(rowQ.id);
      const del = rowDecision.choice === 'delete' || rowDecision.choice === 'source';
      log({ kind: 'resolved', row: rowQ.row, code: rowDecision.choice, by: rowDecision.by });
      if (rowQ.kind === 'row_deleted_in_filarr') {
        if (del && s && f) {
          toSourceOps.push({ kind: 'delete', key, keyValues: s.keyValues, rowId: f.id });
          counts.out.deleted += 1;
          if (o) o.d = 1;
        } else if (s && f) {
          restoreFromSource(key, s, f);
        }
      } else if (f) {
        if (del) writeGone(f, key, o);
        else {
          toSourceOps.push({ kind: 'insert', rowId: f.id, values: filarrValues(f) });
          counts.out.inserted += 1;
        }
      }
      continue;
    }

    if (s && !f) {
      if (o?.d) continue; // supprimée dans Filarr, suppression propagée (`ignore`) : jamais réimportée
      if (def.mode === 'publish') {
        if ((def.onSourceOnly ?? 'keep') === 'keep') continue;
      }
      // Ligne nouvelle de la source : créée dans Filarr, à son identifiant calculé (§ 3.3)
      const rowId = extRowId(sha256, input.identity, key);
      created.push(rowId);
      counts.in.created += 1;
      const orow: ShadowRow = { id: rowId, cells: {} };
      shadow.rows[key] = orow;
      for (const m of mapped) {
        if (m.dir === 'out' && !keyCols.includes(m.col) && def.mode !== 'mirror') {
          orow.cells[m.col] = { h: s.hS[m.col]!, t: null };
          continue;
        }
        pendingClocks[`${key}|${m.col}`] = filOps.length;
        filOps.push({ r: rowId, f: m.prop, v: s.vS[m.col] });
        orow.cells[m.col] = { h: s.hS[m.col]!, t: null };
      }
      log({ kind: 'created', row: rowId });
      continue;
    }

    if (!s && f && !o) {
      if (!input.source.full) continue;
      if (f.deleted) continue;
      // Clé connue de Filarr seul, ni dans la source ni dans l'ombre : orpheline
      log({ kind: 'error', code: 'orphan_row', row: f.id });
      continue;
    }

    if (s && f && !o) {
      if (f.deleted) {
        // Réconciliation sans ombre d'une ligne supprimée dans Filarr : en miroir, la source fait foi
        if (def.mode === 'mirror') restoreFromSource(key, s, f);
        continue;
      }
      mergeRow(key, s, f, undefined);
      continue;
    }

    if (!o) continue;

    if (s && f && !f.deleted) {
      if (o.g) {
        // Marquée disparue, revenue dans la source : marque levée, fusion par cellule
        filOps.push({ r: f.id, f: FIELD_EXT_GONE, v: null });
        delete o.g;
        log({ kind: 'restored', row: f.id, code: 'reappeared' });
      }
      if (o.d) {
        // Restaurée dans Filarr après une suppression propagée : réinsérée dans la source
        if (def.mode !== 'mirror') {
          toSourceOps.push({ kind: 'insert', rowId: f.id, values: filarrValues(f) });
          counts.out.inserted += 1;
          delete o.d;
        }
        continue;
      }
      mergeRow(key, s, f, o);
      continue;
    }

    if (s && f && f.deleted) {
      if (o.d) continue;
      const modified = sourceModifiedSince(s, o);
      if (def.mode === 'mirror' || (def.mode === 'both' && modified && def.rowConflict === 'keep')) {
        restoreFromSource(key, s, f);
        continue;
      }
      if (def.mode === 'both' && modified && def.rowConflict === 'ask') {
        const e = rowConflictEntry(key, f.id, 'row_deleted_in_filarr', sourceSnapshot(s), null);
        if (putQueue(e, null)) {
          newConflicts += 1;
          log({ kind: 'queued', row: f.id, col: '#row' });
        }
        continue;
      }
      // La suppression l'emporte (`delete`, `publish`, ou non modifiée) : `onFilarrDelete`
      if (modified) log({ kind: 'conflict', row: f.id, col: '#row', side: 'source', old: sourceSnapshot(s), code: 'deleted' });
      if ((def.onFilarrDelete ?? 'delete') === 'delete') {
        toSourceOps.push({ kind: 'delete', key, keyValues: s.keyValues, rowId: f.id });
        counts.out.deleted += 1;
        disappearances += 1;
      }
      o.d = 1;
      continue;
    }

    if (!s && f && !f.deleted) {
      if (!input.source.full || o.g || o.d) continue;
      const modified = filarrModifiedSince(f, o);
      if (def.mode === 'publish' || (def.mode === 'both' && modified && def.rowConflict === 'keep')) {
        toSourceOps.push({ kind: 'insert', rowId: f.id, values: filarrValues(f) });
        counts.out.inserted += 1;
        log({ kind: 'inserted', row: f.id, code: 'recreated' });
        continue;
      }
      if (def.mode === 'both' && modified && def.rowConflict === 'ask') {
        const fv: Record<string, unknown> = {};
        for (const m of mapped) fv[m.col] = f.regs[m.prop]?.v ?? null;
        const e = rowConflictEntry(key, f.id, 'row_gone_from_source', null, fv);
        if (putQueue(e, null)) {
          newConflicts += 1;
          log({ kind: 'queued', row: f.id, col: '#row' });
        }
        continue;
      }
      if (modified) log({ kind: 'conflict', row: f.id, col: '#row', side: 'filarr', code: 'gone' });
      writeGone(f, key, o);
      continue;
    }

    if (!s && (!f || f.deleted)) {
      if (input.source.full) delete shadow.rows[key];
    }
  }

  // ---------- Lignes neuves dans Filarr (sans clé) ----------
  if (def.mode === 'both' || def.mode === 'publish') {
    for (const f of noKey) {
      if (def.key.gen === 'none') {
        log({ kind: 'error', code: 'row_created_in_filarr_refused', row: f.id });
        continue;
      }
      toSourceOps.push({ kind: 'insert', rowId: f.id, values: filarrValues(f) });
      counts.out.inserted += 1;
    }
  }

  // ---------- Les garde-fous (§ 6.9) : avant toute écriture ----------
  const known = Object.keys(input.shadow?.rows ?? {}).length;
  const guard = def.guard ?? { pct: 20, min: 10 };
  const threshold = Math.max(Math.ceil((guard.pct / 100) * known), guard.min);
  const emptySource = input.source.full && src.size === 0 && known >= guard.min;
  const guardId = `p_${valueHash(sha256, [def.id, def.rev, disappearances, known]).slice(0, 10)}`;
  let stop: PassPlan['stop'] = null;
  if ((disappearances > threshold || emptySource) && input.ack?.guard !== guardId) {
    stop = { code: 'extdb_guard', question: { kind: 'guard', pass: guardId, gone: emptySource ? known : disappearances, total: known } };
  }
  const burstLimit = Math.max(Math.ceil(0.1 * Math.max(src.size, known)), 50);
  if (!stop && newConflicts > burstLimit && !(input.ack?.initial && !hadShadow)) {
    stop = { code: 'extdb_conflict_burst', question: { kind: 'conflict_burst', pass: guardId, n: newConflicts, initial: !hadShadow } };
  }
  if (stop) {
    // Un passage arrêté n'écrit RIEN, d'aucun côté (§ 6.9) : son journal ne dit que ce qui a été LU (les
    // lignes laissées de côté, `error`) et l'ARRÊT, avec le nombre prévu (disparitions ou conflits nouveaux).
    // Aucune action planifiée (« gone », « out », mise en file, décision traitée…) n'y reste : le journal
    // ferait croire à des lignes marquées qui ne l'ont pas été (I3). Le détail prévu se lit dans la
    // question (`gone`/`total`, `n`), jamais comme un fait ; les compteurs disent ce qui a été fait : rien.
    const read = journal.filter((j) => j.kind === 'error');
    return {
      stop,
      toFilarr: [],
      created: [],
      toSource: [],
      minted: [],
      shadow: input.shadow ? cloneShadow(input.shadow) : emptyShadow(def),
      queue: [...input.queue],
      overflow: 0,
      journal: [...read, { at: now, pass: input.passId, kind: 'guard', code: stop.code, n: Number(stop.question.gone ?? stop.question.n ?? 0) }],
      counts: { rows: src.size || known, in: { changed: 0, created: 0, gone: 0 }, out: { changed: 0, inserted: 0, deleted: 0 }, conflicts: input.queue.length },
      handledDecisions: [],
      pendingClocks: {},
      sourceUndo: {},
    };
  }

  // Les entrées de file que ce passage n'a pas touchées restent (colonne retirée : elles sortent)
  const mappedCols = new Set(mapped.map((m) => m.col));
  for (const q of input.queue) {
    if (touched.has(q.id) || nextQueue.has(q.id)) continue;
    if (q.col !== '#row' && !mappedCols.has(q.col)) {
      log({ kind: 'resolved_by_policy', row: q.row, col: q.col, code: 'column_removed' });
      continue;
    }
    nextQueue.set(q.id, q);
  }
  if (overflow > 0) log({ kind: 'queue_full', n: overflow });

  shadow.def = def.id;
  shadow.defRev = def.rev;
  if (markerMax !== null) shadow.marker = markerMax;
  if (input.source.full) {
    shadow.fullAt = now;
    shadow.passes = 0;
  } else shadow.passes += 1;
  counts.rows = input.source.full ? src.size : Object.keys(shadow.rows).length;
  counts.conflicts = nextQueue.size;
  log({ kind: 'pass', n: filOps.length + toSourceOps.length });
  return {
    stop: null,
    toFilarr: filOps,
    created,
    toSource: toSourceOps,
    minted,
    shadow,
    queue: [...nextQueue.values()],
    overflow,
    journal,
    counts,
    handledDecisions: handled,
    pendingClocks,
    sourceUndo,
  };
}

/**
 * Les écritures dans la source qui n'ont PAS pris (la source a changé pendant le
 * passage, 0 ligne touchée) : leur cellule garde l'ombre d'avant, elle sera un
 * cas B ou E au passage suivant (§ 6.6).
 */
export function applySourceResults(plan: PassPlan, failed: ReadonlyArray<{ key: string; col: string }>): PassPlan {
  const shadow = cloneShadow(plan.shadow);
  for (const { key, col } of failed) {
    const prev = plan.sourceUndo[`${key}|${col}`];
    const row = shadow.rows[key];
    if (!row) continue;
    if (prev === null || prev === undefined) delete row.cells[col];
    else row.cells[col] = prev;
  }
  return { ...plan, shadow, toSource: plan.toSource.filter((op) => op.kind !== 'update' || !failed.some((f) => f.key === op.key && f.col === op.col)) };
}

/**
 * L'écho (§ 6.5, étape 6) : la source a relu une valeur différente de celle de
 * Filarr (arrondi, date normalisée, texte coupé). La valeur relue est écrite dans
 * Filarr DANS CE PASSAGE ; une cellule qui fait écho deux passages de suite est
 * instable : la colonne cesse de sortir.
 */
export function applyEcho(
  plan: PassPlan,
  echoes: ReadonlyArray<{ key: string; col: string; rowId: string; prop: string; value: unknown }>,
  sha256: Sha256
): PassPlan {
  const shadow = cloneShadow(plan.shadow);
  const toFilarrOps = [...plan.toFilarr];
  const pending = { ...plan.pendingClocks };
  const journal = [...plan.journal];
  const at = journal[0]?.at ?? new Date(0).toISOString();
  const pass = journal[0]?.pass ?? '';
  const echoed = new Set<string>();
  for (const e of echoes) {
    const cellKey = `${e.key}|${e.col}`;
    echoed.add(cellKey);
    pending[cellKey] = toFilarrOps.length;
    toFilarrOps.push({ r: e.rowId, f: e.prop, v: e.value });
    const row = shadow.rows[e.key];
    if (row) row.cells[e.col] = { h: valueHash(sha256, e.value), t: null };
    const n = (shadow.echo[cellKey] ?? 0) + 1;
    shadow.echo[cellKey] = n;
    journal.push({ at, pass, kind: 'normalized', row: e.rowId, col: e.col, new: e.value });
    if (n >= 2 && !shadow.unstable[e.col]) {
      shadow.unstable[e.col] = true;
      journal.push({ at, pass, kind: 'unstable', col: e.col });
    }
  }
  // Une cellule sortie sans écho remet son compteur à zéro
  for (const op of plan.toSource) {
    if (op.kind === 'update' && !echoed.has(`${op.key}|${op.col}`)) delete shadow.echo[`${op.key}|${op.col}`];
  }
  return { ...plan, shadow, toFilarr: toFilarrOps, pendingClocks: pending, journal };
}

/** Les horloges des registres écrits dans Filarr (après la validation) posées dans l'ombre. */
export function applyClocks(plan: PassPlan, ticks: readonly string[]): Shadow {
  const shadow = cloneShadow(plan.shadow);
  for (const [cellKey, index] of Object.entries(plan.pendingClocks)) {
    const sep = cellKey.lastIndexOf('|');
    const key = cellKey.slice(0, sep);
    const col = cellKey.slice(sep + 1);
    const cell = shadow.rows[key]?.cells[col];
    const t = ticks[index];
    if (cell && t) cell.t = t;
  }
  return shadow;
}

/** Les cellules de Filarr qui ont changé depuis l'ombre : la lecture ciblée de la source (§ 6.5, étape 3). */
export function filarrChangedKeys(def: ExtSourceDef, shadow: Shadow | null, filarr: readonly FilarrRow[]): string[] {
  if (!shadow) return [];
  const byId = new Map(filarr.map((r) => [r.id, r]));
  const out: string[] = [];
  for (const [key, o] of Object.entries(shadow.rows)) {
    const f = byId.get(o.id);
    if (!f) continue;
    const changed = f.deleted || def.map.some((m) => !def.key.cols.includes(m.col) && (f.regs[m.prop]?.t ?? null) !== (o.cells[m.col]?.t ?? null));
    if (changed) out.push(key);
  }
  return out;
}

/** Les valeurs de clé d'une clé canonique (pour une lecture ciblée ou une écriture). */
export function keyValuesOf(def: ExtSourceDef, key: string): Record<string, string> {
  const parts = key.split('\u001f');
  return Object.fromEntries(def.key.cols.map((c, i) => [c, parts[i] ?? '']));
}

