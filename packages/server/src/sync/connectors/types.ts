/**
 * Les connecteurs des bases externes — contrat `source-externe-1` § 1, § 6.6.
 *
 * Un connecteur lit (entier, depuis un repère, ou par clés) et écrit (sous
 * condition de la valeur lue quand il le peut). Il ne voit jamais Filarr : le
 * cœur pur (`planPass`) décide, le connecteur exécute. Les clés (jetons, mots de
 * passe, comptes de service) arrivent de la boîte, jamais de Filarr (D4), et ne
 * sont posées que sur une requête vers un hôte du connecteur.
 */

import type { ExtSourceDef, PropSpec, SourceOp, SourceRow } from '../../../../core/src/engine/extsrc';

export type ExtdbCode =
  | 'extdb_key_missing'
  | 'extdb_key_refused'
  | 'extdb_unreachable'
  | 'extdb_timeout'
  | 'extdb_tls'
  | 'extdb_not_found'
  | 'extdb_upstream_limited'
  | 'extdb_too_large'
  | 'extdb_schema_changed'
  /** La définition ne peut pas s'exécuter telle quelle (détail : le code de validation). */
  | 'extdb_def_invalid';

export class ConnectorError extends Error {
  constructor(
    readonly code: ExtdbCode,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

export interface ConnectorContext {
  def: ExtSourceDef;
  /** La clé de la base externe (jeton, mot de passe, JSON du compte de service). */
  secret: string;
  fetch: typeof fetch;
  /** Charge un pilote à la demande (`pg`, `mysql2/promise`) : la boîte n'en dépend pas d'office. */
  loadDriver: (name: 'pg' | 'mysql2/promise') => Promise<unknown>;
  props: Record<string, PropSpec>;
  /** Attente entre deux appels (débit amont) ; injectable pour les essais. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SourceWriteResult {
  /** Mises à jour qui n'ont pas pris (la source a changé pendant le passage). */
  failed: Array<{ key: string; col: string }>;
  /** Les lignes relues après écriture, par clé canonique (valeurs brutes). */
  reread: Map<string, Record<string, unknown>>;
  /** Les lignes insérées : la clé relue (ou tirée par l'exécutant). */
  inserted: Array<{ rowId: string; keyValues: Record<string, unknown> | null }>;
}

export interface Connector {
  readonly caps: { cas: boolean };
  readAll(): Promise<SourceRow[]>;
  readSince(marker: number | string): Promise<SourceRow[]>;
  readKeys(keys: ReadonlyArray<Record<string, unknown>>): Promise<SourceRow[]>;
  write(ops: readonly SourceOp[]): Promise<SourceWriteResult>;
  close(): Promise<void>;
}

/**
 * Précision P3 (`source-externe-1`, 2026-10-10) : une colonne RELATION de la source (relation
 * Notion, enregistrements liés d'Airtable) n'est pas prise en charge en v1 — la définition ne nomme
 * pas la base visée. Associée, elle arrête le passage à la lecture, avant toute écriture : jamais
 * importée en texte (des identifiants de pages ou d'enregistrements) en silence.
 */
export function unsupportedColumn(what: string, col: string): ConnectorError {
  return new ConnectorError('extdb_def_invalid', `unsupported_column · ${what} : la colonne « ${col} » est une relation de la source, non prise en charge (v1)`);
}

/** Les colonnes à lire : la clé, les colonnes associées, le repère (jamais les colonnes ignorées). */
export function columnsOf(def: ExtSourceDef): string[] {
  const out: string[] = [];
  for (const c of [...def.key.cols, ...def.map.map((m) => m.col), ...(def.marker ? [def.marker.col] : [])]) if (!out.includes(c)) out.push(c);
  return out;
}

/** Le repère en paramètre de requête : ISO pour un temps `iso`, secondes pour `epoch_s`, sinon tel quel. */
export function markerParam(def: ExtSourceDef, marker: number | string): unknown {
  if (!def.marker || typeof marker !== 'number') return marker;
  if (def.marker.kind === 'iso') return new Date(marker).toISOString();
  if (def.marker.kind === 'epoch_s') return Math.floor(marker / 1000);
  return marker;
}

/** Une réponse HTTP d'un service en erreur de connecteur (`401`/`403` → clé refusée, `404`, `429`…). */
export async function httpError(res: Response, what: string): Promise<ConnectorError> {
  const status = res.status;
  await res.arrayBuffer().catch(() => undefined);
  if (status === 401 || status === 403) return new ConnectorError('extdb_key_refused', `${what} a refusé la clé (${status})`, status);
  if (status === 404) return new ConnectorError('extdb_not_found', `${what} : introuvable (404)`, status);
  if (status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    return new ConnectorError('extdb_upstream_limited', `${what} limite le débit (429)`, status, Number.isFinite(ra) ? ra * 1000 : 60_000);
  }
  return new ConnectorError('extdb_unreachable', `${what} a répondu ${status}`, status);
}

/** `fetch` vers un service, avec délai et erreurs de réseau traduites. */
export async function call(ctx: ConnectorContext, url: string, init: RequestInit, what: string, timeoutMs = 30_000): Promise<Response> {
  try {
    return await ctx.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new ConnectorError('extdb_timeout', `${what} : délai dépassé`);
    const msg = String((err as Error)?.message ?? err);
    if (/certificate|tls|ssl/i.test(msg)) throw new ConnectorError('extdb_tls', `${what} : TLS refusé (${msg})`);
    throw new ConnectorError('extdb_unreachable', `${what} injoignable (${msg})`);
  }
}

/** Les pages d'un service limité en débit : une attente entre deux appels. */
export function pacer(ctx: ConnectorContext, minIntervalMs: number): () => Promise<void> {
  let last = 0;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async () => {
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  };
}
