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
import { parseToml, resolveSettings, type SettingKey, type Settings, type SettingSource } from '../../server/src/settings';

export { coerce, DEFAULTS, ENV, ENV_NAMES, MIN_POLL_SECONDS, parseToml, type SettingKey, type Settings, type SettingSource } from '../../server/src/settings';

export interface LoadedConfig {
  settings: Settings;
  sources: Record<SettingKey, SettingSource>;
  stateDir: string;
  configFile: string | null;
  /** Le jeton donné par l'environnement : jamais écrit sur le disque. */
  tokenFromEnv: string | null;
  adminPasswordFromEnv: string | null;
  /** Clés de bases externes données par `gate.toml` (`[extdb."xs_…"] secret = "…"`), par définition. */
  extdbSecrets: Record<string, string>;
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
  const { settings, sources } = resolveSettings(saved, env, file);
  return {
    settings,
    sources,
    stateDir,
    configFile,
    tokenFromEnv: env.FILARR_GATE_TOKEN?.trim() || null,
    adminPasswordFromEnv: env.FILARR_GATE_ADMIN_PASSWORD || null,
    extdbSecrets: Object.fromEntries(
      Object.entries(file)
        .filter(([k, v]) => /^extdb.xs_[A-Za-z0-9_-]+.secret$/.test(k) && typeof v === 'string')
        .map(([k, v]) => [k.slice('extdb.'.length, -'.secret'.length), v as string])
    ),
  };
}
