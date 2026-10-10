// Écrit dans filarr-gate (origine) — cœur pur, à recopier tel quel par filarg (lot B2).
/**
 * La définition d'une synchro externe — contrat `source-externe-1` § 2 :
 * validation (codes du § 2.2), JSON canonique signé (§ 8.3) et vérification.
 *
 * Une définition vit dans `schema.extra.extSource` de la tête du magasin : tout
 * membre qui écrit dans la base peut la modifier. Elle ne s'exécute donc que
 * SIGNÉE par le compte au nom duquel elle s'exécute (le créateur de l'accès pour
 * une boîte noire), avec sa clé d'identité Ed25519 :
 * `sig = base64url(Ed25519(clé, "filarr/extsrc/v1|def|" + JSON canonique sans sig))`.
 */

import { canonicalJson } from '../store/canonical';
import { fromBase64Std, type AccessCurves } from '../store/apiAccess';
import { fromBase64Url, toBase64Url, utf8Encode } from '../store/crypto';
import { parseStatement } from '../sql/parser';
import { DEF_MAX_BYTES, MAX_KEY_COLS, type ConnectorId, type ExtSourceDef, type Policy } from './types';

export const CONNECTORS: readonly ConnectorId[] = ['d1', 'postgres', 'supabase', 'mysql', 'airtable', 'gsheets', 'notion', 'url'];
const POLICIES: readonly Policy[] = ['source', 'filarr', 'latest', 'ask'];
const MAPPABLE = new Set([
  'text', 'number', 'checkbox', 'date', 'select', 'multiSelect', 'url', 'email', 'phone', 'rating', 'progress', 'relation', 'person',
  'formula', 'rollup', 'createdTime', 'updatedTime',
]);
/** Ce qui ne reçoit jamais rien de la source (§ 4) : calculé dans Filarr. */
const COMPUTED = new Set(['formula', 'rollup', 'createdTime', 'updatedTime']);
const EVERY = new Set(['manual', '15m', '1h', '1d']);
/** Les hôtes fixes des connecteurs https (§ 1, § 12.2). */
const FIXED_HOST: Partial<Record<ConnectorId, string>> = {
  d1: 'api.cloudflare.com',
  airtable: 'api.airtable.com',
  gsheets: 'sheets.googleapis.com',
  notion: 'api.notion.com',
};

export type DefCode =
  | 'bad_version' | 'bad_id' | 'bad_name' | 'bad_connector' | 'bad_conn' | 'host_mismatch' | 'host_forbidden'
  | 'tls_off_not_local' | 'query_not_select' | 'query_with_write_mode' | 'key_missing' | 'key_too_many'
  | 'key_not_mapped' | 'marker_bad_kind' | 'latest_without_time_marker' | 'map_empty' | 'map_duplicate_prop'
  | 'map_duplicate_col' | 'dir_forbidden_for_mode' | 'type_unmappable' | 'computed_prop_inbound'
  | 'runner_unsupported' | 'schedule_too_fast' | 'bad_signature' | 'too_large' | 'conflict_policy_missing'
  | 'row_conflict_missing' | 'bad_policy' | 'ask_pending_bad' | 'unsupported_column';

export interface DefContext {
  /** Le type de chaque propriété de la base (`propId → type`), pour les contrôles de type. */
  propTypes?: Record<string, string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Un hôte du réseau local (plages IANA privées, noms en `.lan`, `.local`, `.internal`, `.home.arpa`). */
export function isLocalHost(host: string): boolean {
  const h = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (/\.(lan|local|internal|home\.arpa)$/.test(h) || h === 'localhost') return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith('fe80:');
}

/** La garde d'hôte d'une adresse https donnée par l'utilisateur : aucun littéral IP, aucun nom local, rien sous filarr.com. */
export function httpsHostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':') || h.startsWith('[')) return false;
  if (!h.includes('.') || isLocalHost(h)) return false;
  return !(h === 'filarr.com' || h.endsWith('.filarr.com'));
}

/** L'hôte que lie la clé, tel que `conn` le dit (minuscules ; `hôte:port` en TCP). */
export function expectedHost(def: Pick<ExtSourceDef, 'connector' | 'conn'>): string | null {
  const fixed = FIXED_HOST[def.connector];
  if (fixed) return fixed;
  const c = def.conn;
  try {
    if (def.connector === 'postgres' || def.connector === 'mysql') {
      if (!str(c.host)) return null;
      const port = typeof c.port === 'number' ? c.port : def.connector === 'postgres' ? 5432 : 3306;
      return `${c.host.toLowerCase()}:${port}`;
    }
    if (def.connector === 'supabase' || def.connector === 'url') {
      const u = new URL(String(c.url));
      if (u.protocol !== 'https:') return null;
      return u.hostname.toLowerCase();
    }
  } catch {
    return null;
  }
  return null;
}

