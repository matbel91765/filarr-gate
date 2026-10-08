/**
 * La configuration de la boîte noire.
 *
 * Ordre de priorité : variables d'environnement, puis fichier `gate.toml`, puis
 * réglages faits dans l'interface (rangés dans l'état), puis valeurs d'office.
 * Un réglage fixé par l'environnement ou le fichier est VERROUILLÉ : l'interface
 * le montre sans le laisser changer.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
};

/** Le minimum de relève du contrat (§ 6, palier Free). */
export const MIN_POLL_SECONDS = 300;

const ENV: Record<SettingKey, string> = {
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
};

const TOML: Record<string, SettingKey> = {
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
  if (key === 'apiUrl' && !/^https?:\/\//.test(out as string)) throw new Error('réglage apiUrl : adresse http(s) attendue');
  return out as Settings[K];
}

export interface LoadedConfig {
  settings: Settings;
  sources: Record<SettingKey, SettingSource>;
  stateDir: string;
  configFile: string | null;
  /** Le jeton donné par l'environnement : jamais écrit sur le disque. */
  tokenFromEnv: string | null;
  adminPasswordFromEnv: string | null;
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.FILARR_GATE_STATE_DIR ?? join(homedir(), '.filarr-gate'));
}

export function loadConfig(
  saved: Partial<Settings>,
  env: NodeJS.ProcessEnv = process.env,
  stateDir = defaultStateDir(env)
): LoadedConfig {
  const configFile = env.FILARR_GATE_CONFIG
    ? resolve(env.FILARR_GATE_CONFIG)
    : existsSync(join(stateDir, 'gate.toml'))
      ? join(stateDir, 'gate.toml')
      : null;
  const file: Record<string, unknown> = configFile ? parseToml(readFileSync(configFile, 'utf8')) : {};
  const settings = { ...DEFAULTS };
  const sources = {} as Record<SettingKey, SettingSource>;
  for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
    const tomlKey = Object.entries(TOML).find(([, k]) => k === key)?.[0] ?? key;
    const fromEnv = env[ENV[key]];
    const fromFile = file[tomlKey] ?? file[`gate.${tomlKey}`];
    const fromSaved = saved[key];
    let source: SettingSource = 'default';
    let value: unknown = DEFAULTS[key];
    if (fromEnv !== undefined && fromEnv !== '') {
      source = 'env';
      value = fromEnv;
    } else if (fromFile !== undefined) {
      source = 'file';
      value = fromFile;
    } else if (fromSaved !== undefined) {
      source = 'settings';
      value = fromSaved;
    }
    (settings as Record<SettingKey, unknown>)[key] = coerce(key, value);
    sources[key] = source;
  }
  return {
    settings,
    sources,
    stateDir,
    configFile,
    tokenFromEnv: env.FILARR_GATE_TOKEN?.trim() || null,
    adminPasswordFromEnv: env.FILARR_GATE_ADMIN_PASSWORD || null,
  };
}
