#!/usr/bin/env node
/**
 * `filarr-gate` — la ligne de commande de la boîte noire (voir `HELP`).
 *
 * Trois façons d'agir sur une boîte :
 *  - une boîte EN MARCHE sur ce répertoire d'état (`cli.json`) : la commande passe
 *    par son interface de gestion avec le secret de ce canal (depuis cette machine
 *    seulement), et la boîte voit le geste tout de suite ;
 *  - une boîte d'une autre machine (`--remote http://hôte:8787`, mot de passe
 *    d'administration par `--admin-password` ou `FILARR_GATE_ADMIN_PASSWORD`) ;
 *  - sinon la commande ouvre l'état, démarre la réplique le temps du geste (sans
 *    ouvrir de port ni lancer de synchro planifiée), puis s'arrête.
 * `--json` : une sortie JSON lisible par un programme, partout.
 */

import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createInterface } from 'node:readline';
import { parseAccessToken } from '../../core/src/engine/store/apiAccess';
import { KeyRegistry } from '../../server/src/api/keys';
import { setLogLevel, log } from '../../server/src/log';
import { exportForToken, importSealed } from '../../server/src/migration';
import { StateStore, type KeyScope } from '../../server/src/state';
import { envNameFor } from '../../server/src/sync/secrets';
import { runDoctor, type DoctorCheck } from '../../server/src/doctor';
import { coerce, defaultStateDir, ENV_NAMES, loadConfig, type SettingKey } from './config';
import { Gate } from './gate';
import { StateDir, writeSecret } from './node';
import { GATE_VERSION } from './version';

type Flags = Record<string, string | true>;

