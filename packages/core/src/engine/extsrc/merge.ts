// Écrit dans filarr-gate (origine) — cœur pur, à recopier tel quel par filarg (lot B2).
/**
 * La règle de fusion d'une cellule (`mergeCell`) — contrat `source-externe-1`
 * § 6.3, avec la file « me demander » (§ 6.12). Fonction PURE : les empreintes
 * sont calculées par l'appelant.
 *
 * - `srcChanged = H(toFilarr(S)) ≠ ombre.h` ; `filChanged = F.t ≠ ombre.t`
 *   (l'horloge du REGISTRE, jamais une horloge de passage : un appareil revenu
 *   de hors ligne écrit avec une heure plus ancienne que le dernier passage).
 * - Cas A à G ; politiques `source`, `filarr`, `latest`, `ask` pour une colonne
 *   `both` (aucune n'est présélectionnée : la validation exige un choix).
 * - Une cellule en file n'est JAMAIS écrite, d'aucun côté, tant qu'aucune
 *   décision valable ni aucun changement de politique avec `askPending: "apply"`
 *   ne la vise (I8) ; une décision prise sur des valeurs qui ont changé depuis
 *   est périmée (I9).
 */

import { parseHlc } from '../store/hlc';
import type { Decision, Dir, Policy, QueueEntry, ShadowCell, SyncJournalEntry } from './types';

export interface CellInput {
  dir: Dir;
  /** La politique de la colonne (sinon celle de la définition) ; `null` hors du mode `both`. */
  policy: Policy | null;
  /** `askPending` de la colonne (révision qui la fait QUITTER `ask`). */
  askPending?: 'apply' | 'keep';
  shadow: ShadowCell | null;
  /** `toFilarr(S)` et son empreinte. */
  vS: unknown;
  hS: string;
  /** Le registre Filarr (`t` : `null` s'il n'a jamais été écrit) et l'empreinte de sa valeur. */
  F: { v: unknown; t: string | null };
  hF: string;
  /** Le repère de la ligne côté source, en millisecondes (si c'est un temps). */
  tS: number | null;
  /** L'entrée de la file pour cette cellule, s'il y en a une. */
  q: QueueEntry | null;
  /** La PREMIÈRE décision du serveur pour `q.id`, s'il y en a une. */
  d: Decision | null;
  /** Premier passage tranché d'office par un accord explicite (`ack.initial`, § 6.9). */
  initial: 'source' | 'filarr' | null;
}

export type QueueAction = { op: 'none' } | { op: 'remove' } | { op: 'put'; kind: 'queued' | 'requeued' };

export interface CellOutput {
  case: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'Q';
  /** Valeur à écrire dans Filarr (le registre prend une horloge neuve). */
  toFilarr?: { v: unknown };
  /** Valeur (domaine Filarr) à écrire dans la source, sous la condition de sa valeur lue. */
  toSource?: { v: unknown };
  /** L'ombre après coup (`t: null` : horloge du registre écrit dans ce passage). `undefined` : inchangée. */
  shadow?: ShadowCell | null;
  queue: QueueAction;
  journal: Array<Omit<SyncJournalEntry, 'at' | 'pass' | 'row' | 'col'>>;
  /** Un conflit NOUVEAU (cas E ou G), compté pour le garde-fou des rafales. */
  newConflict: boolean;
  /** La décision `d` a été appliquée, écartée comme périmée, ou rien. */
  decision: 'applied' | 'stale' | 'none';
}

/** Les millisecondes d'une horloge de registre (`hlc.ts`) ; un registre jamais écrit est infiniment vieux. */
export const msOfHlc = (t: string | null): number => {
  if (!t) return Number.NEGATIVE_INFINITY;
  const parts = parseHlc(t);
  return parts ? parts.ms : Number.NEGATIVE_INFINITY;
};

/** Qui gagne entre la source et Filarr, selon la politique (cas E et G d'une colonne `both`). */
function winner(p: Policy, input: CellInput): 'source' | 'filarr' | 'ask' {
  if (p === 'source' || p === 'filarr' || p === 'ask') return p;
  // latest : `tS ≥ ms(F.t)` → la source, sinon Filarr
  return input.tS !== null && input.tS >= msOfHlc(input.F.t) ? 'source' : 'filarr';
}

