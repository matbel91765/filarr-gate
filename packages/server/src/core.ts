/**
 * LA BOÎTE NOIRE, sans moteur : la réplique, l'API locale, l'interface de
 * gestion, les clés d'application, les webhooks, le MCP, la fente à fichiers,
 * les réveils poussés, l'export et l'import des réglages (et, plus loin, les
 * synchros externes). Le même code sert :
 *  - `filarr-gate` sous Node (adaptateur HTTP, fichiers 0600, Docker) ;
 *  - la variante Cloudflare (un objet durable qui tient la copie) ;
 *  - plus tard le service hébergé (`gate-heberge-1` § 15 : « le même code »).
 *
 * L'hôte fournit ce qui dépend du moteur (`GateHost`) : réglages et leur
 * source, persistance du jeton, fichiers de l'interface, adresses publiques.
 */

import { fromBase64Std } from '../../core/src/engine/store/apiAccess';
import { readNotifyBody, verifyNotify } from '../../core/src/engine/gate/access3';
import { sealSettingsFor, type GateSettings } from '../../core/src/engine/gate/settings';
import { curves, storeCrypto } from '../../gate/src/crypto/providers';
import { GateModel } from '../../gate/src/data/model';
import { Writer } from '../../gate/src/data/write';
import type { BlockCache } from '../../gate/src/replica/blockCache';
import { Replicator, type ExportRequest } from '../../gate/src/replica/replicator';
import type { StreamOpener } from '../../gate/src/replica/stream';
import { openToken } from '../../gate/src/replica/token';
import { AdminApi } from './admin/api';
import { KeyRegistry } from './api/keys';
import { McpServer } from './api/mcp';
import { ApiServer } from './api/server';
import { WebhookService, type WebhookOptions } from './api/webhooks';
import { FileService } from './files';
import { SyncRunner, type SyncHostOptions } from './sync/runner';
import { json, readBody } from './http';
import { Journal } from './journal';
import { Metrics } from './metrics';
import { applySettingsPackage, buildSettingsPackage } from './migration';
import type { SettingKey, Settings, SettingSource } from './settings';
import type { StateStore } from './state';

export interface GateHostConfig {
  sources: Record<SettingKey, SettingSource>;
  configFile: string | null;
  adminPasswordFromEnv: string | null;
  /** Le jeton vient-il d'une variable de l'hôte (`FILARR_GATE_TOKEN`, secret de Workers) ? */
  tokenFromEnv: boolean;
  envNames: Record<SettingKey, string>;
}

/** Ce que l'hôte (Node, Workers) fournit à la boîte. */
export interface GateHost {
  readonly kind: 'node' | 'cloudflare' | 'memory';
  config(): GateHostConfig;
  settings(): Settings;
  /** Change des réglages (lève sur un réglage verrouillé) ; `restarted` : l'écoute a changé. */
  updateSettings(patch: Partial<Record<SettingKey, unknown>>): Promise<{ restarted: boolean }>;
  /** L'adresse de l'API locale, telle qu'on la donne aux logiciels. */
  publicUrl(): string;
  /** L'adresse de l'interface de gestion. */
  adminUrl(): string;
  /** Range le jeton (0600 sous Node) ; lève là où le jeton n'est qu'un secret de l'hôte. */
  persistToken(token: string): Promise<void>;
  /** Un fichier de l'interface de gestion (`null` : absent). */
  serveAsset(pathname: string): Promise<Response | null>;
  /** Un fichier existe-t-il sur cette machine (certificats TLS) ? */
  fileExists(path: string): boolean;
  /** Oublie ce que l'hôte garde hors de l'état (jeton, cache, journal). */
  wipe(): Promise<void>;
}

export interface GateCoreOptions {
  host: GateHost;
  state: StateStore;
  journal: Journal;
  cache: BlockCache;
  version: string;
  fetchImpl?: typeof fetch;
  streamOpener?: StreamOpener | null;
  webhooks?: WebhookOptions;
  /** Pour les essais : intervalles de la réplique. */
  replicaTiming?: { pollIntervalMs?: number; backoffMinMs?: number; backoffMaxMs?: number; pausedRetryMs?: number };
  /** L'exécutant des synchros externes (source-externe-1) : où ranger les ombres, quels connecteurs. */
  sync?: SyncHostOptions;
  /** `false` : aucune boucle de réplique (hôte qui s'endort entre deux alarmes : objet durable). */
  live?: boolean;
}

