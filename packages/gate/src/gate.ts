/**
 * `openGate` : la réplique de Filarr Gate DANS votre programme, sans serveur
 * HTTP (Node 20+, Deno, Bun, Workers Cloudflare).
 *
 *   const gate = await openGate({ token: process.env.FILARR_GATE_TOKEN })
 *   const actifs = await gate.base('clients').view('actifs').rows()
 *
 * Le jeton n'est jamais envoyé à Filarr : la bibliothèque en dérive la preuve
 * qu'elle présente et la clé qui ouvre les bases. Les lignes sont déchiffrées en
 * mémoire ; rien de clair ne s'écrit sur le disque (le cache `{ dir }` ne garde
 * que des blocs chiffrés).
 */

import { readNotifyBody, verifyNotify } from '../../core/src/engine/gate/access3';
import { DEFAULT_DENIED_EXTENSIONS, MAX_FILE_BYTES, type FileFilter } from '../../core/src/engine/gate/files';
import type { DbRow } from '../../core/src/types';
import { storeCrypto } from './crypto/providers';
import { memoryFieldNames, rowJson, type FieldDef } from './data/fields';
import { GateModel, type BaseInfo } from './data/model';
import { listRows, runSql, viewPage } from './data/query';
import { ApiError } from './errors';
import { Writer } from './data/write';
import { depositFile, depositStatus } from './files';
import { MemoryBlockCache, type BlockCache } from './replica/blockCache';
import { Replicator, type GateBase } from './replica/replicator';
import type { RowDiff } from './replica/store';
import type { StreamOpener } from './replica/stream';
import type {
  BaseSummary,
  ChangeEvent,
  DepositOptions,
  FieldCondition,
  FieldInfo,
  FileDeposit,
  FileStatus,
  GateStatus,
  Row,
  RowInput,
  RowList,
  RowsOptions,
  SqlResult,
  ViewRowsOptions,
  ViewSummary,
} from './types';

/** Les erreurs de la bibliothèque : un `code` stable et un `status` HTTP équivalent. */
export { ApiError as GateError };

export const DEFAULT_API_URL = 'https://api.filarr.com';

export interface OpenGateOptions {
  /** Le jeton de l'accès (`flr_live_…`), montré une fois par Filarr. */
  token: string;
  /** L'API de Filarr (d'office `https://api.filarr.com`). */
  apiUrl?: string;
  /** `memory` (d'office) ; `{ dir }` : blocs CHIFFRÉS gardés sur le disque entre deux lancements (Node). */
  cache?: 'memory' | { dir: string };
  /** Autoriser l'écriture (`insert`, `update`, `delete`) : éteinte d'office. */
  write?: boolean;
  /**
   * Garder la copie à jour en arrière-plan (flux des changements, sinon relève) : oui
   * d'office. `false` : une copie à l'ouverture, puis `refresh()` ou `wake()` à la demande.
   */
  live?: boolean;
  /** Relève sans flux, en secondes (300 au moins, comme le veut Filarr en Free). */
  pollSeconds?: number;
  /** Fente à fichiers : taille maximale (100 Mio au plus) et extensions refusées. */
  files?: { maxBytes?: number; deny?: string[]; allow?: string[] };
  /** `fetch` à utiliser (essais, mandataire). */
  fetch?: typeof fetch;
  /** Ouverture du flux (avancé) ; `null` : jamais de flux, relève et réveils seulement. */
  streamOpener?: StreamOpener | null;
  /** Reçoit le journal de la réplique (échanges avec Filarr, refus, clés manquantes). */
  onLog?: (entry: { what: string; code: string; note?: string }) => void;
  /** Annule l'ouverture. */
  signal?: AbortSignal;
}

type Listener<T> = (event: T) => void;

/** Une base ouverte à l'accès. */
export interface Base {
  readonly slug: string;
  readonly title: string;
  readonly rights: 'r' | 'rw';
  readonly version: number;
  readonly fields: FieldInfo[];
  readonly views: ViewSummary[];
  /** Les lignes (filtres, tri, champs, pages). */
  rows(options?: RowsOptions): Promise<RowList>;
  /** Une ligne, ou `null`. */
  row(id: string): Promise<Row | null>;
  /** Une vue, rejouée par le moteur de vues de Filarr (ses filtres, son tri, ses colonnes). */
  view(slug: string): View;
  insert(row: RowInput): Promise<Row>;
  insert(rows: RowInput[]): Promise<Row[]>;
  update(id: string, patch: RowInput): Promise<Row>;
  delete(id: string): Promise<void>;
}