function connOk(def: ExtSourceDef): boolean {
  const c = def.conn;
  if (!isObj(c)) return false;
  switch (def.connector) {
    case 'd1':
      return str(c.account) && str(c.database);
    case 'postgres':
      return str(c.host) && str(c.db) && str(c.user) && (c.port === undefined || (typeof c.port === 'number' && c.port > 0 && c.port < 65536));
    case 'mysql':
      return str(c.host) && str(c.db) && str(c.user) && (c.port === undefined || (typeof c.port === 'number' && c.port > 0 && c.port < 65536));
    case 'supabase':
      return str(c.url);
    case 'airtable':
      return str(c.base) && str(c.table);
    case 'gsheets':
      return str(c.spreadsheet) && str(c.tab);
    case 'notion':
      return str(c.database);
    case 'url': {
      const f = c.format;
      return str(c.url) && isObj(f) && (f.kind === 'csv' || f.kind === 'json');
    }
    default:
      return false;
  }
}

/** Une seule instruction SELECT (ou WITH … SELECT), selon l'analyseur SQL de Filarr. */
export function isSelectQuery(sql: string): boolean {
  try {
    const stmt = parseStatement(sql);
    return stmt.kind === 'select';
  } catch {
    return false;
  }
}

/**
 * Valide une définition ; rend les codes du § 2.2 (vide : valide), plus `unsupported_column`
 * (précision P3 : une relation entrante). Les contrôles de signature et de taille sont à part
 * (`verifyDefSignature`, `defTooLarge`).
 */
export function validateDef(raw: unknown, ctx: DefContext = {}): DefCode[] {
  const codes = new Set<DefCode>();
  if (!isObj(raw)) return ['bad_version'];
  const def = raw as unknown as ExtSourceDef;
  if (def.v !== 1) codes.add('bad_version');
  if (typeof def.id !== 'string' || !/^xs_[A-Za-z0-9_-]{22}$/.test(def.id)) codes.add('bad_id');
  if (typeof def.name !== 'string' || def.name.trim().length < 1 || def.name.length > 60) codes.add('bad_name');
  if (!CONNECTORS.includes(def.connector)) {
    codes.add('bad_connector');
    return [...codes];
  }
  if (!connOk(def)) codes.add('bad_conn');
  else {
    const expected = expectedHost(def);
    if (!expected || typeof def.host !== 'string' || def.host !== expected) codes.add('host_mismatch');
    if ((def.connector === 'supabase' || def.connector === 'url') && expected && !httpsHostAllowed(expected)) codes.add('host_forbidden');
    if ((def.connector === 'postgres' || def.connector === 'mysql') && def.conn.tls === 'off-local' && !isLocalHost(String(def.conn.host))) {
      codes.add('tls_off_not_local');
    }
  }
  const mode = def.mode;
  if (!['once', 'mirror', 'publish', 'both'].includes(mode)) codes.add('dir_forbidden_for_mode');
  const from = def.from as Record<string, unknown> | undefined;
  if (isObj(from) && typeof from.query === 'string') {
    if (!isSelectQuery(from.query)) codes.add('query_not_select');
    if (mode !== 'once' && mode !== 'mirror') codes.add('query_with_write_mode');
  } else if (!isObj(from) || !str(from.table)) codes.add('bad_conn');
  // La clé de ligne
  const keyCols = isObj(def.key) && Array.isArray(def.key.cols) ? def.key.cols : [];
  if (keyCols.length === 0) codes.add('key_missing');
  if (keyCols.length > MAX_KEY_COLS) codes.add('key_too_many');
  const map = Array.isArray(def.map) ? def.map : [];
  if (map.length === 0) codes.add('map_empty');
  for (const k of keyCols) if (!map.some((m) => m.col === k)) codes.add('key_not_mapped');
  // Le repère
  if (def.marker !== null && def.marker !== undefined) {
    if (!isObj(def.marker) || !str(def.marker.col) || !['iso', 'epoch_ms', 'epoch_s', 'int'].includes(String(def.marker.kind))) codes.add('marker_bad_kind');
  }
  const timeMarker = isObj(def.marker) && ['iso', 'epoch_ms', 'epoch_s'].includes(String(def.marker.kind));
  // Les politiques (révision A2 : aucune par défaut)
  if (def.conflict !== undefined && !POLICIES.includes(def.conflict)) codes.add('bad_policy');
  if (def.rowConflict !== undefined && !['delete', 'keep', 'ask'].includes(def.rowConflict)) codes.add('bad_policy');
  const props = new Set<string>();
  const cols = new Set<string>();
  for (const m of map) {
    if (!isObj(m) || !str(m.col) || !str(m.prop)) {
      codes.add('map_empty');
      continue;
    }
    if (props.has(m.prop)) codes.add('map_duplicate_prop');
    if (cols.has(m.col)) codes.add('map_duplicate_col');
    props.add(m.prop);
    cols.add(m.col);
    const isKey = keyCols.includes(m.col);
    if ((mode === 'publish' && m.dir === 'in' && !isKey) || (mode === 'mirror' && m.dir !== 'in')) codes.add('dir_forbidden_for_mode');
    if (!['in', 'out', 'both'].includes(m.dir)) codes.add('dir_forbidden_for_mode');
    if (isKey && m.dir !== 'in') codes.add('dir_forbidden_for_mode');
    const type = ctx.propTypes?.[m.prop] ?? m.type;
    if (!MAPPABLE.has(String(type))) codes.add('type_unmappable');
    if (COMPUTED.has(String(type)) && m.dir !== 'out') codes.add('computed_prop_inbound');
    // Précision P3 : une relation ENTRANTE n'est pas prise en charge en v1 (la définition ne nomme
    // pas la base visée) ; la colonne est refusée, jamais importée en texte en silence
    if (String(type) === 'relation' && m.dir !== 'out') codes.add('unsupported_column');
    if (m.conflict !== undefined && !POLICIES.includes(m.conflict)) codes.add('bad_policy');
    if (m.askPending !== undefined && m.askPending !== 'apply' && m.askPending !== 'keep') codes.add('ask_pending_bad');
    const policy = m.conflict ?? def.conflict;
    if (policy === 'latest' && !timeMarker) codes.add('latest_without_time_marker');
    if (mode === 'both' && m.dir === 'both' && m.conflict === undefined && def.conflict === undefined) codes.add('conflict_policy_missing');
  }
  if (mode === 'both' && def.rowConflict === undefined) codes.add('row_conflict_missing');
  // L'exécutant
  const runner = def.runner as Record<string, unknown> | undefined;
  if (!isObj(runner) || !['gate', 'hosted', 'device'].includes(String(runner.kind))) codes.add('runner_unsupported');
  else if (runner.kind === 'hosted' && (def.connector === 'postgres' || def.connector === 'mysql')) codes.add('runner_unsupported');
  if (def.connector === 'url' && mode !== 'once' && mode !== 'mirror') codes.add('dir_forbidden_for_mode');
  // La fréquence
  if (!isObj(def.schedule) || !EVERY.has(String(def.schedule.every))) codes.add('schedule_too_fast');
  if (defTooLarge(def)) codes.add('too_large');
  return [...codes].sort();
}

