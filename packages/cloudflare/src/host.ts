/**
 * La boîte noire dans un objet durable : le cœur sans moteur (`GateCore`), avec
 * ce que Cloudflare apporte — les variables et secrets du Worker comme réglages
 * (verrouillés), le stockage de l'objet, les fichiers de l'interface par la
 * liaison `ASSETS`, l'adresse du Worker, et les alarmes à la place des minuteries.
 */

import { KvBlockCache } from '../../gate/src/replica/blockCache';
import { GateCore, type GateHost, type GateHostConfig } from '../../server/src/core';
import { Journal } from '../../server/src/journal';
import { setLogLevel } from '../../server/src/log';
import { ENV_NAMES, coerce, resolveSettings, type SettingKey, type Settings, type SettingSource } from '../../server/src/settings';
import { StateStore } from '../../server/src/state';
import { envNameFor } from '../../server/src/sync/secrets';
import cliPackage from '../../cli/package.json';
import { doBlobs, doJournalSink, doKvStore, doStateBackend, readState, type DoStorage } from './storage';

export const GATE_VERSION: string = (cliPackage as { version: string }).version;

/** Les variables et secrets du Worker que la boîte lit. */
export interface GateEnv {
  FILARR_GATE_TOKEN?: string;
  FILARR_GATE_ADMIN_PASSWORD?: string;
  /** L'adresse publique du Worker, si elle n'est pas celle des requêtes (domaine à vous). */
  FILARR_GATE_PUBLIC_URL?: string;
  FILARR_GATE_LOG_LEVEL?: string;
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

/** Ce que la boîte demande à l'état de l'objet durable. */
export interface DoContext {
  readonly storage: DoStorage & {
    getAlarm(): Promise<number | null>;
    setAlarm(at: number): Promise<void>;
  };
  waitUntil(promise: Promise<unknown>): void;
}

/** Les réglages qui n'ont pas de sens ici (écoute, TLS, cache, mandataires) : fixés, montrés comme tels. */
const FIXED: Partial<Settings> = { host: '0.0.0.0', port: 443, adminHost: '0.0.0.0', adminPort: 443, tlsCert: null, tlsKey: null, cache: 'memory', trustProxy: [] };

function stringsOf(env: object): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
}

class CloudflareHost implements GateHost {
  readonly kind = 'cloudflare' as const;
  gate!: CloudflareGate;
  /** L'adresse vue dans les requêtes (`https://<nom>.<compte>.workers.dev` ou votre domaine). */
  origin: string | null = null;
  resolved: { settings: Settings; sources: Record<SettingKey, SettingSource> };

  constructor(
    private readonly storage: DoStorage,
    private readonly env: GateEnv,
    private readonly vars: Record<string, string | undefined>,
    saved: Partial<Settings>
  ) {
    this.resolved = this.resolve(saved);
  }

  private resolve(saved: Partial<Settings>): { settings: Settings; sources: Record<SettingKey, SettingSource> } {
    const out = resolveSettings(saved, this.vars);
    for (const [k, v] of Object.entries(FIXED) as Array<[SettingKey, unknown]>) {
      (out.settings as unknown as Record<string, unknown>)[k] = v;
      out.sources[k] = 'env';
    }
    return out;
  }

  config(): GateHostConfig {
    return {
      sources: this.resolved.sources,
      configFile: null,
      adminPasswordFromEnv: this.env.FILARR_GATE_ADMIN_PASSWORD || null,
      tokenFromEnv: Boolean(this.env.FILARR_GATE_TOKEN?.trim()),
      envNames: ENV_NAMES,
    };
  }

  settings(): Settings {
    return this.resolved.settings;
  }

  async updateSettings(patch: Partial<Record<SettingKey, unknown>>): Promise<{ restarted: boolean }> {
    const state = this.gate.state;
    const locked: string[] = [];
    const next: Partial<Settings> = { ...state.data.settings };
    for (const [k, v] of Object.entries(patch) as Array<[SettingKey, unknown]>) {
      if (!(k in this.resolved.settings)) continue;
      if (this.resolved.sources[k] === 'env') {
        if (JSON.stringify(coerce(k, v)) !== JSON.stringify(this.resolved.settings[k])) locked.push(k);
        continue;
      }
      (next as Record<string, unknown>)[k] = coerce(k, v);
    }
    if (locked.length > 0) throw new Error(`Réglages fixés par les variables du Worker : ${locked.join(', ')}`);
    state.data.settings = next;
    state.saveNow();
    this.resolved = this.resolve(next);
    return { restarted: false };
  }

  publicUrl(): string {
    return (this.env.FILARR_GATE_PUBLIC_URL || this.origin || 'https://filarr-gate.workers.dev').replace(/\/+$/, '');
  }

