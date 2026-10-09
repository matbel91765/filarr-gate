/**
 * La boîte noire sous Node : le cœur sans moteur (`GateCore`), plus ce que Node
 * apporte — la configuration (environnement, `gate.toml`, interface), l'état en
 * fichiers 0600, le cache des blocs sur le disque, le flux par le paquet `ws`,
 * l'API locale en HTTP ou HTTPS et l'interface de gestion sur son propre port
 * (local d'office).
 */

import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttp, type Server } from 'node:http';
import { createServer as createHttps } from 'node:https';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { MemoryBlockCache, type BlockCache } from '../../gate/src/replica/blockCache';
import { wsPackageOpener, type WsCtor } from '../../gate/src/replica/stream';
import { DiskBlockCache } from '../../gate/src/node/diskCache';
import type { WebhookOptions } from '../../server/src/api/webhooks';
import { GateCore, type GateHost, type GateHostConfig } from '../../server/src/core';
import { Journal } from '../../server/src/journal';
import { log } from '../../server/src/log';
import { StateStore } from '../../server/src/state';
import { coerce, ENV_NAMES, loadConfig, type LoadedConfig, type SettingKey, type Settings } from './config';
import { fileJournalSink, nodeListener, serveUiFile, StateDir, uiRoot } from './node';
import { GATE_VERSION } from './version';

export interface GateOptions {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  fetchImpl?: typeof fetch;
  webhooks?: WebhookOptions;
  /** Pour les essais : intervalles de la réplique. */
  replicaTiming?: { pollIntervalMs?: number; backoffMinMs?: number; backoffMaxMs?: number; pausedRetryMs?: number };
  /** Ne pas ouvrir les ports (essais qui appellent les gestionnaires directement). */
  listen?: boolean;
}

/** L'hôte Node de la boîte : réglages, jeton, fichiers, adresses. */
class NodeHost implements GateHost {
  readonly kind = 'node' as const;
  gate!: Gate;
  private readonly ui = uiRoot();

  constructor(
    readonly files: StateDir,
    private readonly env: NodeJS.ProcessEnv,
    public loaded: LoadedConfig
  ) {}

  config(): GateHostConfig {
    const c = this.loaded;
    return { sources: c.sources, configFile: c.configFile, adminPasswordFromEnv: c.adminPasswordFromEnv, tokenFromEnv: c.tokenFromEnv !== null, envNames: ENV_NAMES };
  }

  settings(): Settings {
    return this.loaded.settings;
  }

  updateSettings(patch: Partial<Record<SettingKey, unknown>>): Promise<{ restarted: boolean }> {
    return this.gate.applyNodeSettings(patch, this.env);
  }

  publicUrl(): string {
    return this.gate.publicUrl();
  }

  adminUrl(): string {
    return this.gate.adminUrl();
  }

  async persistToken(token: string): Promise<void> {
    this.files.writeToken(token);
  }

  async serveAsset(pathname: string): Promise<Response | null> {
    return serveUiFile(this.ui, pathname);
  }

  fileExists(path: string): boolean {
    return existsSync(path);
  }

  async wipe(): Promise<void> {
    this.files.wipe();
  }
}

export class Gate extends GateCore {
  readonly stateFiles: StateDir;
  private readonly nodeHost: NodeHost;
  private apiHttp: Server | null = null;
  private adminHttp: Server | null = null;
  private readonly nodeOpts: GateOptions;