function parseArgs(argv: string[]): { command: string[]; flags: Flags } {
  const command: string[] = [];
  const flags: Flags = {};
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

export const HELP = `Filarr Gate ${GATE_VERSION} — une base Filarr servie comme une API, chez vous.

Démarrer
  filarr-gate [serve]              démarre l'API locale et l'interface de gestion
  filarr-gate init --token flr_live_… [--host 127.0.0.1] [--port 8443]
                   [--admin-host 127.0.0.1] [--admin-port 8787] [--api-url URL]
                   [--admin-password MOT_DE_PASSE] [--write] [--import FICHIER]
                                   range le jeton (0600) et les réglages, puis s'arrête ;
                                   --import applique un paquet de réglages (migration)
  filarr-gate health               sonde /health de l'API locale (HEALTHCHECK de Docker)
  filarr-gate doctor               diagnostic : horloge, Filarr, jeton, clé du créateur,
                                   clés manquantes, quotas, fichiers, synchros
  filarr-gate version

Clés des applications
  filarr-gate keys create --name NOM [--sql] [--mcp] [--files] [--rate 600] [--days 90]
                                   une clé en lecture de toutes les vues (--files : dépôt de fichiers)
  filarr-gate keys list
  filarr-gate keys revoke ID|PRÉFIXE

Synchros des bases externes
  filarr-gate sources list
  filarr-gate sources key DEF_ID (--secret VALEUR | --stdin | --clear)
  filarr-gate sources run DEF_ID [--ack-guard PASSAGE] [--initial source|filarr]
  filarr-gate sources pause DEF_ID | sources resume DEF_ID

Fichiers
  filarr-gate files test           dépose un petit fichier d'essai dans la boîte de dépôt liée
  filarr-gate files status ID

Migration (paquet de réglages gate-settings-1)
  filarr-gate export --for-token flr_live_… --out FICHIER
                                   scelle les réglages de cette boîte pour la boîte qui prend le relais
  filarr-gate import FICHIER       applique un paquet scellé pour le jeton de cette boîte

Assistants IA
  filarr-gate mcp [--gate http://127.0.0.1:8443] [--key gk_…]
                                   serveur MCP sur stdio, relayé vers une boîte noire en marche

Options communes
  --json                           sortie JSON
  --remote URL                     agir sur une boîte d'une AUTRE machine par son interface de gestion
                                   (avec --admin-password, ou FILARR_GATE_ADMIN_PASSWORD)

Sur la machine d'une boîte en marche (docker exec compris), les commandes passent par elle,
sans mot de passe : la boîte range dans son répertoire d'état (0600) le secret de ce canal.
Sinon, la commande ouvre la boîte le temps du geste, sans port ni synchro planifiée.

Répertoire d'état : FILARR_GATE_STATE_DIR (d'office ${defaultStateDir()}).
Variables : FILARR_GATE_TOKEN, FILARR_GATE_ADMIN_PASSWORD, ${Object.values(ENV_NAMES).filter((n) => n !== 'FILARR_GATE_TOKEN').join(', ')},
FILARR_GATE_CONFIG (gate.toml), FILARR_GATE_EXTDB_<ID> (clé d'une base externe), FILARR_GATE_LOG_LEVEL.
`;

class CliError extends Error {
  constructor(
    message: string,
    readonly exit = 1,
    readonly code = 'error'
  ) {
    super(message);
  }
}

const print = (flags: Flags, data: unknown, text: string): void => {
  process.stdout.write(flags.json ? `${JSON.stringify(data, null, 2)}\n` : text.endsWith('\n') ? text : `${text}\n`);
};

// ==================== Une boîte en marche : son interface de gestion ====================

class Remote {
  private cookie: string | null = null;
  /** `password` : par la connexion de l'interface ; `secret` : le canal de la ligne de commande (cette machine). */
  constructor(
    private readonly base: string,
    private readonly auth: { password: string } | { secret: string }
  ) {}

  private async login(password: string): Promise<void> {
    const res = await fetch(new URL('/admin/api/login', this.base), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gate-Admin': '1' }, body: JSON.stringify({ password }) });
    if (!res.ok) throw new CliError(`connexion refusée par ${this.base} (${res.status})`);
    this.cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? null;
  }

  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    if ('password' in this.auth && !this.cookie) await this.login(this.auth.password);
    let res: Response;
    try {
      res = await fetch(new URL(`/admin/api${path}`, this.base), {
        method,
        headers: {
          ...('secret' in this.auth ? { 'X-Gate-Cli': this.auth.secret } : { Cookie: this.cookie ?? '' }),
          ...(method !== 'GET' ? { 'X-Gate-Admin': '1', 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new CliError(`boîte noire injoignable (${this.base}) : ${(err as Error).message}`);
    }
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new CliError(String(parsed.error ?? `${res.status}`), 1, String(parsed.code ?? 'error'));
    return parsed as T;
  }
}

/**
 * Par où agir : `--remote URL` (avec le mot de passe d'administration) ; sinon la boîte
 * qui tourne sur CE répertoire d'état, par le canal de la ligne de commande ; sinon
 * rien (la commande ouvre la boîte le temps du geste).
 */
function remoteOf(flags: Flags): Remote | null {
  const url = typeof flags.remote === 'string' ? flags.remote : process.env.FILARR_GATE_ADMIN_URL;
  if (url) {
    const password = typeof flags['admin-password'] === 'string' ? flags['admin-password'] : process.env.FILARR_GATE_ADMIN_PASSWORD;
    if (!password) throw new CliError('--admin-password (ou FILARR_GATE_ADMIN_PASSWORD) attendu avec --remote');
    return new Remote(url, { password });
  }
  const running = new StateDir(defaultStateDir()).readCliChannel();
  return running ? new Remote(running.admin, { secret: running.secret }) : null;
}

// ==================== Cette machine : la boîte le temps d'un geste ====================

async function withGate<T>(fn: (gate: Gate) => Promise<T>): Promise<T> {
  setLogLevel('warn');
  const gate = new Gate({ listen: false, sync: { timers: false } });
  await gate.start();
  try {
    if (!gate.hasToken) throw new CliError('aucun jeton : lancez d’abord `filarr-gate init --token flr_live_…`');
    await gate.sync?.scan();
    return await fn(gate);
  } finally {
    await gate.stop();
  }
}

function openState(): { files: StateDir; state: StateStore } {
  const files = new StateDir(defaultStateDir());
  return { files, state: new StateStore(files.backend(), files.readState()) };
}

/** Les réglages rangés par `init` ou l'interface (le port, l'adresse de Filarr…), sans ouvrir la boîte. */
function savedSettings(): Partial<StateStore['data']['settings']> {
  try {
    return openState().state.data.settings;
  } catch {
    return {};
  }
}

// ==================== Commandes ====================

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

async function init(flags: Flags): Promise<void> {
  const token = typeof flags.token === 'string' ? flags.token : process.env.FILARR_GATE_TOKEN;
  if (!token || !parseAccessToken(token)) throw new CliError('--token flr_live_… attendu (un jeton Filarr valide)', 2);
  const { files, state } = openState();
  const running = files.readCliChannel();
  if (running) throw new CliError(`une boîte noire tourne sur ce répertoire (processus ${running.pid}) : arrêtez-la avant init, ou remplacez le jeton dans son interface (${running.admin}/admin/)`);
  const map: Record<string, SettingKey> = { host: 'host', port: 'port', 'admin-host': 'adminHost', 'admin-port': 'adminPort', 'api-url': 'apiUrl', write: 'write' };
  for (const [flag, key] of Object.entries(map)) {
    if (flags[flag] !== undefined) (state.data.settings as Record<string, unknown>)[key] = coerce(key, flags[flag] === true ? 'true' : flags[flag]);
  }
  if (typeof flags['admin-password'] === 'string') {
    if (flags['admin-password'].length < 10) throw new CliError('--admin-password : dix caractères au moins', 2);
    state.data.admin.passwordHash = await StateStore.hashPassword(flags['admin-password']);
  }
  files.writeToken(token);
  state.saveNow();
  await state.flushed();
  let imported: { keys: number; webhooks: number; queries: number } | null = null;
  if (typeof flags.import === 'string') {
    const text = readFileSync(flags.import, 'utf8');
    imported = await withGate((gate) => importSealed(gate, text));
  }
  const cfg = loadConfig(state.data.settings);
  print(
    flags,
    { stateDir: files.dir, api: `${cfg.settings.host}:${cfg.settings.port}`, admin: `http://${cfg.settings.adminHost}:${cfg.settings.adminPort}/admin/`, imported },
    `Jeton rangé dans ${files.dir} (droits 0600).\nAPI locale : ${cfg.settings.host}:${cfg.settings.port} · interface : http://${cfg.settings.adminHost}:${cfg.settings.adminPort}/admin/\n${imported ? `Réglages importés : ${imported.keys} clé(s), ${imported.webhooks} webhook(s), ${imported.queries} requête(s).\n` : ''}Démarrez : filarr-gate`
  );
}

async function keys(sub: string | undefined, args: string[], flags: Flags): Promise<void> {
  const remote = remoteOf(flags);
  if (sub === 'create') {
    const name = typeof flags.name === 'string' ? flags.name : '';
    if (!name) throw new CliError('--name attendu', 2);
    const days = typeof flags.days === 'string' ? Number(flags.days) : 0;
    const scopes: KeyScope[] = [{ target: 'all', read: true }];
    if (flags.files === true) scopes.push({ target: 'files', deposit: true });
    const input = { name, scopes, sql: flags.sql === true, mcp: flags.mcp === true, rateLimit: typeof flags.rate === 'string' ? Number(flags.rate) : 600, expiresAt: days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null };
    let key: string;
    let record: { id: string; name: string; prefix: string };
    if (remote) ({ key, record } = await remote.call<{ key: string; record: { id: string; name: string; prefix: string } }>('POST', '/keys', { ...input, expiresInDays: days || undefined }));
    else {
      const { state } = openState();
      ({ key, record } = new KeyRegistry(state).create(input));
      await state.flushed();
    }
    print(flags, { id: record.id, name: record.name, key }, `Clé « ${record.name} » :\n\n  ${key}\n\nElle ne sera plus montrée.${remote ? '' : ' Redémarrez la boîte noire si elle tourne (ou passez par --remote).'}`);
    return;
  }
  if (sub === 'list') {
    const list = remote
      ? ((await remote.call<{ keys: Array<Record<string, unknown>> }>('GET', '/keys')).keys as Array<{ id: string; name: string; prefix: string; paused: boolean; expiresAt: string | null; lastUsedAt: string | null }>)
      : openState().state.data.keys;
    print(flags, list.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, paused: k.paused, expiresAt: k.expiresAt, lastUsedAt: k.lastUsedAt })), list.length === 0 ? 'Aucune clé.' : list.map((k) => `${k.id}  ${k.prefix.padEnd(14)} ${k.name}${k.paused ? ' (en pause)' : ''}${k.expiresAt ? ` · expire ${k.expiresAt.slice(0, 10)}` : ''}`).join('\n'));
    return;
  }
  if (sub === 'revoke') {
    const ref = args[0];
    if (!ref) throw new CliError('keys revoke ID|PRÉFIXE', 2);
    if (remote) {
      const list = (await remote.call<{ keys: Array<{ id: string; prefix: string }> }>('GET', '/keys')).keys;
      const k = list.find((x) => x.id === ref || x.prefix.startsWith(ref));
      if (!k) throw new CliError(`clé inconnue : ${ref}`);
      await remote.call('DELETE', `/keys/${k.id}`);
      print(flags, { revoked: k.id }, `Clé ${k.prefix} révoquée.`);
      return;
    }
    const { state } = openState();
    const reg = new KeyRegistry(state);
    const k = reg.list().find((x) => x.id === ref || x.prefix.startsWith(ref));
    if (!k || !reg.revoke(k.id)) throw new CliError(`clé inconnue : ${ref}`);
    await state.flushed();
    print(flags, { revoked: k.id }, `Clé ${k.prefix} révoquée.`);
    return;
  }
  throw new CliError('keys create|list|revoke', 2);
}

interface SourceRow {
  defId: string;
  name: string;
  base: string | null;
  connector: string;
  host: string;
  mode: string;
  every: string | null;
  blocked: string | null;
  detail: string | null;
  key: { source: string | null; env: string };
  nextRunAt: string | null;
  lastRunAt: string | null;
  status: { state: string; code: string | null; queue: { n: number } } | null;
}

async function sourcesList(gate: Gate | null, remote: Remote | null): Promise<SourceRow[]> {
  if (remote) return (await remote.call<{ sources: SourceRow[] }>('GET', '/sources')).sources;
  return (gate!.sync?.list() ?? []).map((s) => ({
    defId: s.def.id,
    name: s.def.name,
    base: s.base,
    connector: s.def.connector,
    host: s.def.host,
    mode: s.def.mode,
    every: s.def.schedule?.every ?? null,
    blocked: s.blocked,
    detail: s.detail,
    key: { source: s.keySource, env: envNameFor(s.def.id) },
    nextRunAt: s.record.nextRunAt,
    lastRunAt: s.record.lastRunAt,
    status: s.status ? { state: s.status.state, code: s.status.code, queue: { n: s.status.queue.n } } : null,
  }));
}

async function readStdin(): Promise<string> {
  let out = '';
  for await (const chunk of process.stdin) out += String(chunk);
  return out.trim();
}

async function sources(sub: string | undefined, args: string[], flags: Flags): Promise<void> {
  const remote = remoteOf(flags);
  const run = async <T>(fn: (gate: Gate | null) => Promise<T>): Promise<T> => (remote ? fn(null) : withGate((g) => fn(g)));
  if (sub === 'list' || sub === undefined) {
    const list = await run((g) => sourcesList(g, remote));
    print(
      flags,
      list,
      list.length === 0
        ? 'Aucune synchro ne désigne cette boîte noire.'
        : list.map((s) => `${s.defId}  ${s.name}\n    ${s.connector} · ${s.host} · ${s.mode} · ${s.every ?? '—'} · base ${s.base ?? '—'}\n    ${s.blocked ? `bloquée : ${s.blocked}${s.detail ? ` (${s.detail})` : ''}` : `prête${s.status ? ` · dernier état ${s.status.state}${s.status.code ? ` (${s.status.code})` : ''}` : ''}`}${s.status?.queue.n ? ` · ${s.status.queue.n} conflit(s) à trancher dans Filarr` : ''}\n    clé : ${s.key.source ?? `manquante (${s.key.env})`}`).join('\n')
    );
    return;
  }
  const defId = args[0];
  if (!defId) throw new CliError(`sources ${sub} DEF_ID`, 2);
  if (sub === 'key') {
    let secret: string | null = null;
    if (flags.clear === true) secret = null;
    else if (typeof flags.secret === 'string') secret = flags.secret;
    else if (flags.stdin === true) secret = await readStdin();
    else throw new CliError('--secret VALEUR, --stdin ou --clear', 2);
    await run(async (g) => {
      if (remote) await remote.call('PUT', `/sources/${defId}/key`, { secret });
      else {
        if (!g!.sync?.get(defId)) throw new CliError(`synchro inconnue : ${defId}`);
        await g!.sync.setKey(defId, secret);
        await g!.state.flushed();
      }
    });
    print(flags, { defId, key: secret ? 'set' : 'cleared' }, secret ? 'Clé enregistrée (chiffrée sur cette machine).' : 'Clé retirée.');
    return;
  }
  if (sub === 'run') {
    const ack: Record<string, unknown> = {};
    if (typeof flags['ack-guard'] === 'string') ack.guard = flags['ack-guard'];
    if (flags.initial === 'source' || flags.initial === 'filarr') ack.initial = flags.initial;
    const status = await run(async (g) => {
      if (remote) return (await remote.call<{ status: unknown }>('POST', `/sources/${defId}/run`, { ack })).status;
      if (!g!.sync?.get(defId)) throw new CliError(`synchro inconnue : ${defId}`);
      return g!.sync.runPass(defId, { ack: Object.keys(ack).length ? ack : null });
    });
    const s = status as { state?: string; code?: string | null; question?: unknown } | null;
    print(flags, status, `Passage : ${s?.state ?? '—'}${s?.code ? ` (${s.code})` : ''}${s?.question ? `\nQuestion : ${JSON.stringify(s.question)}` : ''}`);
    if (s?.state === 'error') process.exitCode = 1;
    return;
  }
  if (sub === 'pause' || sub === 'resume') {
    await run(async (g) => {
      if (remote) await remote.call('POST', `/sources/${defId}/pause`, { paused: sub === 'pause' });
      else {
        g!.sync?.pause(defId, sub === 'pause');
        await g!.state.flushed();
      }
    });
    print(flags, { defId, paused: sub === 'pause' }, sub === 'pause' ? 'Synchro mise en pause.' : 'Synchro reprise.');
    return;
  }
  throw new CliError('sources list|key|run|pause|resume', 2);
}

async function files(sub: string | undefined, args: string[], flags: Flags): Promise<void> {
  const remote = remoteOf(flags);
  if (sub === 'test') {
    const out = remote
      ? (await remote.call<{ deposit: Record<string, unknown> }>('POST', '/files/test', {})).deposit
      : await withGate(async (g) => g.files.deposit(new TextEncoder().encode(`Essai de dépôt depuis Filarr Gate, ${new Date().toISOString()}\n`), { name: 'filarr-gate-essai.txt', mimeType: 'text/plain', tags: ['essai'] }, null));
    print(flags, out, `Fichier d'essai déposé : ${String(out.id)} (${String(out.status)}). Votre appli Filarr le rangera.`);
    return;
  }
  if (sub === 'status') {
    const id = args[0];
    if (!id) throw new CliError('files status ID', 2);
    const out = remote
      ? ((await remote.call<{ deposits: Array<Record<string, unknown>> }>('GET', '/files')).deposits.find((d) => d.id === id) ?? null)
      : await withGate(async (g) => g.files.status(id));
    if (!out) throw new CliError(`dépôt inconnu : ${id}`);
    print(flags, out, `${String(out.id)} : ${String(out.status)}${out.filedAt ? ` (rangé ${String(out.filedAt)})` : ''}`);
    return;
  }
  throw new CliError('files test|status', 2);
}

async function exportCmd(flags: Flags): Promise<void> {
  const token = typeof flags['for-token'] === 'string' ? flags['for-token'] : process.env.FILARR_GATE_NEW_TOKEN;
  if (!token || !parseAccessToken(token)) throw new CliError('--for-token flr_live_… attendu : le jeton de la boîte qui prend le relais', 2);
  const out = typeof flags.out === 'string' ? flags.out : null;
  const remote = remoteOf(flags);
  const file = remote ? await remote.call('POST', '/export', { token }) : await withGate((g) => exportForToken(g, token));
  if (out) {
    writeSecret(out, `${JSON.stringify(file, null, 2)}\n`);
    print(flags, { out }, `Paquet de réglages scellé pour le nouveau jeton : ${out}\nSur la nouvelle boîte : filarr-gate init --token <nouveau jeton> --import ${out}`);
  } else process.stdout.write(`${JSON.stringify(file, null, 2)}\n`);
}

async function importCmd(args: string[], flags: Flags): Promise<void> {
  const path = args[0];
  if (!path) throw new CliError('import FICHIER', 2);
  const text = readFileSync(path, 'utf8');
  const remote = remoteOf(flags);
  const out = remote ? await remote.call('POST', '/import', { sealed: text }) : await withGate((g) => importSealed(g, text));
  print(flags, out, `Réglages importés : ${JSON.stringify(out)}`);
}

async function doctor(flags: Flags): Promise<void> {
  const remote = remoteOf(flags);
  let checks: DoctorCheck[];
  if (remote) checks = (await remote.call<{ checks: DoctorCheck[] }>('GET', '/doctor')).checks;
  else {
    const cfg = loadConfig(savedSettings());
    const token = cfg.tokenFromEnv ?? openState().files.readToken();
    if (token && !parseAccessToken(token)) checks = [{ name: 'jeton', result: 'fail', detail: 'le jeton rangé n’est pas un jeton Filarr' }];
    else if (!token) {
      // Sans jeton : Filarr et l'horloge quand même
      setLogLevel('warn');
      const gate = new Gate({ listen: false, sync: { timers: false } });
      checks = await runDoctor(gate);
    } else checks = await withGate((g) => runDoctor(g));
  }
  const bad = checks.some((c) => c.result === 'fail');
  print(flags, { ok: !bad, checks }, checks.map((c) => `${c.result === 'ok' ? 'ok  ' : c.result === 'warn' ? 'warn' : 'FAIL'}  ${c.name.padEnd(22)} ${c.detail}`).join('\n'));
  if (bad) process.exitCode = 1;
}

/** Sonde de santé (HEALTHCHECK de Docker) : `/health` de l'API locale, sur cette machine. */
function health(): Promise<void> {
  const { settings } = loadConfig(savedSettings());
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
async function mcpStdio(flags: Flags): Promise<void> {
  const gateUrl = (typeof flags.gate === 'string' ? flags.gate : process.env.FILARR_GATE_URL) ?? `http://127.0.0.1:${loadConfig(savedSettings()).settings.port}`;
  const key = typeof flags.key === 'string' ? flags.key : process.env.FILARR_GATE_KEY;
  if (!key) throw new CliError('--key gk_… (ou FILARR_GATE_KEY) attendu : une clé d’application avec le droit MCP', 2);
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
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${key}`, ...(session ? { 'Mcp-Session-Id': session } : {}) },
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
  const [cmd = 'serve', sub, ...rest] = command;
  if (flags.help || cmd === 'help') return void process.stdout.write(HELP);
  switch (cmd) {
    case 'serve':
      return serve();
    case 'init':
      return init(flags);
    case 'keys':
      return keys(sub, rest, flags);
    case 'sources':
      return sources(sub, rest, flags);
    case 'files':
      return files(sub, rest, flags);
    case 'export':
      return exportCmd(flags);
    case 'import':
      return importCmd(sub ? [sub, ...rest] : rest, flags);
    case 'doctor':
      return doctor(flags);
    case 'mcp':
      return mcpStdio(flags);
    case 'health':
      return health();
    case 'version':
      return print(flags, { version: GATE_VERSION }, GATE_VERSION);
    default:
      process.stdout.write(HELP);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.json) process.stdout.write(`${JSON.stringify({ error: (err as Error).message, code: (err as CliError).code ?? 'error' })}\n`);
  else log.error((err as Error).message);
  process.exit(err instanceof CliError ? err.exit : 1);
});