export interface View {
  readonly slug: string;
  readonly name: string;
  rows(options?: ViewRowsOptions): Promise<RowList>;
}

export interface Files {
  /** Dépose un fichier dans la boîte de dépôt liée à l'accès ; l'appli Filarr le range. */
  deposit(data: Uint8Array | ArrayBuffer | Blob | string, options: DepositOptions): Promise<FileDeposit>;
  /** Le statut d'un dépôt (jamais où ni sous quel nom il a été rangé). */
  status(depositId: string): Promise<FileStatus>;
}

const OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'in', 'empty'] as const;

function paramsOf(o: RowsOptions = {}): URLSearchParams {
  const p = new URLSearchParams();
  for (const [field, cond] of Object.entries(o.where ?? {})) {
    if (cond === null || typeof cond !== 'object') {
      p.append(field, String(cond));
      continue;
    }
    const c = cond as Exclude<FieldCondition, string | number | boolean>;
    for (const op of OPS) {
      const v = c[op];
      if (v === undefined) continue;
      p.append(`${field}[${op}]`, Array.isArray(v) ? v.map(String).join(',') : String(v));
    }
  }
  if (o.sort) p.set('sort', Array.isArray(o.sort) ? o.sort.join(',') : o.sort);
  if (o.limit !== undefined) p.set('limit', String(o.limit));
  if (o.cursor) p.set('cursor', o.cursor);
  if (o.fields?.length) p.set('fields', o.fields.join(','));
  if (o.q) p.set('q', o.q);
  if (o.since !== undefined) p.set('since', String(o.since));
  return p;
}

const toRowList = (page: { rows: Array<Record<string, unknown>>; next: string | null; total: number; version?: number; unresolved?: string[] }, version: number): RowList =>
  Object.assign([...page.rows] as Row[], {
    next: page.next,
    total: page.total,
    version: page.version ?? version,
    ...(page.unresolved ? { unresolved: page.unresolved } : {}),
  });

const fieldInfo = (f: FieldDef): FieldInfo => ({
  name: f.name,
  column: f.prop.name,
  type: f.prop.type,
  json: f.type,
  writable: f.writable,
  ...(f.options ? { options: f.options } : {}),
});

/** La boîte noire dans votre programme (rendue par `openGate`). */
export class Gate {
  private readonly listeners = new Map<string, Set<Listener<never>>>();
  private readonly model: GateModel;
  private readonly writer: Writer;
  readonly files: Files;
  private closed = false;

  /** @internal */
  constructor(
    private readonly replicator: Replicator,
    private readonly opts: OpenGateOptions
  ) {
    this.model = new GateModel(replicator, memoryFieldNames());
    this.writer = new Writer(this.model, replicator, () => opts.write === true);
    const filter: FileFilter = {
      deny: opts.files?.deny ?? DEFAULT_DENIED_EXTENSIONS,
      ...(opts.files?.allow ? { allow: opts.files.allow } : {}),
      maxBytes: Math.min(opts.files?.maxBytes ?? MAX_FILE_BYTES, MAX_FILE_BYTES),
    };
    this.files = {
      deposit: async (data, options) => {
        const bytes =
          typeof data === 'string'
            ? new TextEncoder().encode(data)
            : data instanceof Uint8Array
              ? data
              : data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : new Uint8Array(await (data as Blob).arrayBuffer());
        return depositFile(this.replicator, bytes, options, filter);
      },
      status: (depositId) => depositStatus(this.replicator, depositId),
    };
    replicator.on('change', (base: GateBase, diff: RowDiff) => this.emitChange(base, diff));
    replicator.on('link', () => this.emit('status', this.status()));
  }

  /** L'identifiant de l'accès (base64url), tel que Filarr le connaît. */
  get accessId(): string | null {
    return this.replicator.identity?.accessId ?? null;
  }

  /** Le nom de l'accès dans Filarr. */
  get accessName(): string | null {
    return typeof this.replicator.access?.name === 'string' ? this.replicator.access.name : null;
  }

  private infoOf(slug: string): BaseInfo {
    const info = this.model.base(slug);
    if (!info) throw new ApiError(404, 'base_not_found', `Base inconnue : ${slug} (bases ouvertes : ${this.model.bases().map((b) => b.slug).join(', ') || 'aucune'})`);
    if (!info.base.mirror.loaded) {
      const p = info.base.mirror.problem;
      throw new ApiError(503, p?.code ?? 'base_loading', p ? `Base indisponible : ${p.message}` : 'Base en cours de chargement', p?.keys ? { keys: p.keys } : {});
    }
    return info;
  }

