/**
 * Un PostgreSQL JETABLE pour les essais : `initdb` dans un dossier temporaire,
 * `pg_ctl start` sur 127.0.0.1 et un port privé, puis `pg_ctl stop`. Rien n'est
 * touché d'une installation existante. Absent de la machine : les essais qui en
 * dépendent sont sautés (et le disent).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.FILARR_TEST_PG_BIN,
  'C:/Program Files/PostgreSQL/17/bin',
  'C:/Program Files/PostgreSQL/16/bin',
  'C:/Program Files/PostgreSQL/15/bin',
  '/usr/lib/postgresql/17/bin',
  '/usr/lib/postgresql/16/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
].filter((x): x is string => !!x);

export function findPgBin(): string | null {
  const exe = process.platform === 'win32' ? '.exe' : '';
  for (const dir of CANDIDATES) if (existsSync(join(dir, `initdb${exe}`)) && existsSync(join(dir, `pg_ctl${exe}`))) return dir;
  return null;
}

export interface TempPostgres {
  host: string;
  port: number;
  user: string;
  password: string;
  db: string;
  stop(): void;
}

export function startPostgres(port: number): TempPostgres | null {
  const bin = findPgBin();
  if (!bin) return null;
  const exe = process.platform === 'win32' ? '.exe' : '';
  const dir = mkdtempSync(join(tmpdir(), 'filarr-gate-pg-'));
  const password = `essai-${Math.random().toString(36).slice(2)}`;
  writeFileSync(join(dir, 'pw'), `${password}\n`);
  execFileSync(join(bin, `initdb${exe}`), ['-D', join(dir, 'data'), '-U', 'gate', '--auth=scram-sha-256', `--pwfile=${join(dir, 'pw')}`, '-E', 'UTF8', '--locale=C'], { stdio: 'ignore' });
  // Hors Windows, le socket Unix va dans le dossier jetable : le dossier par défaut des paquets Debian
  // (/var/run/postgresql) n'est pas inscriptible par un utilisateur ordinaire, celui d'une chaîne d'intégration.
  const socket = process.platform === 'win32' ? '' : ` -c unix_socket_directories=${dir}`;
  try {
    execFileSync(join(bin, `pg_ctl${exe}`), ['-D', join(dir, 'data'), '-o', `-p ${port} -c listen_addresses=127.0.0.1${socket}`, '-l', join(dir, 'pg.log'), '-w', 'start'], { stdio: 'ignore' });
  } catch (e) {
    const log = existsSync(join(dir, 'pg.log')) ? readFileSync(join(dir, 'pg.log'), 'utf8').slice(-2000) : '(pas de journal)';
    throw new Error(`PostgreSQL de test : pg_ctl start a échoué.
${log}`, { cause: e });
  }
  return {
    host: '127.0.0.1',
    port,
    user: 'gate',
    password,
    db: 'postgres',
    stop: () => {
      try {
        execFileSync(join(bin, `pg_ctl${exe}`), ['-D', join(dir, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
      } catch {
        /* déjà arrêté */
      }
    },
  };
}
