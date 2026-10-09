/** Le journal de la console. Jamais un jeton, une clé ni une ligne. */

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const envLevel = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.FILARR_GATE_LOG_LEVEL;
let threshold: Level = envLevel !== undefined && envLevel in ORDER ? (envLevel as Level) : 'info';
let silent = false;

/** Où écrire une ligne (la console d'office ; `filarr-gate` écrit sur stdout et stderr). */
let writer: (level: Level, line: string) => void = (level, line) => {
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
};

export function setLogLevel(level: Level | 'silent'): void {
  if (level === 'silent') silent = true;
  else {
    silent = false;
    threshold = level;
  }
}

export function setLogWriter(fn: (level: Level, line: string) => void): void {
  writer = fn;
}

function write(level: Level, message: string): void {
  if (silent || ORDER[level] < ORDER[threshold]) return;
  writer(level, `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`);
}

export const log = {
  debug: (m: string) => write('debug', m),
  info: (m: string) => write('info', m),
  warn: (m: string) => write('warn', m),
  error: (m: string) => write('error', m),
};
