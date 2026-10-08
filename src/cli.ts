#!/usr/bin/env node
/**
 * `filarr-gate` — la ligne de commande de la boîte noire.
 *
 *   filarr-gate [serve]                 démarre (API locale + interface de gestion)
 *   filarr-gate init --token flr_live_… [--port 8443] [--host 0.0.0.0] [--admin-password …]
 *   filarr-gate keys create --name ERP [--sql] [--mcp] [--rate 600]
 *   filarr-gate mcp [--gate http://127.0.0.1:8443] [--key gk_…]   serveur MCP sur stdio
 *   filarr-gate version
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createInterface } from 'node:readline';
import { coerce, defaultStateDir, loadConfig, type SettingKey } from './config';
import { Gate } from './gate';
import { log } from './log';
import { parseAccessToken } from './core/engine/store/apiAccess';
import { KeyRegistry } from './api/keys';
import { StateStore } from './state';
import { GATE_VERSION } from './version';

function parseArgs(argv: string[]): { command: string[]; flags: Record<string, string | true> } {
  const command: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
      if (inline !== undefined) flags[k] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) flags[k] = argv[(i += 1)]!;
      else flags[k] = true;
    } else command.push(a);
  }
  return { command, flags };
}

const HELP = `Filarr Gate ${GATE_VERSION} — une base Filarr servie comme une API, chez vous.

  filarr-gate [serve]            démarre l'API locale et l'interface de gestion
  filarr-gate init --token flr_live_… [--host 127.0.0.1] [--port 8443]
                   [--admin-host 127.0.0.1] [--admin-port 8787] [--api-url URL]
                   [--admin-password MOT_DE_PASSE] [--write]
                                 range le jeton (droits 0600) et les réglages, puis s'arrête
  filarr-gate keys create --name NOM [--sql] [--mcp] [--rate 600] [--days 90]
                                 crée une clé d'application en lecture sur toutes les vues
  filarr-gate mcp [--gate http://127.0.0.1:8443] [--key gk_…]
                                 serveur MCP sur stdio, relayé vers une boîte noire en marche
  filarr-gate health             sonde /health de l'API locale (HEALTHCHECK de Docker)
  filarr-gate version

Répertoire d'état : FILARR_GATE_STATE_DIR (d'office ${defaultStateDir()}).
Variables : FILARR_GATE_TOKEN, FILARR_GATE_API_URL, FILARR_GATE_HOST, FILARR_GATE_PORT,
FILARR_GATE_ADMIN_HOST, FILARR_GATE_ADMIN_PORT, FILARR_GATE_ADMIN_PASSWORD, FILARR_GATE_WRITE,
FILARR_GATE_TLS_CERT, FILARR_GATE_TLS_KEY, FILARR_GATE_CORS_ORIGINS, FILARR_GATE_TRUST_PROXY,
FILARR_GATE_METRICS, FILARR_GATE_MCP, FILARR_GATE_DOCS, FILARR_GATE_JOURNAL_DAYS,
FILARR_GATE_CACHE, FILARR_GATE_POLL_SECONDS, FILARR_GATE_CONFIG (gate.toml).
`;

async function serve(): Promise<void> {
  // Une promesse oubliée ne fait pas tomber la boîte noire : elle est journalisée
  process.on('unhandledRejection', (reason) => log.error(`promesse rejetée sans suite : ${(reason as Error)?.message ?? String(reason)}`));
  const gate = new Gate();
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`arrêt (${signal})`);
    await gate.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  await gate.start();
}

async function init(flags: Record<string, string | true>): Promise<void> {
  const token = typeof flags.token === 'string' ? flags.token : process.env.FILARR_GATE_TOKEN;
  if (!token || !parseAccessToken(token)) throw new Error('--token flr_live_… attendu (un jeton Filarr valide)');
  const state = new StateStore(defaultStateDir());
  const map: Record<string, SettingKey> = {
    host: 'host',
    port: 'port',
    'admin-host': 'adminHost',
    'admin-port': 'adminPort',
    'api-url': 'apiUrl',
    write: 'write',
  };
  for (const [flag, key] of Object.entries(map)) {
    if (flags[flag] !== undefined) (state.data.settings as Record<string, unknown>)[key] = coerce(key, flags[flag] === true ? 'true' : flags[flag]);
  }
  if (typeof flags['admin-password'] === 'string') {
    if (flags['admin-password'].length < 10) throw new Error('--admin-password : dix caractères au moins');
    state.data.admin.passwordHash = await StateStore.hashPassword(flags['admin-password']);
  }
  state.writeToken(token);
  state.saveNow();
  const cfg = loadConfig(state.data.settings);
  process.stdout.write(`Jeton rangé dans ${state.dir} (droits 0600).\nAPI locale : ${cfg.settings.host}:${cfg.settings.port} · interface : http://${cfg.settings.adminHost}:${cfg.settings.adminPort}/admin/\nDémarrez : filarr-gate\n`);
}

function keysCreate(flags: Record<string, string | true>): void {
  const name = typeof flags.name === 'string' ? flags.name : '';
  if (!name) throw new Error('--name attendu');
  const state = new StateStore(defaultStateDir());
  const days = typeof flags.days === 'string' ? Number(flags.days) : 0;
  const { record, key } = new KeyRegistry(state).create({
    name,
    scopes: [{ target: 'all', read: true }],
    sql: flags.sql === true,
    mcp: flags.mcp === true,
    rateLimit: typeof flags.rate === 'string' ? Number(flags.rate) : 600,
    expiresAt: days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
  });
  process.stdout.write(`Clé « ${record.name} » (lecture de toutes les vues${record.sql ? ', SQL' : ''}${record.mcp ? ', MCP' : ''}) :\n\n  ${key}\n\nElle ne sera plus montrée. Redémarrez la boîte noire si elle tourne.\n`);
}

/** Sonde de santé (HEALTHCHECK de Docker) : `/health` de l'API locale, sur cette machine. */
function health(): Promise<void> {
  const { settings } = loadConfig({});
  const tls = Boolean(settings.tlsCert && settings.tlsKey);
  const req = (tls ? httpsRequest : httpRequest)(
    { host: '127.0.0.1', port: settings.port, path: '/health', method: 'GET', timeout: 4000, ...(tls ? { rejectUnauthorized: false } : {}) },
    (res) => {
      res.resume();
      process.exit(res.statusCode === 200 ? 0 : 1);
    }
  );
  req.on('error', () => process.exit(1));
  req.on('timeout', () => process.exit(1));
  req.end();
  return new Promise(() => undefined);
}