const randomCode = (): string => String(100_000 + (globalThis.crypto.getRandomValues(new Uint32Array(1))[0]! % 900_000));

export class GateCore {
  readonly host: GateHost;
  readonly state: StateStore;
  readonly journal: Journal;
  readonly metrics = new Metrics();
  readonly cache: BlockCache;
  readonly replicator: Replicator;
  readonly model: GateModel;
  readonly keys: KeyRegistry;
  readonly webhooks: WebhookService;
  readonly mcp: McpServer;
  readonly writer: Writer;
  readonly files: FileService;
  /** L'exécutant des synchros externes, si l'hôte le fournit. */
  readonly sync: SyncRunner | null;
  readonly api: ApiServer;
  readonly admin: AdminApi;
  readonly version: string;
  /** La réplique tourne-t-elle seule (flux ou relève), ou l'hôte la réveille-t-il ? */
  readonly live: boolean;
  /** D'où vient le jeton en usage. */
  tokenSource: 'env' | 'state' | null = null;
  /** Code à usage unique, demandé pour la mise en route depuis une autre machine que celle-ci. */
  readonly setupCode = randomCode();
  /**
   * Le secret du canal de la ligne de commande : posé par l'hôte qui écoute (rangé 0600 dans le
   * répertoire d'état), il ouvre l'interface de gestion à `filarr-gate keys …` lancé sur CETTE
   * machine par qui peut lire ce répertoire (qui tient déjà le jeton). `null` : canal fermé.
   */
  cliSecret: string | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  /** Les ombres des synchros externes, pour le paquet de réglages (posé par l'exécutant des synchros). */
  syncShadows?: () => GateSettings['extdb'];
  /** Rend des ombres importées à l'exécutant des synchros. */
  restoreSyncShadows?: (list: GateSettings['extdb']) => void;