/** JSON ≤ 16 Kio. */
export function defTooLarge(def: unknown): boolean {
  return utf8Encode(JSON.stringify(def)).length > DEF_MAX_BYTES;
}

/** Le message signé : `filarr/extsrc/v1|def|` + JSON canonique de la définition SANS `sig`. */
export function defSigningMessage(def: ExtSourceDef): Uint8Array {
  const rest: Record<string, unknown> = { ...def };
  delete rest.sig;
  return utf8Encode(`filarr/extsrc/v1|def|${canonicalJson(rest)}`);
}

/** Signe une définition avec la clé d'identité (Ed25519, 32 octets) du compte signataire. */
export function signDef(curves: AccessCurves, def: ExtSourceDef, signingKey: Uint8Array): ExtSourceDef {
  const rest = { ...def };
  delete rest.sig;
  return { ...rest, sig: toBase64Url(curves.ed25519Sign(signingKey, defSigningMessage(rest))) };
}

/** Vrai si `sig` est la signature de la définition par la clé publique (base64 standard). */
export function verifyDefSignature(curves: AccessCurves, def: ExtSourceDef, signerPublicKey: string): boolean {
  if (typeof def.sig !== 'string') return false;
  try {
    const sig = fromBase64Url(def.sig);
    const pub = fromBase64Std(signerPublicKey);
    if (sig.length !== 64 || pub.length !== 32) return false;
    return curves.ed25519Verify(sig, defSigningMessage(def), pub);
  } catch {
    return false;
  }
}

/** La politique d'une colonne : la sienne, sinon celle de la définition. */
export const policyOf = (def: ExtSourceDef, col: string): Policy | null => {
  const m = def.map.find((x) => x.col === col);
  return m?.conflict ?? def.conflict ?? null;
};