  /** Les bases ouvertes à l'accès (celles dont Filarr a publié le manifeste). */
  bases(): BaseSummary[] {
    return this.model.bases().map((b) => ({
      slug: b.slug,
      title: b.title,
      rights: b.rights,
      status: b.status,
      version: b.version,
      rows: b.rows.length,
      fields: b.fields.map(fieldInfo),
      views: b.views.map((v) => ({ slug: v.slug, name: v.view.name, type: v.view.type })),
    }));
  }

  /** Une base, par son slug (`clients`). Lève `base_not_found` si elle n'est pas ouverte. */
  base(slug: string): Base {
    const self = this;
    const current = (): BaseInfo => self.infoOf(slug);
    const info = current();
    const toRow = (i: BaseInfo, r: Record<string, unknown>): Row => r as Row;
    const base: Base = {
      slug,
      get title() {
        return current().title;
      },
      get rights() {
        return current().rights;
      },
      get version() {
        return current().version;
      },
      get fields() {
        return current().fields.map(fieldInfo);
      },
      get views() {
        return current().views.map((v) => ({ slug: v.slug, name: v.view.name, type: v.view.type }));
      },
      async rows(options) {
        const i = current();
        return toRowList(listRows(self.model, i, paramsOf(options)), i.version);
      },
      async row(id) {
        const i = current();
        const row = i.base.mirror.rowById(id);
        return row ? toRow(i, rowJson(i.fields, row, self.model.env(i))) : null;
      },
      view(viewSlug) {
        const i = current();
        const v = i.views.find((x) => x.slug === viewSlug);
        if (!v) throw new ApiError(404, 'view_not_found', `Vue inconnue : ${slug}/${viewSlug} (vues : ${i.views.map((x) => x.slug).join(', ') || 'aucune'})`);
        return {
          slug: v.slug,
          name: v.view.name,
          async rows(options) {
            const fresh = current();
            const fv = fresh.views.find((x) => x.slug === viewSlug) ?? v;
            const p = new URLSearchParams();
            if (options?.limit !== undefined) p.set('limit', String(options.limit));
            if (options?.cursor) p.set('cursor', options.cursor);
            const page = viewPage(self.model, fresh, fv, p);
            return toRowList(page, fresh.version);
          },
        };
      },
      insert: (async (input: RowInput | RowInput[]) => {
        const r = await self.writer.create(current(), input);
        return Array.isArray(input) ? (r.rows as Row[]) : (r.rows[0] as Row);
      }) as Base['insert'],
      async update(id, patch) {
        const r = await self.writer.update(current(), id, patch);
        return r.rows[0] as Row;
      },
      async delete(id) {
        await self.writer.remove(current(), id);
      },
    };
    void info;
    return base;
  }

  /** Une requête SQL en lecture seule (`SELECT`), sur les bases ouvertes — le moteur SQL de Filarr. */
  async sql(query: string, options: { bases?: string[] } = {}): Promise<SqlResult> {
    const storeIds = options.bases ? new Set(options.bases.map((s) => this.infoOf(s).storeId)) : undefined;
    return runSql(this.model.sql(storeIds).catalog, query);
  }

