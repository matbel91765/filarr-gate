/** Le journal de la console. Jamais un jeton, une clé ni une ligne. */

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = (process.env.FILARR_GATE_LOG_LEVEL as Level) in ORDER ? (process.env.FILARR_GATE_LOG_LEVEL as Level) : 'info';
let silent = false;

export function setLogLevel(level: Level | 'silent'): void {
  if (level === 'silent') silent = true;
  else {
    silent = false;
    threshold = level;
  }
}

function write(level: Level, message: string): void {
  if (silent || ORDER[level] < ORDER[threshold]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  debug: (m: string) => write('debug', m),
  info: (m: string) => write('info', m),
  warn: (m: string) => write('warn', m),
  error: (m: string) => write('error', m),
};
