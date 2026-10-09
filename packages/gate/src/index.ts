/**
 * `@filarr/gate` — lire et écrire les lignes d'une base Filarr ouverte à une API,
 * depuis votre propre code (Node 20+, Deno, Bun, Workers Cloudflare), sans que
 * Filarr voie vos données.
 *
 * ```ts
 * import { openGate } from '@filarr/gate'
 *
 * const gate = await openGate({ token: process.env.FILARR_GATE_TOKEN })
 * const rows = await gate.base('clients').view('actifs').rows()
 * ```
 */

export { openGate, Gate, GateError, GATE_LIB_VERSION, DEFAULT_API_URL } from './gate';
export type { OpenGateOptions, Base, View, Files } from './gate';
export type {
  Row,
  RowInput,
  RowList,
  RowsOptions,
  ViewRowsOptions,
  FieldCondition,
  Primitive,
  FieldInfo,
  ViewSummary,
  BaseSummary,
  BaseStatus,
  ChangeEvent,
  GateStatus,
  LinkState,
  SqlResult,
  DepositOptions,
  FileDeposit,
  FileStatus,
  GateErrorShape,
} from './types';