  /** Écouter : `change` (lignes ajoutées, changées, retirées) ou `status` (liaison avec Filarr). Rend de quoi se désabonner. */
  on(event: 'change', fn: Listener<ChangeEvent>): () => void;
  on(event: 'status', fn: Listener<GateStatus>): () => void;
  on(event: 'change' | 'status', fn: Listener<never>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emit(event: string, payload: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        (fn as Listener<unknown>)(payload);
      } catch {
        /* un écouteur fautif ne casse pas la réplique */
      }
    }
  }

  private emitChange(base: GateBase, diff: RowDiff): void {
    if (!this.listeners.get('change')?.size) return;
    const info = this.model.baseById(base.storeId);
    if (!info) return;
    const env = this.model.env(info);
    const json = (r: DbRow) => rowJson(info.fields, r, env) as Row;
    this.emit('change', {
      base: info.slug,
      version: diff.seq,
      origin: diff.origin,
      added: diff.created.map(json),
      changed: diff.updated.map((u) => ({ before: json(u.before), after: json(u.after) })),
      removed: diff.deleted.map(json),
    } satisfies ChangeEvent);
  }

  /** Où en est la copie. */
  status(): GateStatus {
    const r = this.replicator;
    const q = r.client?.quota;
    return {
      link: r.link,
      detail: r.linkDetail,
      accessId: this.accessId,
      accessName: this.accessName,
      tier: typeof r.access?.tier === 'string' ? r.access.tier : null,
      filarrWrite: r.access?.write === true,
      creator: r.creator.status,
      files: { linked: r.files !== null, signed: r.files?.signed ?? false, pending: r.files?.pending.n ?? 0 },
      bases: [...r.bases.values()].map((b) => ({ slug: b.manifest?.slug ?? null, status: b.mirror.status, version: b.mirror.seq, problem: b.mirror.problem?.message ?? null })),
      lastChangeAt: r.lastChangeAt,
      quota: q ? { ...(q.sync ? { sync: q.sync } : {}), ...(q.bytes ? { bytes: q.bytes } : {}), ...(q.writes ? { writes: q.writes } : {}) } : null,
    };
  }

  /** Relit tout depuis Filarr (droits, manifestes, têtes changées). */
  async refresh(): Promise<void> {
    await this.replicator.pollOnce();
  }

  /**
   * Un réveil poussé par Filarr (`notifyUrl`, api-base-1 rév. 3 § 5 bis), reçu par
   * VOTRE serveur : la bibliothèque vérifie la signature (`Filarr-Notify`) et
   * l'horodatage sur le corps BRUT, puis relit. Rend `false` si le réveil est refusé.
   */
  async wake(rawBody: string, signatureHeader: string | null): Promise<boolean> {
    const identity = this.replicator.identity;
    if (!identity) return false;
    const verdict = await verifyNotify(storeCrypto, identity.aNotify, signatureHeader, rawBody, Math.floor(Date.now() / 1000));
    if (verdict !== 'ok') return false;
    const body = readNotifyBody(rawBody, identity.accessId);
    if (!body) return false;
    await this.replicator.wake(body);
    return true;
  }

  /** Arrête la réplique et efface les clés et les lignes de la mémoire. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.replicator.stop();
    for (const b of this.replicator.bases.values()) b.mirror.wipe();
    this.listeners.clear();
  }
}

/**
 * Ouvre la boîte noire dans ce programme : lit l'accès, ouvre et vérifie ses
 * droits, déchiffre les bases. Rend quand la première copie est prête.
 */
export async function openGate(options: OpenGateOptions): Promise<Gate> {
  if (!options || typeof options.token !== 'string') throw new ApiError(400, 'token_required', 'openGate({ token }) : le jeton de l’accès est attendu (flr_live_…).');
  const cache: BlockCache =
    options.cache && typeof options.cache === 'object'
      ? new (await import('./node/diskCache')).DiskBlockCache(options.cache.dir)
      : new MemoryBlockCache();
  const replicator = new Replicator({
    apiUrl: options.apiUrl ?? DEFAULT_API_URL,
    version: `lib-${GATE_LIB_VERSION}`,
    cache,
    site: Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join(''),
    pollIntervalMs: Math.max(300, options.pollSeconds ?? 300) * 1000,
    ...(options.fetch ? { fetchImpl: options.fetch } : {}),
    ...(options.streamOpener !== undefined ? { streamOpener: options.streamOpener } : {}),
    ...(options.onLog ? { journal: { add: (e) => options.onLog!({ what: e.what, code: e.code, ...(e.note ? { note: e.note } : {}) }) } } : {}),
  });
  if (options.signal?.aborted) throw new ApiError(499, 'aborted', 'Ouverture annulée');
  const abort = () => void replicator.stop();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    await replicator.start(options.token, { live: options.live !== false });
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
  const link = replicator.link;
  if (link === 'revoked' || link === 'expired' || link === 'unknown_access') {
    const detail = replicator.linkDetail ?? link;
    await replicator.forget();
    throw new ApiError(401, link === 'unknown_access' ? 'api_access_unknown' : link === 'expired' ? 'api_access_expired' : 'api_access_revoked', detail);
  }
  return new Gate(replicator, options);
}

declare const __GATE_VERSION__: string | undefined;
/** La version de la bibliothèque (posée à la construction). */
export const GATE_LIB_VERSION: string = typeof __GATE_VERSION__ === 'string' ? __GATE_VERSION__ : '0.0.0-dev';
