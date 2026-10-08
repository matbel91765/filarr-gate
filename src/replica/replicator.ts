/**
 * LA RÉPLIQUE de la boîte noire : tout ce que le jeton ouvre, tenu à jour.
 *
 * 1. `GET /api-access/self` : l'accès, ses droits scellés (ouverts et vérifiés à
 *    leur place), ses manifestes, ses limites et son usage ;
 * 2. pour chaque magasin : tête → blocs changés → lignes en mémoire (`StoreMirror`) ;
 * 3. les changements arrivent par le flux (`GET /api-access/self/stream`,
 *    WebSocket), reconnecté avec un délai croissant ; sans flux (palier Free,
 *    `403 api_tier_stream`), par une relève de `changes` au plus toutes les 300 s.
 *
 * Chaque `429` est honoré (`Retry-After`) : plus rien ne part vers Filarr avant
 * l'heure dite, et les lectures locales continuent sur la dernière copie.
 * Révocation (`{ t: "revoked" }` ou `401 api_access_revoked`) : tout s'arrête, les
 * clés et les lignes sont effacées de la mémoire, le cache des blocs du disque aussi.
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { openGrants, openManifests, type ManifestInfo, type RefusedSeal, type Rights, type SelfAccess, type SelfResponse } from './access';
import type { BlockCache } from './blockCache';
import { FilarrClient, FilarrError, RateLimitError, UnreachableError, parseRetryAfter } from './http';
import { StoreMirror, type ChangesResponse, type RowDiff } from './store';
import { openToken, wipeIdentity, type AccessIdentity } from './token';
import type { Journal } from '../journal';

export type LinkState =
  | 'no_token'
  | 'connecting'
  | 'live'
  | 'polling'
  | 'offline'
  | 'limited'
  | 'paused'
  | 'ip_forbidden'
  | 'revoked'
  | 'expired'
  | 'unknown_access'
  | 'upgrade_required'
  | 'error';

const TERMINAL: ReadonlySet<LinkState> = new Set(['revoked', 'expired', 'unknown_access']);

export interface GateBase {
  storeId: string;
  rights: Rights;
  mirror: StoreMirror;
  manifest: ManifestInfo | null;
}

export interface QuotaAlert {
  name: string;
  pct: number;
  at: string;
}

export interface ReplicatorOptions {
  apiUrl: string;
  version: string;
  cache: BlockCache;
  site: string;
  journal: Journal;
  fetchImpl?: typeof fetch;
  /** Intervalle de relève sans flux ; le contrat impose au moins 300 s en Free. */
  pollIntervalMs?: number;
  /** Relecture de `self` sans flux (droits, manifestes). */
  selfIntervalMs?: number;
  /** Délai de reconnexion du flux : du minimum au maximum, doublé à chaque échec. */
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Nouvel essai quand l'accès est en pause ou refusé pour son adresse. */
  pausedRetryMs?: number;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