/** MCP sur stdio : chaque ligne JSON-RPC part vers `POST /mcp` d'une boîte noire en marche. */
async function mcpStdio(flags: Record<string, string | true>): Promise<void> {
  const gateUrl = (typeof flags.gate === 'string' ? flags.gate : process.env.FILARR_GATE_URL) ?? `http://127.0.0.1:${loadConfig({}).settings.port}`;
  const key = typeof flags.key === 'string' ? flags.key : process.env.FILARR_GATE_KEY;
  if (!key) throw new Error('--key gk_… (ou FILARR_GATE_KEY) attendu : une clé d’application avec le droit MCP');
  const endpoint = new URL('/mcp', gateUrl);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let session: string | null = null;
  for await (const line of rl) {
    if (line.trim() === '') continue;
    let id: unknown = null;
    try {
      id = (JSON.parse(line) as { id?: unknown }).id ?? null;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      continue;
    }
    try {
      const res: Response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${key}`,
          ...(session ? { 'Mcp-Session-Id': session } : {}),
        },
        body: line,
      });
      session = res.headers.get('mcp-session-id') ?? session;
      if (res.status === 202) continue;
      const text = await res.text();
      if (res.ok) process.stdout.write(`${text.trim()}\n`);
      else process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `Filarr Gate : ${res.status} ${text.slice(0, 200)}` } })}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `Filarr Gate injoignable : ${(err as Error).message}` } })}\n`);
    }
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const [cmd = 'serve', sub] = command;
  if (flags.help || cmd === 'help') return void process.stdout.write(HELP);
  switch (cmd) {
    case 'serve':
      return serve();
    case 'init':
      return init(flags);
    case 'keys':
      if (sub === 'create') return keysCreate(flags);
      throw new Error('keys create --name …');
    case 'mcp':
      return mcpStdio(flags);
    case 'health':
      return health();
    case 'version':
      return void process.stdout.write(`${GATE_VERSION}\n`);
    default:
      process.stdout.write(HELP);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  log.error((err as Error).message);
  process.exit(1);
});