function fresh(input: CellInput, conflictIsNew: boolean): CellOutput {
  const { dir, shadow, hS, hF } = input;
  const out = (o: Omit<CellOutput, 'decision'>): CellOutput => ({ ...o, decision: 'none' });
  const toFil = (): Pick<CellOutput, 'toFilarr' | 'shadow'> => ({ toFilarr: { v: input.vS }, shadow: { h: hS, t: null } });
  const toSrc = (): Pick<CellOutput, 'toSource' | 'shadow'> => ({ toSource: { v: input.F.v }, shadow: { h: hF, t: input.F.t } });

  if (!shadow) {
    // F : sans ombre, valeurs égales — l'ombre naît
    if (hS === hF) return out({ case: 'F', shadow: { h: hS, t: input.F.t }, queue: { op: 'none' }, journal: [], newConflict: false });
    // G : sans ombre, valeurs différentes
    if (dir === 'in') return out({ case: 'G', ...toFil(), queue: { op: 'none' }, journal: [{ kind: 'replaced_local', side: 'filarr', old: input.F.v, new: input.vS }], newConflict: false });
    if (dir === 'out') return out({ case: 'G', ...toSrc(), queue: { op: 'none' }, journal: [{ kind: 'replaced_source', side: 'source', old: input.vS, new: input.F.v }], newConflict: false });
    return resolveConflict('G', input, conflictIsNew);
  }
  const srcChanged = hS !== shadow.h;
  const filChanged = input.F.t !== shadow.t;
  if (!srcChanged && !filChanged) return out({ case: 'A', queue: { op: 'none' }, journal: [], newConflict: false });
  if (srcChanged && !filChanged) {
    if (dir === 'out') return out({ case: 'B', ...toSrc(), queue: { op: 'none' }, journal: [{ kind: 'replaced_source', side: 'source', old: input.vS, new: input.F.v }], newConflict: false });
    return out({ case: 'B', ...toFil(), queue: { op: 'none' }, journal: [{ kind: 'in', old: input.F.v, new: input.vS }], newConflict: false });
  }
  if (!srcChanged && filChanged) {
    if (dir === 'in') return out({ case: 'C', ...toFil(), queue: { op: 'none' }, journal: [{ kind: 'replaced_local', side: 'filarr', old: input.F.v, new: input.vS }], newConflict: false });
    return out({ case: 'C', ...toSrc(), queue: { op: 'none' }, journal: [{ kind: 'out', old: input.vS, new: input.F.v }], newConflict: false });
  }
  // Les deux ont changé
  if (hS === hF) return out({ case: 'D', shadow: { h: hS, t: input.F.t }, queue: { op: 'remove' }, journal: [], newConflict: false });
  if (dir === 'in') return out({ case: 'E', ...toFil(), queue: { op: 'none' }, journal: [{ kind: 'replaced_local', side: 'filarr', old: input.F.v, new: input.vS }], newConflict: false });
  if (dir === 'out') return out({ case: 'E', ...toSrc(), queue: { op: 'none' }, journal: [{ kind: 'replaced_source', side: 'source', old: input.vS, new: input.F.v }], newConflict: false });
  return resolveConflict('E', input, conflictIsNew);
}

function resolveConflict(c: 'E' | 'G', input: CellInput, conflictIsNew: boolean): CellOutput {
  const p: Policy | null = c === 'G' && input.initial ? input.initial : input.policy;
  if (p === null) {
    // Une définition `both` sans politique (client d'avant la révision A2) : rien n'est écrit
    return { case: c, queue: { op: 'none' }, journal: [{ kind: 'error', code: 'extdb_policy_missing' }], newConflict: false, decision: 'none' };
  }
  const w = winner(p, input);
  if (w === 'ask') {
    return { case: c, queue: { op: 'put', kind: input.q ? 'requeued' : 'queued' }, journal: [{ kind: input.q ? 'requeued' : 'queued' }], newConflict: conflictIsNew, decision: 'none' };
  }
  if (w === 'source') {
    return {
      case: c,
      toFilarr: { v: input.vS },
      shadow: { h: input.hS, t: null },
      queue: { op: 'none' },
      journal: [{ kind: 'conflict', side: 'filarr', old: input.F.v, new: input.vS }],
      newConflict: conflictIsNew,
      decision: 'none',
    };
  }
  return {
    case: c,
    toSource: { v: input.F.v },
    shadow: { h: input.hF, t: input.F.t },
    queue: { op: 'none' },
    journal: [{ kind: 'conflict', side: 'source', old: input.vS, new: input.F.v }],
    newConflict: conflictIsNew,
    decision: 'none',
  };
}