  constructor(readonly opts: GateCoreOptions) {
    this.host = opts.host;
    this.state = opts.state;
    this.journal = opts.journal;
    this.cache = opts.cache;
    this.version = opts.version;
    this.live = opts.live ?? true;
    const s = this.settings;
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
      ...(opts.streamOpener !== undefined ? { streamOpener: opts.streamOpener } : {}),
    });
    this.model = new GateModel(this.replicator, this.state);
    this.keys = new KeyRegistry(this.state);
    this.webhooks = new WebhookService(this.state, this.model, this.journal, this.metrics, opts.webhooks);
    this.mcp = new McpServer(this.model, this.version);
    this.writer = new Writer(this.model, this.replicator, () => this.settings.write);
    this.files = new FileService(this);
    this.sync = opts.sync ? new SyncRunner(this, opts.sync) : null;
    this.api = new ApiServer(this);
    this.admin = new AdminApi(this);
    this.wire();
  }

  get settings(): Settings {
    return this.host.settings();
  }

  get config(): GateHostConfig {
    return this.host.config();
  }

  publicUrl(): string {
    return this.host.publicUrl();
  }

  adminUrl(): string {
    return this.host.adminUrl();
  }

  get hasToken(): boolean {
    return this.tokenSource !== null;
  }

  private wire(): void {
    const m = this.metrics;
    m.describe('filarr_gate_requests_total', 'counter', 'Requêtes servies par l’API locale');
    m.describe('filarr_gate_request_duration_seconds', 'histogram', 'Durée des requêtes servies');
    m.describe('filarr_gate_webhook_deliveries_total', 'counter', 'Livraisons de webhooks');
    m.describe('filarr_gate_filarr_requests_total', 'counter', 'Requêtes envoyées à Filarr');
    m.describe('filarr_gate_rows_changed_total', 'counter', 'Lignes changées, par base');
    m.describe('filarr_gate_files_total', 'counter', 'Fichiers déposés, refusés avant envoi, ou refusés par Filarr');
    this.replicator.on('change', (base, diff) => {
      const slug = base.manifest?.slug ?? base.storeId;
      m.inc('filarr_gate_rows_changed_total', { base: slug }, diff.created.length + diff.updated.length + diff.deleted.length);
      this.webhooks.onChange(base, diff);
    });
    this.replicator.on('quota', (alert) => this.webhooks.onQuota(alert));
    this.replicator.on('files', (msg: { depositId: string; status: string } | null) => void this.files.onFilesMessage(msg));
    this.replicator.on('export', (req: ExportRequest) => void this.exportTo(req).catch(() => undefined));
    this.replicator.on('exchange', (info: { status: number; path: string; code?: string }) => {
      if (info.status === 0 && info.code === undefined) return;
      m.inc('filarr_gate_filarr_requests_total', { code: String(info.status) });
      if (info.status === 409 && info.path.endsWith('/commit')) m.inc('filarr_gate_commit_conflicts_total');
      if (info.status === 200 && info.path.endsWith('/commit')) m.inc('filarr_gate_commits_total');
    });
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

  /**
   * Démarre la réplique avec un jeton ; `persist` le range chez l'hôte. Avec
   * `requireAccepted`, un jeton que Filarr refuse (inconnu, révoqué, expiré) lève
   * et n'est pas gardé. `live: false` : aucune boucle (objet durable).
   */
  async useToken(token: string, persist: boolean, requireAccepted = false, live = this.live): Promise<void> {
    await openToken(token); // lève si ce n'est pas un jeton
    await this.replicator.start(token, { live });
    if (requireAccepted && ['unknown_access', 'revoked', 'expired'].includes(this.replicator.link)) {
      const detail = this.replicator.linkDetail ?? this.replicator.link;
      await this.replicator.forget();
      throw new Error(detail);
    }
    if (persist) {
      await this.host.persistToken(token);
      this.tokenSource = 'state';
    } else {
      this.tokenSource = 'env';
    }
    this.journal.add({ kind: 'admin', who: 'administration', what: 'jeton en service', code: this.replicator.link, note: this.replicator.identity?.hint ?? '' });
    // Une identité en attente lit son paquet de réglages dès qu'il est là (migration, § 8.4)
    if (this.replicator.link === 'pending') void this.importPending().catch(() => undefined);
  }

  // ==================== Réglages ====================

  async updateSettings(patch: Partial<Record<SettingKey, unknown>>): Promise<{ restarted: boolean }> {
    const out = await this.host.updateSettings(patch);
    this.journal.retentionDays = this.settings.journalDays;
    this.journal.add({ kind: 'admin', who: 'administration', what: 'réglages enregistrés', code: 'ok', note: Object.keys(patch).join(', ') });
    return out;
  }

  // ==================== Réveils poussés (api-base-1 rév. 3 § 5 bis) ====================

  /**
   * `POST /_filarr/notify` : signature HMAC sous `A_notify` et horodatage
   * vérifiés sur le corps BRUT ; le réveil ne porte rien, la boîte relit.
   */
  async handleNotify(request: Request): Promise<Response> {
    if (!this.settings.notify) return json(404, { error: 'Réveils éteints (réglage « notify »)', code: 'not_found' });
    const identity = this.replicator.identity;
    if (!identity) return json(503, { error: 'Aucun jeton en service', code: 'no_token' });
    let raw: string;
    try {
      raw = new TextDecoder().decode(await readBody(request, 8192));
    } catch {
      return json(413, { error: 'Corps trop lourd', code: 'body_too_large' });
    }
    const verdict = await verifyNotify(storeCrypto, identity.aNotify, request.headers.get('filarr-notify'), raw, Math.floor(Date.now() / 1000));
    if (verdict !== 'ok') {
      this.journal.add({ kind: 'error', who: 'Filarr', what: 'réveil refusé', code: '401', note: verdict });
      return json(401, { error: 'Réveil refusé', code: `notify_${verdict}` });
    }
    const body = readNotifyBody(raw, identity.accessId);
    if (!body) return json(400, { error: 'Réveil illisible', code: 'notify_malformed' });
    this.journal.add({ kind: 'filarr', who: 'Filarr', what: `réveil · ${body.t}`, code: 'ok', ...(body.storeId ? { note: body.storeId } : {}) });
    // On répond tout de suite : la relecture se fait après (le serveur n'attend pas)
    void this.replicator.wake(body);
    return json(202, { ok: true });
  }

  // ==================== Export et import des réglages (gate-heberge-1 § 8.4, § 8.6) ====================

  /** Le paquet `gate-settings-1` de cette boîte (aucun mot de passe, aucune clé de base externe). */
  settingsPackage(): GateSettings {
    return buildSettingsPackage(this);
  }

  /**
   * La boîte qui part dépose ses réglages, scellés vers l'identité en attente,
   * APRÈS avoir vérifié `bindSig` avec la clé du créateur authentifiée (§ 1 bis).
   */
  async exportTo(target: ExportRequest): Promise<void> {
    const r = this.replicator;
    const identity = r.identity;
    if (!identity || !r.client) throw new Error('aucun jeton en service');
    if (r.creator.status !== 'authenticated' || !r.creator.signingPublicKey) {
      this.journal.add({ kind: 'error', who: 'migration', what: 'export refusé', code: 'créateur', note: 'clé du créateur non authentifiée : rien n’est exporté' });
      throw new Error('clé du créateur non authentifiée');
    }
    // Les ombres des synchros (déjà chiffrées sous K_shadow) voyagent avec le paquet
    await this.sync?.cacheShadows();
    let sealed: string;
    try {
      sealed = await sealSettingsFor(
        storeCrypto,
        curves,
        this.settingsPackage(),
        { accessId: identity.accessId, encPublicKey: target.encPublicKey, bindSig: target.bindSig },
        r.creator.signingPublicKey
      );
    } catch (err) {
      this.journal.add({ kind: 'error', who: 'migration', what: 'export refusé', code: 'bindSig', note: (err as Error).message });
      throw err;
    }
    await r.client.json('PUT', 'api-access/self/export', { sealed });
    this.journal.add({ kind: 'admin', who: 'migration', what: 'réglages exportés vers l’identité en attente', code: 'ok', note: `${fromBase64Std(sealed).length} octets scellés` });
  }

  /** Applique un paquet de réglages (import d'une migration, ou fichier `--import`). */
  applySettings(pkg: GateSettings): { keys: number; webhooks: number; queries: number } {
    const out = applySettingsPackage(this, pkg);
    this.journal.add({ kind: 'admin', who: 'migration', what: 'réglages importés', code: 'ok', note: `${out.keys} clé(s), ${out.webhooks} webhook(s), ${out.queries} requête(s)` });
    return out;
  }

  /** L'identité en attente relit et applique son paquet, s'il est déposé. */
  async importPending(): Promise<boolean> {
    const pkg = await this.replicator.fetchImport();
    if (!pkg) return false;
    this.applySettings(pkg);
    return true;
  }

  // ==================== Cycle de vie ====================

  /** Démarre la boîte (le jeton s'il est connu) ; `live: false` pour un hôte qui s'endort. */
  async start(token: string | null, source: 'env' | 'state' | null, live = this.live): Promise<void> {
    await this.journal.prune();
    this.pruneTimer = setInterval(() => void this.journal.prune(), 6 * 3_600_000);
    this.sync?.start();
    (this.pruneTimer as { unref?: () => void }).unref?.();
    if (token) {
      try {
        await this.useToken(token, false, false, live);
        this.tokenSource = source;
      } catch (err) {
        this.journal.add({ kind: 'error', who: 'Filarr', what: 'jeton refusé', code: 'jeton', note: (err as Error).message });
      }
    }
  }

  /** Oublie cette machine : copie, clés dérivées, jeton, réglages et journal. */
  async forget(): Promise<void> {
    await this.replicator.forget();
    this.webhooks.clearQueue();
    await this.journal.clear();
    await this.host.wipe();
    await this.state.wipe();
    this.tokenSource = this.config.tokenFromEnv ? 'env' : null;
  }

  async stop(): Promise<void> {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.sync?.stop();
    this.webhooks.stop();
    await this.replicator.stop();
    this.state.saveNow();
    await this.state.flushed();
    await this.journal.flushed();
  }
}
