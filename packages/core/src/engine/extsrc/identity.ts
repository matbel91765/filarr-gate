// Écrit dans filarr-gate (origine) — cœur pur, à recopier tel quel par filarg (lot B2).
/**
 * L'identité des lignes — contrat `source-externe-1` § 3.
 *
 * - `sourceIdentity(def)` : la chaîne canonique de la source (§ 3.1) ;
 * - `canonicalKey(valeurs)` : la clé canonique d'une ligne (§ 3.2) ;
 * - `extRowId(identité, clé)` : l'identifiant d'une ligne CRÉÉE depuis la source
 *   (§ 3.3) — deux appareils ou deux exécutants qui importent la même source
 *   produisent les mêmes lignes.
 *
 * Le hachage est SHA-256, injecté synchrone (`Sha256`) : la planification d'un
 * passage reste une fonction pure et synchrone.
 */

import { canonicalJson } from '../store/canonical';
import { toBase64Url, utf8Encode } from '../store/crypto';
import type { ExtSourceDef } from './types';

/** SHA-256 synchrone, injecté (`@noble/hashes` au bureau, au web et dans la boîte). */
export type Sha256 = (data: Uint8Array) => Uint8Array;

const KEY_SEP = '\u001f';

/** La forme de la table d'une source `query` : `q:` + hex(SHA-256(UTF-8(NFC(requête rognée)))). */
export function queryTag(sha256: Sha256, query: string): string {
  const digest = sha256(utf8Encode(query.trim().normalize('NFC')));
  return `q:${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** § 3.1 : l'identité canonique de la source (minuscules pour les hôtes). */
export function sourceIdentity(def: Pick<ExtSourceDef, 'connector' | 'conn' | 'from'>, sha256: Sha256): string {
  const c = def.conn;
  const from = def.from as { table?: string; query?: string };
  const table = typeof from.query === 'string' ? queryTag(sha256, from.query) : String(from.table ?? '');
  switch (def.connector) {
    case 'd1':
      return `d1|api.cloudflare.com|${String(c.account)}/${String(c.database)}|${table}`;
    case 'postgres':
    case 'mysql': {
      const port = typeof c.port === 'number' ? c.port : def.connector === 'postgres' ? 5432 : 3306;
      const schema = def.connector === 'postgres' ? String(c.schema ?? 'public') : String(c.db);
      return `${def.connector}|${String(c.host).toLowerCase()}:${port}|${String(c.db)}|${schema}.${table}`;
    }
    case 'supabase':
      return `supabase|${new URL(String(c.url)).hostname.toLowerCase()}|${String(c.schema ?? 'public')}.${table}`;
    case 'airtable':
      return `airtable|api.airtable.com|${String(c.base)}|${typeof from.query === 'string' ? table : String(c.table)}`;
    case 'gsheets':
      return `gsheets|sheets.googleapis.com|${String(c.spreadsheet)}|${String(c.tab)}`;
    case 'notion':
      return `notion|api.notion.com|${String(c.database)}`;
    case 'url': {
      const u = new URL(String(c.url));
      u.hash = '';
      return `url|${u.toString()}`;
    }
    default:
      return `${String(def.connector)}|${table}`;
  }
}

export class KeyTypeError extends Error {
  constructor(readonly value: unknown) {
    super('key_bad_type');
    this.name = 'KeyTypeError';
  }
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Un morceau de clé : entier en décimal sans zéro de tête, texte EXACT, UUID en minuscules ; `null` = vide. */
export function keyPart(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new KeyTypeError(value);
    return String(value);
  }
  if (typeof value === 'string') return UUID_RE.test(value) ? value.toLowerCase() : value;
  throw new KeyTypeError(value);
}

/** § 3.2 : la clé canonique (morceaux joints par U+001F), ou `null` si une colonne est vide (ligne ignorée). */
export function canonicalKey(values: readonly unknown[]): string | null {
  const parts: string[] = [];
  for (const v of values) {
    const p = keyPart(v);
    if (p === null) return null;
    parts.push(p);
  }
  return parts.join(KEY_SEP);
}

/** § 3.3 : `ext-` + base64url des 16 premiers octets de SHA-256(`filarr/extsrc/v1|row|` + identité + `|` + clé). */
export function extRowId(sha256: Sha256, identity: string, key: string): string {
  return `ext-${toBase64Url(sha256(utf8Encode(`filarr/extsrc/v1|row|${identity}|${key}`)).slice(0, 16))}`;
}

/** L'empreinte d'une valeur dans le domaine de Filarr : 16 premiers octets de SHA-256 du JSON canonique, base64url. */
export function valueHash(sha256: Sha256, value: unknown): string {
  return toBase64Url(sha256(utf8Encode(canonicalJson(value === undefined ? null : value))).slice(0, 16));
}

/** § 6.12 : l'identifiant d'une entrée de file, CALCULÉ depuis les valeurs (ligne : `col = "#row"`). */
export function queueEntryId(sha256: Sha256, defId: string, key: string, col: string, hS: string, hF: string): string {
  return toBase64Url(sha256(utf8Encode(`${defId}|${key}|${col}|${hS}|${hF}`)).slice(0, 16));
}