  constructor(opts: GateOptions = {}) {
    const env = opts.env ?? process.env;
    const first = loadConfig({}, env, opts.stateDir);
    const files = new StateDir(first.stateDir);
    const state = new StateStore(files.backend(), files.readState());
    const loaded = loadConfig(state.data.settings, env, first.stateDir);
    const host = new NodeHost(files, env, loaded);
    const s = loaded.settings;
    const cache: BlockCache = s.cache === 'disk' ? new DiskBlockCache(files.blocksDir) : new MemoryBlockCache();
    super({
      host,
      state,
      journal: new Journal(fileJournalSink(files.journalDir), s.journalDays),
      cache,
      version: GATE_VERSION,
      // Le paquet `ws` pose les en-têtes et rend un refus de montée entier (Node 20 compris)
      streamOpener: wsPackageOpener(WebSocket as unknown as WsCtor),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.webhooks ? { webhooks: opts.webhooks } : {}),
      ...(opts.replicaTiming ? { replicaTiming: opts.replicaTiming } : {}),
    });
    this.nodeHost = host;
    this.stateFiles = files;
    this.nodeOpts = opts;
    host.gate = this;
    this.replicator.on('link', (state: string, detail: string | null) => log.info(`liaison avec Filarr : ${state}${detail ? ` (${detail})` : ''}`));
  }

  /** Ce que la configuration dit (environnement, gate.toml, état). */
  get loaded(): LoadedConfig {
    return this.nodeHost.loaded;
  }

  set loaded(value: LoadedConfig) {
    this.nodeHost.loaded = value;
  }

  /** La configuration lue (sources comprises). */
  override get config(): GateHostConfig & Omit<LoadedConfig, 'tokenFromEnv'> {
    return { ...this.loaded, ...this.host.config() };
  }

  /** L'adresse de l'API locale, telle qu'on la donne aux logiciels. */
  override publicUrl(): string {
    const s = this.settings;
    const scheme = s.tlsCert && s.tlsKey ? 'https' : 'http';
    const host = s.host === '0.0.0.0' || s.host === '::' ? 'localhost' : s.host;
    const port = this.apiHttp ? ((this.apiHttp.address() as AddressInfo | null)?.port ?? s.port) : s.port;
    return `${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}`;
  }

  override adminUrl(): string {
    const s = this.settings;
    const host = s.adminHost === '0.0.0.0' || s.adminHost === '::' ? 'localhost' : s.adminHost;
    const port = this.adminHttp ? ((this.adminHttp.address() as AddressInfo | null)?.port ?? s.adminPort) : s.adminPort;
    return `http://${host.includes(':') ? `[${host}]` : host}:${port}/admin/`;
  }

  /**
   * Change des réglages (ceux que l'environnement ou le fichier ne verrouillent
   * pas) ; rouvre l'API locale si l'écoute change, et revient en arrière si le
   * nouveau port est pris.
   */
  async applyNodeSettings(patch: Partial<Record<SettingKey, unknown>>, env: NodeJS.ProcessEnv): Promise<{ restarted: boolean }> {
    const locked: string[] = [];
    const next: Partial<Settings> = { ...this.state.data.settings };
    for (const [k, v] of Object.entries(patch) as Array<[SettingKey, unknown]>) {
      if (!(k in this.loaded.settings)) continue;
      const source = this.loaded.sources[k];
      if (source === 'env' || source === 'file') {
        if (JSON.stringify(coerce(k, v)) !== JSON.stringify(this.loaded.settings[k])) locked.push(k);
        continue;
      }
      (next as Record<string, unknown>)[k] = coerce(k, v);
    }
    if (locked.length > 0) throw new Error(`Réglages fixés par l'environnement ou gate.toml : ${locked.join(', ')}`);
    const before = this.settings;
    const previous = { ...this.state.data.settings };
    this.state.data.settings = next;
    this.state.saveNow();
    this.loaded = loadConfig(next, env, this.stateFiles.dir);
    const after = this.settings;
    const listenerChanged = ['host', 'port', 'tlsCert', 'tlsKey'].some((k) => JSON.stringify(before[k as SettingKey]) !== JSON.stringify(after[k as SettingKey]));
    if (listenerChanged && this.apiHttp) {
      await this.closeServer(this.apiHttp);
      try {
        this.apiHttp = await this.listenApi();
      } catch (err) {
        // Le nouveau port est pris (ou le certificat illisible) : on revient aux réglages d'avant
        this.state.data.settings = previous;
        this.state.saveNow();
        this.loaded = loadConfig(previous, env, this.stateFiles.dir);
        this.apiHttp = await this.listenApi();
        throw new Error(`L'API locale ne peut pas écouter là : ${(err as Error).message}. Réglages d'avant rétablis.`);
      }
    }
    return { restarted: listenerChanged };
  }

  // ==================== Ports ====================

  private listenOn(server: Server, port: number, host: string): Promise<Server> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve(server);
      });
    });
  }

  private async listenApi(): Promise<Server> {
    const s = this.settings;
    const tls = Boolean(s.tlsCert && s.tlsKey);
    const listener = nodeListener((req, conn) => this.api.handle(req, conn), () => (tls ? 'https' : 'http'));
    const server = tls ? (createHttps({ cert: readFileSync(s.tlsCert!), key: readFileSync(s.tlsKey!) }, listener) as unknown as Server) : createHttp(listener);
    server.headersTimeout = 30_000;
    server.requestTimeout = 300_000;
    await this.listenOn(server, s.port, s.host);
    log.info(`API locale : ${this.publicUrl()}`);
    return server;
  }

  private closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  override async start(): Promise<void> {
    if (this.nodeOpts.listen !== false) {
      this.apiHttp = await this.listenApi();
      const adminServer = createHttp(nodeListener((req, conn) => this.admin.handle(req, conn)));
      this.adminHttp = await this.listenOn(adminServer, this.settings.adminPort, this.settings.adminHost);
      log.info(`Interface de gestion : ${this.adminUrl()}`);
    }
    const token = this.loaded.tokenFromEnv ?? this.stateFiles.readToken();
    await super.start(token, this.loaded.tokenFromEnv ? 'env' : token ? 'state' : null);
    if (token && this.replicator.link === 'no_token') log.error('jeton refusé');
    if (!this.admin.setupDone) {
      log.info(`Mise en route : ouvrez ${this.adminUrl()} (depuis une autre machine, code de mise en route ${this.setupCode})`);
    }
  }

  get apiPort(): number {
    return (this.apiHttp?.address() as AddressInfo | null)?.port ?? this.settings.port;
  }

  get adminPort(): number {
    return (this.adminHttp?.address() as AddressInfo | null)?.port ?? this.settings.adminPort;
  }

  override async stop(): Promise<void> {
    await super.stop();
    if (this.apiHttp) await this.closeServer(this.apiHttp);
    if (this.adminHttp) await this.closeServer(this.adminHttp);
    this.apiHttp = null;
    this.adminHttp = null;
  }
}
