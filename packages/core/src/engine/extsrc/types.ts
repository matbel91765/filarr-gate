// Écrit dans filarr-gate (origine) — cœur pur, à recopier tel quel par filarg (lot B2).
/**
 * Les formes du contrat `source-externe-1` : la définition (`ExtSourceDef`, § 2),
 * l'ombre (§ 6.1), la file « me demander » (§ 6.12), les décisions, le journal
 * (§ 6.10) et l'état publié (§ 9.1).
 *
 * Cœur portable, `strict` et `noUncheckedIndexedAccess`.
 */

export type ConnectorId = 'd1' | 'postgres' | 'supabase' | 'mysql' | 'airtable' | 'gsheets' | 'notion' | 'url';
export type SyncMode = 'once' | 'mirror' | 'publish' | 'both';
export type Dir = 'in' | 'out' | 'both';
export type Policy = 'source' | 'filarr' | 'latest' | 'ask';
export type RowPolicy = 'delete' | 'keep' | 'ask';
export type MarkerKind = 'iso' | 'epoch_ms' | 'epoch_s' | 'int';

export interface MapEntry {
  col: string;
  prop: string;
  dir: Dir;
  /** Type de la propriété Filarr visée (`text`, `number`, `select`…). */
  type: string;
  conflict?: Policy;
  askPending?: 'apply' | 'keep';
  [extra: string]: unknown;
}

export interface ExtSourceDef {
  v: number;
  id: string;
  rev: number;
  name: string;
  connector: ConnectorId;
  conn: Record<string, unknown>;
  host: string;
  from: { table: string } | { query: string };
  key: { cols: string[]; gen: 'source' | 'runner' | 'none' };
  marker: { col: string; kind: MarkerKind } | null;
  mode: SyncMode;
  map: MapEntry[];
  ignored?: string[];
  conflict?: Policy;
  rowConflict?: RowPolicy;
  onNewColumn?: 'ask' | 'add';
  onGone?: 'mark' | 'delete' | 'keep';
  onFilarrDelete?: 'delete' | 'ignore';
  onSourceOnly?: 'keep' | 'import';
  guard?: { pct: number; min: number };
  runner:
    | { kind: 'gate'; accessId: string; name?: string }
    | { kind: 'hosted'; accessId: string; name?: string }
    | { kind: 'device'; account: string; site: string; name?: string };
  schedule: { every: 'manual' | '15m' | '1h' | '1d'; at?: string | null; tz?: string; onChange?: boolean };
  createdAt?: string;
  updatedAt?: string;
  signer: string;
  sig?: string;
  [extra: string]: unknown;
}

/** L'ombre d'une cellule : l'empreinte de la valeur commune et l'horloge du registre Filarr à ce moment. */
export interface ShadowCell {
  h: string;
  /** Horloge (hlc) du registre ; `null` : à poser après l'écriture dans Filarr de ce passage. */
  t: string | null;
}

export interface ShadowRow {
  /** L'identifiant de la ligne dans Filarr. */
  id: string;
  /** La suppression a été propagée. */
  d?: 1;
  /** La ligne est marquée disparue de la source (`extGone`). */
  g?: 1;
  cells: Record<string, ShadowCell>;
}

export interface Shadow {
  v: 1;
  def: string;
  defRev: number;
  /** Le plus grand repère lu (en millisecondes pour un temps, sinon la valeur). */
  marker: number | string | null;
  /** Dernière lecture entière (ISO). */
  fullAt: string | null;
  /** Passages depuis la dernière lecture entière. */
  passes: number;
  /** Par clé canonique. */
  rows: Record<string, ShadowRow>;
  /** Écho d'une cellule (`clé|col` → passages de suite où la source a normalisé). */
  echo: Record<string, number>;
  /** Colonnes instables : elles ne sortent plus. */
  unstable: Record<string, true>;
}

export type QueueKind = 'cell' | 'row_deleted_in_filarr' | 'row_gone_from_source';

export interface QueueEntry {
  id: string;
  row: string;
  key: string;
  col: string;
  prop: string | null;
  source: { v: unknown; h: string; at: string | null };
  filarr: { v: unknown; h: string; t: string | null };
  kind: QueueKind;
  since: string;
  truncated: boolean;
}

export type DecisionChoice = 'filarr' | 'source' | 'delete' | 'keep';

export interface Decision {
  id: string;
  choice: DecisionChoice;
  by: { userId: string; device?: string };
  at: string;
  /** Numéro de dépôt du serveur (ordre d'application). */
  seq: number;
}

export type JournalKind =
  | 'pass'
  | 'in'
  | 'out'
  | 'created'
  | 'inserted'
  | 'gone'
  | 'deleted'
  | 'restored'
  | 'conflict'
  | 'replaced_local'
  | 'replaced_source'
  | 'normalized'
  | 'unstable'
  | 'guard'
  | 'schema'
  | 'error'
  | 'queued'
  | 'requeued'
  | 'resolved'
  | 'resolution_stale'
  | 'resolution_duplicate'
  | 'resolved_by_policy'
  | 'queue_full';

export interface SyncJournalEntry {
  at: string;
  pass: string;
  kind: JournalKind;
  row?: string;
  col?: string;
  old?: unknown;
  new?: unknown;
  side?: 'source' | 'filarr';
  n?: number;
  code?: string;
  by?: { userId: string; device?: string };
}

export interface SyncStatus {
  v: 1;
  def: string;
  defRev: number;
  rev: number;
  runner: string;
  runnerName: string;
  where: 'self' | 'hosted' | 'device';
  state: 'ok' | 'running' | 'waiting' | 'paused' | 'question' | 'stopped' | 'error';
  code: string | null;
  lastRunAt: string | null;
  lastOkAt: string | null;
  nextRunAt: string | null;
  counts: {
    rows: number;
    in: { changed: number; created: number; gone: number };
    out: { changed: number; inserted: number; deleted: number };
    conflicts: number;
  };
  queue: { n: number; overflow: number; rev: number };
  question: null | Record<string, unknown>;
  columns: Array<{ col: string; status: 'removed' | 'type_changed' | 'unstable' }>;
  journal: SyncJournalEntry[];
}

/** Bornes du contrat. */
export const QUEUE_MAX = 500;
export const JOURNAL_MAX = 200;
export const JOURNAL_DAYS = 30;
export const VALUE_TRUNCATE_BYTES = 1024;
export const DEF_MAX_BYTES = 16 * 1024;
export const MAX_KEY_COLS = 3;