  adminUrl(): string {
    return `${this.publicUrl()}/admin/`;
  }

  async persistToken(token: string): Promise<void> {
    await this.storage.put('token', token);
  }

  async serveAsset(pathname: string): Promise<Response | null> {
    if (!this.env.ASSETS) return null;
    const res = await this.env.ASSETS.fetch(new Request(`https://assets.invalid/${pathname.replace(/^\/+/, '')}`));
    if (!res.ok) return null;
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', pathname.endsWith('.html') ? 'no-store' : 'public, max-age=31536000, immutable');
    return new Response(res.body, { status: 200, headers });
  }

  fileExists(): boolean {
    return false;
  }

  async wipe(): Promise<void> {
    await this.storage.delete('token');
    for (const prefix of ['kv:', 'blob:', 'jl:']) {
      const keys = [...(await this.storage.list({ prefix })).keys()];
      for (let i = 0; i < keys.length; i += 128) await this.storage.delete(keys.slice(i, i + 128));
    }
  }
}

export class CloudflareGate extends GateCore {
  /** La première copie (ou l'échec définitif) : les alarmes l'attendent. */
  started: Promise<void> = Promise.resolve();
  private startedAt = 0;
  private readonly cf: CloudflareHost;

  private constructor(
    private readonly ctx: DoContext,
    host: CloudflareHost,
    state: StateStore,
    private readonly sink: ReturnType<typeof doJournalSink>,
    private readonly stateBackend: ReturnType<typeof doStateBackend>,
    vars: Record<string, string | undefined>
  ) {
    const s = host.settings();
    super({
      host,
      state,
      journal: new Journal(sink, s.journalDays),
      cache: new KvBlockCache(doKvStore(ctx.storage)),
      version: GATE_VERSION,
      // Aucun flux : l'objet s'endort entre deux alarmes et se réveille aux réveils poussés
      streamOpener: null,
      live: false,
      sync: {
        blobs: doBlobs(ctx.storage),
        tcp: false,
        externalSecret: (defId) => vars[envNameFor(defId)] || null,
        timers: false,
      },
    });
    this.cf = host;
    host.gate = this;
  }

  static async open(ctx: DoContext, env: GateEnv): Promise<CloudflareGate> {
    const vars = stringsOf(env);
    setLogLevel((vars.FILARR_GATE_LOG_LEVEL as Parameters<typeof setLogLevel>[0]) || 'info');
    const backend = doStateBackend(ctx.storage);
    const state = new StateStore(backend, await readState(ctx.storage));
    const host = new CloudflareHost(ctx.storage, env, vars, state.data.settings);
    const gate = new CloudflareGate(ctx, host, state, doJournalSink(ctx.storage), backend, vars);
    const fromEnv = env.FILARR_GATE_TOKEN?.trim() || null;
    const token = fromEnv ?? (await ctx.storage.get<string>('token')) ?? null;
    gate.started = gate
      .start(token, fromEnv ? 'env' : token ? 'state' : null)
      .then(() => {
        gate.startedAt = Date.now();
      })
      .finally(() => gate.settle());
    return gate;
  }

  /** Une requête : `/admin/…` pour l'interface de gestion, tout le reste pour l'API locale. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.cf.origin = url.origin;
    // L'adresse du client, posée par le réseau de Cloudflare (jamais par le client)
    const conn = { remoteAddress: request.headers.get('cf-connecting-ip') ?? '' };
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return this.admin.handle(request, conn);
    return this.api.handle(request, conn);
  }

  /** Une alarme : une relève (sauf juste après le démarrage), les synchros dues, les webhooks dus. */
  async onAlarm(): Promise<void> {
    await this.started.catch(() => undefined);
    if (Date.now() - this.startedAt > 10_000) await this.replicator.pollNow();
    await this.sync?.scan();
    await this.sync?.runDue();
    await this.webhooks.drainDue();
    await this.settle();
  }

  /**
   * Après chaque requête et chaque alarme : laisse finir ce qui tourne (réveil,
   * passage, livraison ; 25 s au plus), verse l'état et le journal, et pose la
   * prochaine alarme.
   */
  async settle(): Promise<void> {
    const deadline = Date.now() + 25_000;
    while ((this.replicator.busy || this.sync?.busy || this.webhooks.busy) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.state.flushed();
    await this.stateBackend.flushed();
    await this.sink.flush();
    await this.schedule();
  }

  private async schedule(): Promise<void> {
    const candidates = [Date.now() + this.settings.pollSeconds * 1000, this.sync?.nextWake() ?? Infinity, this.webhooks.nextDueAt() ?? Infinity];
    const next = Math.max(Date.now() + 1000, Math.min(...candidates));
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next || current < Date.now()) await this.ctx.storage.setAlarm(next);
  }
}