/** La règle d'une cellule. */
export function mergeCell(input: CellInput): CellOutput {
  const q = input.q;
  if (!q) return fresh(input, true);
  const current = input.hS === q.source.h && input.F.t === q.filarr.t;

  // Une décision reçue pour cette entrée
  if (input.d) {
    if (current) {
      const d = input.d;
      if (d.choice === 'filarr') {
        return {
          case: 'Q',
          toSource: { v: input.F.v },
          shadow: { h: input.hF, t: input.F.t },
          queue: { op: 'remove' },
          journal: [{ kind: 'resolved', side: 'source', old: input.vS, new: input.F.v, by: d.by }],
          newConflict: false,
          decision: 'applied',
        };
      }
      if (d.choice === 'source') {
        return {
          case: 'Q',
          toFilarr: { v: input.vS },
          shadow: { h: input.hS, t: null },
          queue: { op: 'remove' },
          journal: [{ kind: 'resolved', side: 'filarr', old: input.F.v, new: input.vS, by: d.by }],
          newConflict: false,
          decision: 'applied',
        };
      }
    }
    // Périmée (ou sans objet pour une cellule) : réévaluée comme une cellule neuve
    const re = fresh({ ...input, q: null, d: null }, true);
    const queue: QueueAction = re.queue.op === 'put' ? { op: 'put', kind: 'requeued' } : { op: 'remove' };
    return { ...re, queue, journal: [{ kind: 'resolution_stale', by: input.d.by }, ...re.journal], decision: 'stale' };
  }

  // La colonne a quitté `ask` avec « trancher les conflits en attente par la nouvelle règle »
  if (input.policy !== 'ask' && input.askPending === 'apply' && input.policy !== null) {
    if (current) {
      const re = resolveConflict('E', { ...input, q: null }, false);
      return {
        ...re,
        queue: { op: 'remove' },
        journal: re.journal.map((j) => (j.kind === 'conflict' ? { ...j, kind: 'resolved_by_policy' as const } : j)),
      };
    }
    const re = fresh({ ...input, q: null }, true);
    return { ...re, queue: re.queue.op === 'put' ? { op: 'put', kind: 'requeued' } : { op: 'remove' } };
  }

  // Pas de décision : l'entrée reste tant que rien ne bouge (I8)
  if (current) return { case: 'Q', queue: { op: 'none' }, journal: [], newConflict: false, decision: 'none' };
  // Un côté a changé : cas D (résolu de lui-même), sinon une entrée aux valeurs nouvelles
  if (input.hS === input.hF) {
    return { case: 'D', shadow: { h: input.hS, t: input.F.t }, queue: { op: 'remove' }, journal: [], newConflict: false, decision: 'none' };
  }
  if (input.policy === 'ask' || input.policy === null || input.askPending !== 'apply') {
    // Toujours à trancher à la main (colonne en `ask`, ou entrée gardée par `askPending: "keep"`)
    if (input.policy === 'ask') return { case: 'Q', queue: { op: 'put', kind: 'requeued' }, journal: [{ kind: 'requeued' }], newConflict: false, decision: 'none' };
  }
  // Colonne repassée en automatique : un conflit NOUVEAU suit la nouvelle politique
  const re = fresh({ ...input, q: null }, true);
  return { ...re, queue: re.queue.op === 'put' ? { op: 'put', kind: 'requeued' } : { op: 'remove' } };
}
