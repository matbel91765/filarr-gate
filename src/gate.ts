/**
 * La boîte noire assemblée : état, réplique, API locale, webhooks, MCP,
 * métriques, et l'interface de gestion (sur son propre port, local d'office).
 */

import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttp, type Server } from 'node:http';
import { createServer as createHttps } from 'node:https';
import type { AddressInfo } from 'node:net';
import { AdminApi } from './admin/api';
import { ApiServer } from './api/server';
import { KeyRegistry } from './api/keys';
import { McpServer } from './api/mcp';
import { GateModel } from './api/model';
import { WebhookService, type WebhookOptions } from './api/webhooks';
import { Writer } from './api/write';
import { coerce, loadConfig, type LoadedConfig, type SettingKey, type Settings } from './config';
import { Journal } from './journal';
import { log } from './log';
import { Metrics } from './metrics';
import { DiskBlockCache, MemoryBlockCache, type BlockCache } from './replica/blockCache';
import { Replicator } from './replica/replicator';
import { openToken } from './replica/token';
import { StateStore } from './state';
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

export class Gate {
  config: LoadedConfig;
  readonly state: StateStore;
  readonly journal: Journal;
  readonly metrics = new Metrics();
  readonly replicator: Replicator;
  readonly model: GateModel;
  readonly keys: KeyRegistry;
  readonly webhooks: WebhookService;
  readonly mcp: McpServer;
  readonly writer: Writer;
  readonly api: ApiServer;
  readonly admin: AdminApi;
  readonly version = GATE_VERSION;
  readonly cache: BlockCache;
  /** D'où vient le jeton en usage. */
  tokenSource: 'env' | 'state' | null = null;
  /** Code à usage unique, demandé pour la mise en route depuis une autre machine que celle-ci. */
  readonly setupCode = String(randomInt(100_000, 1_000_000));
  private apiHttp: Server | null = null;
  private adminHttp: Server | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: GateOptions = {}) {
    const env = opts.env ?? process.env;
    const first = loadConfig({}, env, opts.stateDir);
    this.state = new StateStore(first.stateDir);
    this.config = loadConfig(this.state.data.settings, env, first.stateDir);
    const s = this.config.settings;
    this.journal = new Journal(this.state.journalDir, s.journalDays);
    this.cache = s.cache === 'disk' ? new DiskBlockCache(this.state.blocksDir) : new MemoryBlockCache();
    this.replicator = new Replicator({
      apiUrl: s.apiUrl,
      version: this.version,
      cache: this.cache,
      site: this.state.data.siteId,
      journal: this.journal,
      pollIntervalMs: opts.replicaTiming?.pollIntervalMs ?? s.pollSeconds * 1000,
      ...(opts.replicaTiming?.backoffMinMs !== undefined ? { backoffMinMs: opts.replicaTiming.backoffMinMs } : {}),
      ...(opts.replicaTiming?.backoffMaxMs !== undefined ? { backoffMaxMs: opts.replicaTiming.backoffMaxMs } : {}),
      ...(opts.replicaTiming?.pausedRetryMs !== undefined ? { pausedRetryMs: opts.replicaTiming.pausedRetryMs } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    this.model = new GateModel(this.replicator, this.state);
    this.keys = new KeyRegistry(this.state);
    this.webhooks = new WebhookService(this.state, this.model, this.journal, this.metrics, opts.webhooks);
    this.mcp = new McpServer(this.model, this.version);
    this.writer = new Writer(this.model, this.replicator, () => this.settings.write);
    this.api = new ApiServer({
      model: this.model,
      replicator: this.replicator,
      keys: this.keys,
      journal: this.journal,
      metrics: this.metrics,
      state: this.state,
      mcp: this.mcp,
      writer: this.writer,
      version: this.version,
      settings: () => this.settings,
      publicUrl: () => this.publicUrl(),
    });
    this.admin = new AdminApi(this);
    this.wire();
  }

  get settings(): Settings {
    return this.config.settings;
  }

  /** L'adresse de l'API locale, telle qu'on la donne aux logiciels. */
  publicUrl(): string {
    const s = this.settings;
    const scheme = s.tlsCert && s.tlsKey ? 'https' : 'http';
    const host = s.host === '0.0.0.0' || s.host === '::' ? 'localhost' : s.host;
    const port = this.apiHttp ? ((this.apiHttp.address() as AddressInfo | null)?.port ?? s.port) : s.port;
    return `${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}`;
  }

  adminUrl(): string {
    const s = this.settings;
    const host = s.adminHost === '0.0.0.0' || s.adminHost === '::' ? 'localhost' : s.adminHost;
    const port = this.adminHttp ? ((this.adminHttp.address() as AddressInfo | null)?.port ?? s.adminPort) : s.adminPort;
    return `http://${host.includes(':') ? `[${host}]` : host}:${port}/admin/`;
  }

  private wire(): void {
    const m = this.metrics;
    m.describe('filarr_gate_requests_total', 'counter', 'Requêtes servies par l’API locale');
    m.describe('filarr_gate_request_duration_seconds', 'histogram', 'Durée des requêtes servies');
    m.describe('filarr_gate_webhook_deliveries_total', 'counter', 'Livraisons de webhooks');
    m.describe('filarr_gate_filarr_requests_total', 'counter', 'Requêtes envoyées à Filarr');
    m.describe('filarr_gate_rows_changed_total', 'counter', 'Lignes changées, par base');
    this.replicator.on('change', (base, diff) => {
      const slug = base.manifest?.slug ?? base.storeId;
      m.inc('filarr_gate_rows_changed_total', { base: slug }, diff.created.length + diff.updated.length + diff.deleted.length);
      this.webhooks.onChange(base, diff);
    });
    this.replicator.on('quota', (alert) => this.webhooks.onQuota(alert));
    this.replicator.on('exchange', (info: { status: number; path: string; code?: string }) => {
      if (info.status === 0 && info.code === undefined) return;
      m.inc('filarr_gate_filarr_requests_total', { code: String(info.status) });
      if (info.status === 409 && info.path.endsWith('/commit')) m.inc('filarr_gate_commit_conflicts_total');
      if (info.status === 200 && info.path.endsWith('/commit')) m.inc('filarr_gate_commits_total');
    });
    this.replicator.on('link', (state: string, detail: string | null) => log.info(`liaison avec Filarr : ${state}${detail ? ` (${detail})` : ''}`));
    m.gauge(() => {
      const out: Array<{ name: string; help: string; labels?: Record<string, string>; value: number }> = [];
      out.push({ name: 'filarr_gate_link_up', help: 'Liaison avec Filarr en direct ou en relève (1)', value: ['live', 'polling'].includes(this.replicator.link) ? 1 : 0 });
      for (const b of this.replicator.bases.values()) {
        const labels = { base: b.manifest?.slug ?? b.storeId };
        out.push({ name: 'filarr_gate_base_rows', help: 'Lignes vivantes, par base', labels, value: b.mirror.rows.length });
        out.push({ name: 'filarr_gate_base_version', help: 'Version (seq) servie, par base', labels, value: b.mirror.seq });
        out.push({ name: 'filarr_gate_base_ready', help: 'Base complète et vérifiée (1)', labels, value: b.mirror.status === 'ready' ? 1 : 0 });
      }
      const q = this.replicator.client?.quota;
      for (const name of ['sync', 'bytes', 'writes'] as const) {
        const c = q?.[name];
        if (c) {
          out.push({ name: 'filarr_gate_quota_used', help: 'Consommation chez Filarr (X-Filarr-Quota)', labels: { name }, value: c.used });
          out.push({ name: 'filarr_gate_quota_max', help: 'Limite chez Filarr (X-Filarr-Quota)', labels: { name }, value: c.max });
        }
      }
      return out;
    });
  }

  // ==================== Le jeton ====================

  get hasToken(): boolean {
    return this.tokenSource !== null;
  }

  /**
   * Démarre la réplique avec un jeton ; `persist` le range (0600). Avec `requireAccepted`,
   * un jeton que Filarr refuse (inconnu, révoqué, expiré) lève et n'est pas gardé.
   */
  async useToken(token: string, persist: boolean, requireAccepted = false): Promise<void> {
    await openToken(token); // lève si ce n'est pas un jeton
    await this.replicator.start(token);
    if (requireAccepted && ['unknown_access', 'revoked', 'expired'].includes(this.replicator.link)) {
      const detail = this.replicator.linkDetail ?? this.replicator.link;
      await this.replicator.forget();
      throw new Error(detail);
    }
    if (persist) {
      this.state.writeToken(token);
      this.tokenSource = 'state';
    } else {
      this.tokenSource = 'env';
    }
    this.journal.add({ kind: 'admin', who: 'administration', what: 'jeton en service', code: this.replicator.link, note: this.replicator.identity?.hint ?? '' });
  }

  // ==================== Réglages ====================

  /** Change des réglages (ceux que l'environnement ou le fichier ne verrouillent pas). */
  async updateSettings(patch: Partial<Record<SettingKey, unknown>>): Promise<{ restarted: boolean }> {
    const locked: string[] = [];
    const next: Partial<Settings> = { ...this.state.data.settings };
    for (const [k, v] of Object.entries(patch) as Array<[SettingKey, unknown]>) {
      if (!(k in this.config.settings)) continue;
      const source = this.config.sources[k];
      if (source === 'env' || source === 'file') {
        if (JSON.stringify(coerce(k, v)) !== JSON.stringify(this.config.settings[k])) locked.push(k);
        continue;
      }
      (next as Record<string, unknown>)[k] = coerce(k, v);
    }
    if (locked.length > 0) throw new Error(`Réglages fixés par l'environnement ou gate.toml : ${locked.join(', ')}`);
    const before = this.settings;
    const previous = { ...this.state.data.settings };
    this.state.data.settings = next;
    this.state.saveNow();
    this.config = loadConfig(next, this.opts.env ?? process.env, this.state.dir);
    this.journal.retentionDays = this.settings.journalDays;
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
        this.config = loadConfig(previous, this.opts.env ?? process.env, this.state.dir);
        this.apiHttp = await this.listenApi();
        throw new Error(`L'API locale ne peut pas écouter là : ${(err as Error).message}. Réglages d'avant rétablis.`);
      }
    }
    this.journal.add({ kind: 'admin', who: 'administration', what: 'réglages enregistrés', code: 'ok', note: Object.keys(patch).join(', ') });
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
    const server =
      s.tlsCert && s.tlsKey
        ? (createHttps({ cert: readFileSync(s.tlsCert), key: readFileSync(s.tlsKey) }, this.api.handle) as unknown as Server)
        : createHttp(this.api.handle);
    server.headersTimeout = 30_000;
    server.requestTimeout = 120_000;
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

  async start(): Promise<void> {
    if (this.opts.listen !== false) {
      this.apiHttp = await this.listenApi();
      const adminServer = createHttp(this.admin.handle);
      this.adminHttp = await this.listenOn(adminServer, this.settings.adminPort, this.settings.adminHost);
      log.info(`Interface de gestion : ${this.adminUrl()}`);
    }
    await this.journal.prune();
    this.pruneTimer = setInterval(() => void this.journal.prune(), 6 * 3_600_000);
    this.pruneTimer.unref?.();
    const token = this.config.tokenFromEnv ?? this.state.readToken();
    if (token) {
      try {
        await this.useToken(token, false);
        this.tokenSource = this.config.tokenFromEnv ? 'env' : 'state';
      } catch (err) {
        log.error(`jeton refusé : ${(err as Error).message}`);
      }
    }
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

  /** Oublie cette machine : copie, clés dérivées, jeton, réglages et journal. */
  async forget(): Promise<void> {
    await this.replicator.forget();
    this.webhooks.clearQueue();
    await this.journal.clear();
    this.state.wipe();
    this.tokenSource = this.config.tokenFromEnv ? 'env' : null;
  }

  async stop(): Promise<void> {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.webhooks.stop();
    await this.replicator.stop();
    if (this.apiHttp) await this.closeServer(this.apiHttp);
    if (this.adminHttp) await this.closeServer(this.adminHttp);
    this.apiHttp = null;
    this.adminHttp = null;
    this.state.saveNow();
    await this.journal.flushed();
  }
}
