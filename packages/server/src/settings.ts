/**
 * Les réglages de la boîte noire, indépendants du moteur (Node, Workers).
 *
 * Ordre de priorité (appliqué par l'hôte) : variables d'environnement, puis
 * fichier `gate.toml`, puis réglages faits dans l'interface (rangés dans l'état),
 * puis valeurs d'office. Un réglage fixé par l'environnement ou le fichier est
 * VERROUILLÉ : l'interface le montre sans le laisser changer.
 */

import { DEFAULT_DENIED_EXTENSIONS, MAX_FILE_BYTES } from '../../core/src/engine/gate/files';

export interface Settings {
  apiUrl: string;
  host: string;
  port: number;
  adminHost: string;
  adminPort: number;
  /** Écriture vers Filarr (contrat § 7) : éteinte d'office. */
  write: boolean;
  tlsCert: string | null;
  tlsKey: string | null;
  /** Pages web autorisées (CORS) ; vide = toute requête portant une origine est refusée. */
  corsOrigins: string[];
  /** Mandataires dont on croit `X-Forwarded-For`. */
  trustProxy: string[];
  metrics: boolean;
  mcp: boolean;
  docs: boolean;
  journalDays: number;
  cache: 'disk' | 'memory';
  /** Relève sans flux, en secondes : jamais moins de 300 (contrat § 6). */
  pollSeconds: number;
  /** Fente à fichiers : taille maximale d'un fichier déposé (jamais plus de 100 Mio). */
  filesMaxBytes: number;
  /** Fente à fichiers : extensions refusées (d'office, la liste du contrat `gate-fichiers-1` § 3). */
  filesDeny: string[];
  /** Fente à fichiers : si non vide, SEULES ces extensions passent. */
  filesAllow: string[];
  /** Réveils poussés de Filarr (`/_filarr/notify`) : acceptés d'office. */
  notify: boolean;
}

export type SettingKey = keyof Settings;
export type SettingSource = 'env' | 'file' | 'settings' | 'default';

export const DEFAULTS: Settings = {
  apiUrl: 'https://api.filarr.com',
  host: '127.0.0.1',
  port: 8443,
  adminHost: '127.0.0.1',
  adminPort: 8787,
  write: false,
  tlsCert: null,
  tlsKey: null,
  corsOrigins: [],
  trustProxy: [],
  metrics: true,
  mcp: false,
  docs: true,
  journalDays: 30,
  cache: 'disk',
  pollSeconds: 300,
  filesMaxBytes: MAX_FILE_BYTES,
  filesDeny: [...DEFAULT_DENIED_EXTENSIONS],
  filesAllow: [],
  notify: true,
};

/** Le minimum de relève du contrat (§ 6, palier Free). */
export const MIN_POLL_SECONDS = 300;

export const ENV: Record<SettingKey, string> = {
  apiUrl: 'FILARR_GATE_API_URL',
  host: 'FILARR_GATE_HOST',
  port: 'FILARR_GATE_PORT',
  adminHost: 'FILARR_GATE_ADMIN_HOST',
  adminPort: 'FILARR_GATE_ADMIN_PORT',
  write: 'FILARR_GATE_WRITE',
  tlsCert: 'FILARR_GATE_TLS_CERT',
  tlsKey: 'FILARR_GATE_TLS_KEY',
  corsOrigins: 'FILARR_GATE_CORS_ORIGINS',
  trustProxy: 'FILARR_GATE_TRUST_PROXY',
  metrics: 'FILARR_GATE_METRICS',
  mcp: 'FILARR_GATE_MCP',
  docs: 'FILARR_GATE_DOCS',
  journalDays: 'FILARR_GATE_JOURNAL_DAYS',
  cache: 'FILARR_GATE_CACHE',
  pollSeconds: 'FILARR_GATE_POLL_SECONDS',
  filesMaxBytes: 'FILARR_GATE_FILES_MAX_BYTES',
  filesDeny: 'FILARR_GATE_FILES_DENY',
  filesAllow: 'FILARR_GATE_FILES_ALLOW',
  notify: 'FILARR_GATE_NOTIFY',
};

export const TOML: Record<string, SettingKey> = {
  api_url: 'apiUrl',
  host: 'host',
  port: 'port',
  admin_host: 'adminHost',
  admin_port: 'adminPort',
  write: 'write',
  tls_cert: 'tlsCert',
  tls_key: 'tlsKey',
  cors_origins: 'corsOrigins',
  trust_proxy: 'trustProxy',
  metrics: 'metrics',
  mcp: 'mcp',
  docs: 'docs',
  journal_days: 'journalDays',
  cache: 'cache',
  poll_seconds: 'pollSeconds',
  files_max_bytes: 'filesMaxBytes',
  files_deny: 'filesDeny',
  files_allow: 'filesAllow',
  notify: 'notify',
};

export const ENV_NAMES = ENV;

/** Un sous-ensemble de TOML : `clé = valeur` (chaîne, nombre, booléen, tableau de chaînes), `[section]`, commentaires. */
export function parseToml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let section = '';
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (line === '') continue;
    const sec = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (sec) {
      section = `${sec[1]}.`;
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) throw new Error(`gate.toml, ligne ${i + 1} : « ${raw.trim()} » illisible`);
    out[section + kv[1]] = parseTomlValue(kv[2]!.trim(), i + 1);
  }
  return out;
}

function parseTomlValue(v: string, line: number): unknown {
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^"(?:[^"\\]|\\.)*"$/.test(v) || /^'[^']*'$/.test(v)) return v.startsWith('"') ? (JSON.parse(v) as string) : v.slice(1, -1);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((x) => parseTomlValue(x.trim(), line));
  }
  throw new Error(`gate.toml, ligne ${line} : valeur « ${v} » illisible`);
}

const bool = (v: string): boolean => /^(1|true|yes|on|oui)$/i.test(v.trim());
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).filter(Boolean) : String(v).split(',').map((x) => x.trim()).filter(Boolean);

/** Une valeur venue d'une source quelconque, ramenée au type du réglage. */
export function coerce<K extends SettingKey>(key: K, value: unknown): Settings[K] {
  const d = DEFAULTS[key];
  let out: unknown;
  if (typeof d === 'boolean') out = typeof value === 'boolean' ? value : bool(String(value));
  else if (typeof d === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`réglage ${key} : nombre attendu`);
    out = n;
  } else if (Array.isArray(d)) out = list(value);
  else if (key === 'tlsCert' || key === 'tlsKey') out = value === null || value === '' ? null : String(value);
  else if (key === 'cache') out = value === 'memory' ? 'memory' : 'disk';
  else out = String(value);
  if (key === 'pollSeconds') out = Math.max(MIN_POLL_SECONDS, out as number);
  if ((key === 'port' || key === 'adminPort') && (!Number.isInteger(out) || (out as number) < 0 || (out as number) > 65535))
    throw new Error(`réglage ${key} : port invalide`);
  if (key === 'journalDays') out = Math.min(3650, Math.max(1, Math.round(out as number)));
  if (key === 'filesMaxBytes') out = Math.min(MAX_FILE_BYTES, Math.max(0, Math.round(out as number)));
  if (key === 'filesDeny' || key === 'filesAllow')
    out = (out as string[]).map((e) => e.trim().toLowerCase()).filter(Boolean).map((e) => (e.startsWith('.') ? e : `.${e}`));
  if (key === 'apiUrl' && !/^https?:\/\//.test(out as string)) throw new Error('réglage apiUrl : adresse http(s) attendue');
  return out as Settings[K];
}