const isNat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export class Replicator extends EventEmitter {
  link: LinkState = 'no_token';
  linkDetail: string | null = null;
  identity: AccessIdentity | null = null;
  client: FilarrClient | null = null;
  access: SelfAccess | null = null;
  limits: Record<string, unknown> | null = null;
  usage: Record<string, unknown> | null = null;
  readonly bases = new Map<string, GateBase>();
  refused: RefusedSeal[] = [];
  quotaAlerts: QuotaAlert[] = [];
  /** Plus rien ne part vers Filarr avant cette heure (un `429`). */
  notBefore = 0;
  limitedCode: string | null = null;
  /** Le flux a été refusé pour le palier : on relève. */
  streamRefused = false;
  lastSelfAt: string | null = null;
  lastChangeAt: string | null = null;
  startedAt: string | null = null;

  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private ws: WebSocket | null = null;
  private backoff: number;
  private selfDirty = false;
  private wake: (() => void) | null = null;

  constructor(private readonly opts: ReplicatorOptions) {
    super();
    this.backoff = opts.backoffMinMs ?? 1000;
  }

  get pollIntervalMs(): number {
    return this.opts.pollIntervalMs ?? 300_000;
  }

  /** Une base par son slug (manifeste). */
  bySlug(slug: string): GateBase | undefined {
    for (const b of this.bases.values()) if (b.manifest?.slug === slug) return b;
    return undefined;
  }

  /** Une base par l'identité du bloc propriétaire (`head.dbId`) : la cible d'une relation. */
  byDbId(dbId: string): GateBase | undefined {
    for (const b of this.bases.values()) if (b.mirror.head?.dbId === dbId) return b;
    return undefined;
  }

  private setLink(state: LinkState, detail: string | null = null): void {
    const changed = state !== this.link || detail !== this.linkDetail;
    this.link = state;
    this.linkDetail = detail;
    if (changed) this.emit('link', state, detail);
  }

  private journal(what: string, code: string, note?: string, ms?: number): void {
    this.opts.journal.add({ kind: 'filarr', who: 'Filarr', what, code, ...(note ? { note } : {}), ...(ms !== undefined ? { ms } : {}) });
  }

  // ==================== Démarrage et arrêt ====================

  /**
   * Ouvre le jeton, lit `self`, ouvre les droits et rattrape chaque magasin.
   * Rend quand la première copie est prête (ou que l'échec est définitif), puis
   * la boucle continue en arrière-plan (flux ou relève).
   */
  async start(token: string): Promise<void> {
    await this.stop();
    this.identity = await openToken(token);
    this.client = new FilarrClient({
      baseUrl: this.opts.apiUrl,
      authorization: this.identity.authorization,
      version: this.opts.version,
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      onExchange: (info) => this.emit('exchange', info),
    });
    this.abort = new AbortController();
    this.startedAt = new Date().toISOString();
    this.selfDirty = true;
    this.streamRefused = false;
    this.notBefore = 0;
    this.setLink('connecting');
    const signal = this.abort.signal;
    try {
      await this.refreshSelf();
      await this.syncAll();
    } catch (err) {
      await this.handleError(err);
    }
    if (!TERMINAL.has(this.link)) this.loop = this.run(signal);
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    this.wake?.();
    this.ws?.terminate();
    this.ws = null;
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }

  /** Oublie tout ce que la boîte noire tient de cet accès : clés, lignes, cache du disque. */
  async forget(): Promise<void> {
    await this.stop();
    this.wipeAll();
    await this.opts.cache.clear().catch(() => undefined);
    this.access = null;
    this.limits = null;
    this.usage = null;
    this.setLink('no_token');
  }

  private wipeAll(): void {
    for (const base of this.bases.values()) base.mirror.wipe();
    this.bases.clear();
    if (this.identity) wipeIdentity(this.identity);
    this.identity = null;
  }

  /** Relit tout depuis Filarr (droits, manifestes, têtes). */
  async resync(): Promise<void> {
    if (!this.client) return;
    try {
      await this.refreshSelf();
      await this.syncAll(true);
    } catch (err) {
      await this.handleError(err);
    }
  }

  // ==================== self, droits, manifestes ====================

  private checkLimited(): void {
    if (Date.now() < this.notBefore) {
      throw new RateLimitError(this.limitedCode ?? 'api_rate', this.notBefore - Date.now());
    }
  }

  async refreshSelf(): Promise<void> {
    const client = this.client;
    const identity = this.identity;
    if (!client || !identity) return;
    this.checkLimited();
    const self = await client.json<SelfResponse>('GET', 'api-access/self');
    this.lastSelfAt = new Date().toISOString();
    this.selfDirty = false;
    this.access = self.access ?? null;
    this.limits = self.limits ?? null;
    this.usage = self.usage ?? null;
    const { grants, refused: refusedGrants } = await openGrants(identity, self.grants);
    const { manifests, refused: refusedManifests } = await openManifests(identity, self.manifests);
    this.refused = [...refusedGrants, ...refusedManifests];
    for (const r of this.refused) {
      this.journal(
        `scellé refusé · ${r.what === 'grant' ? 'droit' : 'manifeste'} ${r.storeId}${r.e !== undefined ? ` (${r.e}, ${r.g})` : ''}`,
        'refusé',
        r.reason
      );
    }
    // Un droit retiré : la base disparaît, ses lignes et ses clés sont effacées
    for (const [storeId, base] of this.bases) {
      if (!grants.has(storeId)) {
        base.mirror.wipe();
        this.bases.delete(storeId);
        await this.opts.cache.drop(storeId).catch(() => undefined);
        this.journal(`base retirée de l’accès · ${base.manifest?.title ?? storeId}`, 'droits');
        this.emit('bases');
      }
    }
    for (const [storeId, grant] of grants) {
      const existing = this.bases.get(storeId);
      if (existing) {
        const before = [...existing.mirror.keys.keys()].sort().join(',');
        existing.rights = grant.rights;
        existing.mirror.rights = grant.rights;
        existing.mirror.keys = grant.keys;
        existing.manifest = manifests.get(storeId) ?? existing.manifest;
        // Une clé neuve (rescellement) rouvre une base qui l'attendait
        if (before !== [...grant.keys.keys()].sort().join(',') && existing.mirror.status === 'missing_key') {
          existing.mirror.status = 'loading';
        }
      } else {
        const mirror = new StoreMirror(storeId, grant.rights, grant.keys, {
          client,
          cache: this.opts.cache,
          site: this.opts.site,
        });
        this.bases.set(storeId, { storeId, rights: grant.rights, mirror, manifest: manifests.get(storeId) ?? null });
        this.emit('bases');
      }
    }
    if (this.access?.paused === true) this.setLink('paused', 'Accès mis en pause dans Filarr');
  }

  /** Rattrape chaque magasin (un à un : le débit vers Filarr reste sage). */
  async syncAll(force = false): Promise<void> {
    for (const base of this.bases.values()) await this.syncBase(base, force);
  }

  private async syncBase(base: GateBase, force = false): Promise<void> {
    this.checkLimited();
    const started = Date.now();
    const before = base.mirror.status;
    try {
      const diff = await base.mirror.sync(force || base.mirror.status !== 'ready');
      if (diff) this.onDiff(base, diff, Date.now() - started);
    } catch (err) {
      if (err instanceof FilarrError && err.status === 403 && err.code === 'store_not_granted') {
        base.mirror.markUnavailable('refused', { code: err.code, message: 'Filarr refuse cette base à l’accès' });
        this.selfDirty = true;
        return;
      }
      if (err instanceof RateLimitError) base.mirror.markUnavailable('waiting', { code: err.code, message: err.message });
      else if (err instanceof UnreachableError) base.mirror.markUnavailable('offline', { code: 'unreachable', message: err.message });
      throw err;
    }
    const after = base.mirror.status;
    if (after !== before && after !== 'ready') {
      this.journal(`base ${base.manifest?.title ?? base.storeId}`, after === 'missing_key' ? 'clés' : 'vérification', base.mirror.problem?.message);
      if (after === 'missing_key') this.selfDirty = true;
    }
    if (after !== before) this.emit('bases');
  }

  private onDiff(base: GateBase, diff: RowDiff, ms: number): void {
    const n = diff.created.length + diff.updated.length + diff.deleted.length;
    this.lastChangeAt = new Date().toISOString();
    if (n > 0 || diff.seq > 0) {
      this.journal(
        `${base.manifest?.title ?? base.storeId} v${diff.seq} reçue`,
        'synchro',
        n === 0 ? 'copie à jour' : `${n} ligne${n > 1 ? 's' : ''} changée${n > 1 ? 's' : ''}`,
        ms
      );
    }
    this.emit('change', base, diff);
  }

  /** Une validation de cette boîte noire : les webhooks suivent comme pour un changement venu de Filarr. */
  publishLocalDiff(base: GateBase, diff: RowDiff): void {
    this.lastChangeAt = new Date().toISOString();
    this.emit('change', base, diff);
  }

  // ==================== Boucle ====================

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !TERMINAL.has(this.link)) {
      try {
        const wait = this.notBefore - Date.now();
        if (wait > 0) {
          this.setLink('limited', `Filarr limite cet accès (${this.limitedCode}) : reprise à ${new Date(this.notBefore).toISOString()}`);
          await sleep(wait, signal);
          continue;
        }
        if (this.link === 'paused' || this.link === 'ip_forbidden' || this.link === 'upgrade_required') {
          await sleep(this.opts.pausedRetryMs ?? 300_000, signal);
          if (signal.aborted) break;
          await this.refreshSelf();
          await this.syncAll();
          this.setLink('connecting');
          continue;
        }
        if (this.selfDirty) {
          await this.refreshSelf();
          await this.syncAll();
        }
        if (!this.streamRefused) {
          const outcome = await this.runStream(signal);
          if (outcome === 'tier') {
            this.streamRefused = true;
            this.journal('flux des changements refusé pour le palier', 'relève', `relève toutes les ${Math.round(this.pollIntervalMs / 1000)} s`);
            continue;
          }
          if (signal.aborted || TERMINAL.has(this.link)) break;
          // Fermé ou injoignable : délai croissant, puis reconnexion
          if (this.link !== 'limited') this.setLink('offline', 'Flux des changements interrompu : reconnexion…');
          await sleep(this.nextBackoff(), signal);
          continue;
        }
        // Relève (sans flux)
        this.setLink('polling', `Relève toutes les ${Math.round(this.pollIntervalMs / 1000)} s`);
        await this.pollOnce();
        this.backoff = this.opts.backoffMinMs ?? 1000;
        await this.sleepInterruptible(this.pollIntervalMs, signal);
      } catch (err) {
        await this.handleError(err);
        if (TERMINAL.has(this.link)) break;
        // Un 429 attend son heure en tête de boucle ; toute autre erreur, un délai croissant
        if (!(err instanceof RateLimitError)) await sleep(this.nextBackoff(), signal);
      }
    }
  }

  private nextBackoff(): number {
    const current = this.backoff;
    this.backoff = Math.min(this.opts.backoffMaxMs ?? 60_000, this.backoff * 2);
    // Un peu de hasard : plusieurs boîtes noires ne reviennent pas toutes à la même seconde
    return Math.round(current * (0.8 + Math.random() * 0.4));
  }

  private sleepInterruptible(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      const onAbort = () => done();
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve();
      }
      this.wake = done;
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Une relève : `changes` de chaque magasin, puis la tête de ceux qui ont bougé. */
  async pollOnce(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const selfEvery = [...this.bases.values()].some((b) => b.mirror.status === 'missing_key')
      ? (this.opts.selfIntervalMs ?? 1_800_000)
      : Math.max(this.opts.selfIntervalMs ?? 1_800_000, 6 * 3_600_000);
    if (this.selfDirty || !this.lastSelfAt || Date.now() - Date.parse(this.lastSelfAt) >= selfEvery) {
      await this.refreshSelf();
    }
    for (const base of this.bases.values()) {
      this.checkLimited();
      if (base.mirror.status !== 'ready' || base.mirror.seq === 0) {
        await this.syncBase(base, true);
        continue;
      }
      try {
        const changes = await client.json<ChangesResponse>('GET', `dbstore/${base.storeId}/changes?since=${base.mirror.seq}`);
        if (isNat(changes.seq) && changes.seq > base.mirror.seq) await this.syncBase(base);
      } catch (err) {
        if (err instanceof FilarrError && err.status === 410) {
          await this.syncBase(base, true);
          continue;
        }
        throw err;
      }
    }
  }

  /** Le flux des changements ; rend quand il se ferme. */
  private runStream(signal: AbortSignal): Promise<'closed' | 'tier' | 'refused'> {
    const client = this.client!;
    return new Promise((resolve) => {
      // Un signal déjà levé ne prévient plus personne : on ne rouvre pas le flux
      if (signal.aborted) return resolve('closed');
      const url = client.url('api-access/self/stream');
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(url, { headers: client.headers(), handshakeTimeout: 15_000 });
      this.ws = ws;
      let settled = false;
      let alive = true;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const finish = (outcome: 'closed' | 'tier' | 'refused') => {
        if (settled) return;
        settled = true;
        if (heartbeat) clearInterval(heartbeat);
        signal.removeEventListener('abort', onAbort);
        if (this.ws === ws) this.ws = null;
        resolve(outcome);
      };
      const onAbort = () => {
        ws.terminate();
        finish('closed');
      };
      signal.addEventListener('abort', onAbort, { once: true });

      ws.on('unexpected-response', (_req, res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
        res.on('end', () => {
          let code = `http_${res.statusCode}`;
          try {
            const parsed = JSON.parse(text) as { code?: string };
            if (typeof parsed.code === 'string') code = parsed.code;
          } catch {
            /* corps illisible */
          }
          ws.terminate();
          const status = res.statusCode ?? 0;
          if (status === 403 && code === 'api_tier_stream') return finish('tier');
          if (status === 429) {
            this.limit(code, parseRetryAfter((res.headers['retry-after'] as string | undefined) ?? null));
            return finish('refused');
          }
          if (status >= 500 || status === 0) return finish('closed');
          void this.handleError(new FilarrError(status, code, {})).then(() => finish('refused'));
        });
      });
      ws.on('open', () => {
        this.backoff = this.opts.backoffMinMs ?? 1000;
        this.setLink('live', 'Flux des changements ouvert');
        heartbeat = setInterval(() => {
          if (!alive) {
            ws.terminate();
            return;
          }
          alive = false;
          ws.ping();
        }, 30_000);
        // Ce qui a pu se passer pendant la coupure
        void this.catchUp();
      });
      ws.on('pong', () => (alive = true));
      ws.on('message', (data) => {
        alive = true;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        void this.onMessage(msg);
      });
      ws.on('close', () => finish('closed'));
      ws.on('error', () => {
        /* la fermeture suit */
      });
    });
  }

  private async catchUp(): Promise<void> {
    try {
      if (this.selfDirty) await this.refreshSelf();
      for (const base of this.bases.values()) await this.syncBase(base);
    } catch (err) {
      await this.handleError(err);
    }
  }

  private async onMessage(msg: Record<string, unknown>): Promise<void> {
    try {
      switch (msg.t) {
        case 'commit': {
          const base = typeof msg.storeId === 'string' ? this.bases.get(msg.storeId) : undefined;
          if (base && (!isNat(msg.seq) || msg.seq > base.mirror.seq)) await this.syncBase(base);
          break;
        }
        case 'grant':
          this.journal('droits rescellés pour cet accès', 'clés');
          await this.refreshSelf();
          await this.syncAll();
          break;
        case 'manifest':
          this.journal(`manifeste republié${typeof msg.storeId === 'string' ? ` · ${this.bases.get(msg.storeId)?.manifest?.title ?? msg.storeId}` : ''}`, 'manifeste');
          await this.refreshSelf();
          this.emit('bases');
          break;
        case 'quota': {
          const alert: QuotaAlert = {
            name: typeof msg.name === 'string' ? msg.name : 'quota',
            pct: typeof msg.pct === 'number' ? msg.pct : 0,
            at: new Date().toISOString(),
          };
          this.quotaAlerts = [alert, ...this.quotaAlerts].slice(0, 20);
          this.journal(`quota ${alert.name} à ${alert.pct} %`, 'quota');
          this.emit('quota', alert);
          break;
        }
        case 'revoked':
          await this.revoked('Accès révoqué dans Filarr');
          break;
        default:
          break;
      }
    } catch (err) {
      await this.handleError(err);
    }
  }

  private limit(code: string, retryAfterMs: number): void {
    this.notBefore = Math.max(this.notBefore, Date.now() + retryAfterMs);
    this.limitedCode = code;
    this.journal(`limite de Filarr · ${code}`, '429', `nouvel essai dans ${Math.ceil(retryAfterMs / 1000)} s`);
    this.setLink('limited', `Filarr limite cet accès (${code})`);
  }

  private async revoked(detail: string, state: LinkState = 'revoked'): Promise<void> {
    this.journal(detail, state === 'revoked' ? 'révoqué' : state);
    this.abort?.abort();
    this.ws?.terminate();
    this.wipeAll();
    await this.opts.cache.clear().catch(() => undefined);
    this.setLink(state, detail);
    this.emit('bases');
  }

  private async handleError(err: unknown): Promise<void> {
    if (err instanceof RateLimitError) {
      this.limit(err.code, err.retryAfterMs);
      return;
    }
    if (err instanceof UnreachableError) {
      this.setLink('offline', err.message);
      return;
    }
    if (err instanceof FilarrError) {
      switch (err.code) {
        case 'api_access_revoked':
          return this.revoked('Accès révoqué dans Filarr');
        case 'api_access_expired':
          return this.revoked('Accès expiré', 'expired');
        case 'api_access_unknown':
          return this.revoked('Filarr ne connaît pas ce jeton', 'unknown_access');
        case 'api_access_paused':
          this.setLink('paused', 'Accès mis en pause dans Filarr');
          return;
        case 'api_ip_forbidden':
          this.setLink('ip_forbidden', 'Filarr refuse l’adresse IP de cette machine pour cet accès');
          return;
        case 'store_not_granted':
          this.selfDirty = true;
          return;
        default:
          if (err.status === 426) {
            this.setLink('upgrade_required', 'Cette version de Filarr Gate est trop ancienne pour l’API Filarr');
            return;
          }
          this.journal('erreur de Filarr', String(err.status), err.code);
          this.setLink('error', `Filarr a refusé (${err.status} ${err.code})`);
          return;
      }
    }
    this.journal('erreur interne de la réplique', 'erreur', (err as Error)?.message);
    this.setLink('error', (err as Error)?.message ?? String(err));
  }
}
