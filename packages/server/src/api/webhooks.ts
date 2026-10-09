/**
 * Les webhooks : quand une ligne change dans Filarr (ou par l'API de cette boîte
 * noire), la ligne déchiffrée part vers votre adresse, SIGNÉE.
 *
 * - En-têtes : `Filarr-Gate-Event`, `Filarr-Gate-Delivery`,
 *   `Filarr-Gate-Signature: t=<secondes>,v1=<hex>` avec
 *   `v1 = HMAC-SHA256(secret, t + "." + corps)`. Le destinataire vérifie la
 *   signature sur le corps BRUT et refuse un horodatage de plus de 5 minutes.
 * - Reprises : 8 essais en 24 h au plus, délai doublé à chaque échec (5 min,
 *   10, 20…), `Retry-After` du destinataire honoré ; puis abandon noté au journal.
 * - Les livraisons en attente vivent en MÉMOIRE seulement : leurs corps portent
 *   des lignes en clair, qui ne s'écrivent jamais sur le disque. Un redémarrage
 *   les abandonne (et le journal le dit).
 */

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8Encode } from '../../../core/src/engine/store/crypto';
import { randomBytes, randomToken, randomUUID, timingSafeEqualStr, toHex } from '../../../gate/src/util/bytes';
import { compileViewFilter } from '../../../core/src/viewEngine';
import { parseStatement } from '../../../core/src/engine/sql/parser';
import { catalogOf, runSelect, type SqlCatalog } from '../../../core/src/engine/sql/run';
import type { SqlValue } from '../../../core/src/engine/sql/values';
import type { DbRow } from '../../../core/src/types';
import type { Journal } from '../journal';
import type { Metrics } from '../metrics';
import type { GateBase, QuotaAlert } from '../../../gate/src/replica/replicator';
import type { RowDiff } from '../../../gate/src/replica/store';
import type { DepositRecord, StateStore, WebhookEvent, WebhookRecord } from '../state';
import { rowJson } from '../../../gate/src/data/fields';
import type { BaseInfo, GateModel } from '../../../gate/src/data/model';

export const SIGNATURE_TOLERANCE_S = 300;
export const MAX_ATTEMPTS = 8;

/** Signe un corps : l'en-tête `Filarr-Gate-Signature`. */
export function signPayload(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = toHex(hmac(sha256, utf8Encode(secret), utf8Encode(`${t}.${body}`)));
  return `t=${t},v1=${v1}`;
}

/** Vérifie une signature (ce que fait le destinataire). */
export function verifySignature(secret: string, body: string, header: string, now = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now - t) > SIGNATURE_TOLERANCE_S || !parts.v1) return false;
  const expected = toHex(hmac(sha256, utf8Encode(secret), utf8Encode(`${t}.${body}`)));
  return timingSafeEqualStr(expected, parts.v1);
}

export const newWebhookSecret = (): string => `whsec_${randomToken(24)}`;

export interface Delivery {
  id: string;
  hookId: string;
  event: string;
  /** Un libellé court de la ligne (son titre, sinon son identifiant). */
  label: string;
  at: string;
  attempt: number;
  status: number | null;
  ms: number | null;
  error?: string;
  nextAt?: string;
  final: boolean;
  /** Le corps envoyé (en mémoire seulement). */
  body: string;
}

interface Pending {
  hook: WebhookRecord;
  deliveryId: string;
  event: string;
  label: string;
  body: string;
  attempt: number;
  dueAt: number;
}

/** La condition SQL d'un webhook, évaluée sur une ligne par le moteur SQL de Filarr. */
export function compileFilter(expr: string | null): ((row: Record<string, unknown>) => boolean) | null {
  if (!expr || expr.trim() === '') return null;
  const sql = `SELECT 1 FROM ligne WHERE ${expr}`;
  const stmt = parseStatement(sql);
  if (stmt.kind !== 'select') throw new Error('condition illisible');
  return (row) => {
    const columns = Object.keys(row);
    const toSql = (v: unknown): SqlValue =>
      v === null || v === undefined
        ? null
        : typeof v === 'boolean'
          ? v
            ? 1n
            : 0n
          : typeof v === 'number'
            ? v
            : Array.isArray(v)
              ? v.join(', ')
              : typeof v === 'object'
                ? JSON.stringify(v)
                : String(v);
    const catalog: SqlCatalog = catalogOf([
      {
        name: 'ligne',
        columns: columns.map((name) => ({ name, affinity: typeof row[name] === 'number' ? 'REAL' : 'TEXT' })),
        rows: [columns.map((c) => toSql(row[c]))],
      },
    ]);
    try {
      return runSelect(catalog, stmt).rows.length > 0;
    } catch {
      return false;
    }
  };
}

export interface WebhookOptions {
  /** Délais entre essais, en millisecondes (d'office : 5 min doublées). */
  delaysMs?: number[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class WebhookService {
  private queue: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly deliveries = new Map<string, Delivery[]>();
  private readonly delays: number[];
  private stopped = false;
  private inFlight = 0;

  constructor(
    private readonly state: StateStore,
    private readonly model: GateModel,
    private readonly journal: Journal,
    private readonly metrics: Metrics,
    private readonly opts: WebhookOptions = {}
  ) {
    this.delays = opts.delaysMs ?? [0, 5, 10, 20, 40, 80, 160, 320].map((m) => m * 60_000);
  }

  list(): WebhookRecord[] {
    return this.state.data.webhooks;
  }

  get(id: string): WebhookRecord | undefined {
    return this.state.data.webhooks.find((h) => h.id === id);
  }

  create(input: Omit<WebhookRecord, 'id' | 'secret' | 'createdAt' | 'paused'> & { paused?: boolean }): WebhookRecord {
    this.validate(input);
    const hook: WebhookRecord = {
      id: randomUUID(),
      secret: newWebhookSecret(),
      createdAt: new Date().toISOString(),
      paused: input.paused ?? false,
      name: input.name.trim(),
      url: input.url.trim(),
      target: input.target,
      events: input.events,
      filter: input.filter?.trim() || null,
      transition: input.transition,
      fields: input.fields,
      expand: input.expand,
    };
    this.state.data.webhooks.push(hook);
    this.state.saveNow();
    return hook;
  }

  update(id: string, patch: Partial<Omit<WebhookRecord, 'id' | 'secret' | 'createdAt'>>): WebhookRecord {
    const hook = this.get(id);
    if (!hook) throw new Error('Webhook inconnu');
    const next = { ...hook, ...patch };
    this.validate(next);
    Object.assign(hook, next);
    this.state.saveNow();
    return hook;
  }

  remove(id: string): boolean {
    const before = this.state.data.webhooks.length;
    this.state.data.webhooks = this.state.data.webhooks.filter((h) => h.id !== id);
    this.queue = this.queue.filter((p) => p.hook.id !== id);
    this.deliveries.delete(id);
    this.state.saveNow();
    return this.state.data.webhooks.length < before;
  }

  rotate(id: string): WebhookRecord {
    const hook = this.get(id);
    if (!hook) throw new Error('Webhook inconnu');
    hook.secret = newWebhookSecret();
    this.state.saveNow();
    return hook;
  }

  private validate(h: Pick<WebhookRecord, 'name' | 'url' | 'events' | 'filter' | 'target'>): void {
    if (!h.name?.trim()) throw new Error('Nom manquant');
    let url: URL;
    try {
      url = new URL(h.url);
    } catch {
      throw new Error('Adresse invalide');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Adresse http(s) attendue');
    if (!Array.isArray(h.events) || h.events.length === 0) throw new Error('Au moins un événement');
    const rowEvents = h.events.filter((e) => e.startsWith('row.'));
    if (rowEvents.length > 0 && !h.target) throw new Error('Une base est attendue pour les événements de lignes');
    try {
      compileFilter(h.filter);
    } catch (err) {
      throw new Error(`Condition illisible : ${(err as Error).message}`);
    }
  }

  // ==================== Événements ====================

  /** Un changement de lignes (de Filarr ou de cette boîte noire). */
  onChange(base: GateBase, diff: RowDiff): void {
    const hooks = this.list().filter((h) => !h.paused && h.target?.storeId === base.storeId);
    if (hooks.length === 0) return;
    const info = this.model.baseById(base.storeId);
    if (!info) return;
    const env = this.model.env(info);
    const json = (row: DbRow) => rowJson(info.fields, row, env);
    for (const hook of hooks) {
      const view = hook.target?.viewId ? info.views.find((v) => v.view.id === hook.target!.viewId) : undefined;
      const inView = view
        ? (row: DbRow) => {
            const test = compileViewFilter({ properties: info.properties, rows: [row] }, view.view, env.ctx);
            return test ? test(row) : true;
          }
        : () => true;
      let filter: ((row: Record<string, unknown>) => boolean) | null;
      try {
        filter = compileFilter(hook.filter);
      } catch {
        continue;
      }
      const passes = (row: DbRow, obj: Record<string, unknown>) => inView(row) && (!filter || filter(obj));
      const emit = (event: WebhookEvent, row: DbRow, obj: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
        if (!hook.events.includes(event)) return;
        this.enqueue(hook, event, this.labelOf(info, obj), {
          event,
          base: info.slug,
          ...(view ? { view: view.slug } : {}),
          version: diff.seq,
          origin: diff.origin,
          ...extra,
          row: this.shape(hook, info, obj),
        });
      };
      for (const row of diff.created) {
        const obj = json(row);
        if (passes(row, obj)) emit('row.created', row, obj);
      }
      for (const { before, after } of diff.updated) {
        const now = json(after);
        const was = json(before);
        const nowPasses = passes(after, now);
        const wasPasses = passes(before, was);
        if (!nowPasses || (hook.transition && wasPasses)) continue;
        const changed = Object.keys(now).filter((k) => k !== 'updated_at' && JSON.stringify(now[k]) !== JSON.stringify(was[k]));
        emit('row.updated', after, now, {
          changed,
          before: Object.fromEntries(changed.map((k) => [k, was[k]])),
        });
      }
      for (const row of diff.deleted) {
        const obj = json(row);
        if (passes(row, obj)) emit('row.deleted', row, obj);
      }
    }
  }

  /** Un avis de quota de Filarr (flux, contrat § 6) : `gate.quota`. */
  onQuota(alert: QuotaAlert): void {
    for (const hook of this.list()) {
      if (hook.paused || !hook.events.includes('gate.quota')) continue;
      this.enqueue(hook, 'gate.quota', `${alert.name} ${alert.pct} %`, { event: 'gate.quota', name: alert.name, pct: alert.pct, at: alert.at });
    }
  }

  /** Révision 3 : un fichier déposé par cette boîte a été rangé par l'appli (`file.filed`, jamais où ni sous quel nom). */
  onFile(record: DepositRecord): void {
    if (record.status !== 'filed') return;
    for (const hook of this.list()) {
      if (hook.paused || !hook.events.includes('file.filed')) continue;
      this.enqueue(hook, 'file.filed', record.id, {
        event: 'file.filed',
        file: { id: record.id, depositId: record.depositId, status: record.status, depositedAt: record.depositedAt, filedAt: record.filedAt, sizeBytes: record.sizeBytes, source: record.source },
      });
    }
  }

  /** Une synchro externe a fini un passage (`sync.done`) ou échoué (`sync.failed`). */
  onSync(event: 'sync.done' | 'sync.failed', payload: Record<string, unknown>): void {
    for (const hook of this.list()) {
      if (hook.paused || !hook.events.includes(event)) continue;
      this.enqueue(hook, event, String(payload.name ?? payload.defId ?? ''), { event, ...payload });
    }
  }

  /** « Envoyer un essai ». */
  test(id: string): Delivery {
    const hook = this.get(id);
    if (!hook) throw new Error('Webhook inconnu');
    return this.enqueue(hook, 'ping', 'essai', { event: 'ping', webhook: hook.name, at: new Date().toISOString() }, true);
  }

  private labelOf(info: BaseInfo, obj: Record<string, unknown>): string {
    const title = info.fields.find((f) => f.prop.type === 'text');
    const v = title ? obj[title.name] : null;
    return typeof v === 'string' && v !== '' ? v : String(obj.id);
  }

  /** Les champs envoyés, et les relations résolues (lignes visées d'une base OUVERTE). */
  private shape(hook: WebhookRecord, info: BaseInfo, obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = hook.fields ? Object.fromEntries(Object.entries(obj).filter(([k]) => k === 'id' || hook.fields!.includes(k))) : { ...obj };
    for (const name of hook.expand) {
      const field = info.fields.find((f) => f.name === name);
      if (!field || field.prop.type !== 'relation' || !field.target || !(name in out)) continue;
      const target = this.model.bases().find((b) => b.dbId === field.target);
      if (!target) continue;
      const ids = Array.isArray(out[name]) ? (out[name] as string[]) : [];
      const env = this.model.env(target);
      const resolved = ids.map((id) => {
        const r = target.base.mirror.rowById(id);
        return r ? rowJson(target.fields, r, env) : { id };
      });
      out[name] = field.prop.single ? (resolved[0] ?? null) : resolved;
    }
    return out;
  }

  private enqueue(hook: WebhookRecord, event: string, label: string, payload: Record<string, unknown>, immediate = false): Delivery {
    const deliveryId = `dlv_${Date.now().toString(36)}${toHex(randomBytes(5))}`;
    const body = JSON.stringify({ id: deliveryId, ...payload });
    const pending: Pending = { hook, deliveryId, event, label, body, attempt: 1, dueAt: Date.now() };
    const record: Delivery = { id: deliveryId, hookId: hook.id, event, label, at: new Date().toISOString(), attempt: 1, status: null, ms: null, final: false, body };
    this.record(record);
    this.queue.push(pending);
    if (immediate || this.queue.length === 1) this.schedule(0);
    else this.schedule();
    return record;
  }

  private record(d: Delivery): void {
    let list = this.deliveries.get(d.hookId);
    if (!list) this.deliveries.set(d.hookId, (list = []));
    list.unshift(d);
    if (list.length > 200) list.length = 200;
  }

  private schedule(delay?: number): void {
    if (this.stopped) return;
    const next = this.queue.reduce((min, p) => Math.min(min, p.dueAt), Infinity);
    if (next === Infinity) return;
    const wait = delay ?? Math.max(0, next - Date.now());
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.drain(), wait);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async drain(): Promise<void> {
    this.timer = null;
    const now = Date.now();
    const due = this.queue.filter((p) => p.dueAt <= now);
    this.queue = this.queue.filter((p) => p.dueAt > now);
    await Promise.all(due.map((p) => this.attempt(p)));
    this.schedule();
  }

  private async attempt(p: Pending): Promise<void> {
    this.inFlight += 1;
    const started = Date.now();
    let status: number | null = null;
    let error: string | undefined;
    let retryAfterMs = 0;
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(p.hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'filarr-gate-webhook',
          'Filarr-Gate-Event': p.event,
          'Filarr-Gate-Delivery': p.deliveryId,
          'Filarr-Gate-Signature': signPayload(p.hook.secret, p.body),
        },
        body: p.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      status = res.status;
      const ra = res.headers.get('retry-after');
      if (ra) retryAfterMs = Number.isFinite(Number(ra)) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - Date.now());
      await res.arrayBuffer().catch(() => undefined);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      this.inFlight -= 1;
    }
    const ms = Date.now() - started;
    const ok = status !== null && status >= 200 && status < 300;
    const last = p.attempt >= MAX_ATTEMPTS;
    const delay = Math.max(this.delays[p.attempt] ?? this.delays[this.delays.length - 1]!, retryAfterMs);
    const record: Delivery = {
      id: p.deliveryId,
      hookId: p.hook.id,
      event: p.event,
      label: p.label,
      at: new Date(started).toISOString(),
      attempt: p.attempt,
      status,
      ms,
      ...(error ? { error } : {}),
      ...(!ok && !last ? { nextAt: new Date(Date.now() + delay).toISOString() } : {}),
      final: ok || last,
      body: p.body,
    };
    // La première trace (en attente) est remplacée par le résultat du premier essai
    const list = this.deliveries.get(p.hook.id);
    const pendingIndex = list?.findIndex((d) => d.id === p.deliveryId && d.status === null && d.attempt === p.attempt) ?? -1;
    if (list && pendingIndex >= 0) list.splice(pendingIndex, 1);
    this.record(record);
    this.metrics.inc('filarr_gate_webhook_deliveries_total', { result: ok ? 'ok' : last ? 'abandoned' : 'retry' });
    const code = status === null ? 'erreur' : String(status);
    if (ok) return;
    if (last) {
      this.journal.add({ kind: 'error', who: `webhook « ${p.hook.name} »`, what: `${p.event} · ${p.label}`, code, ms, note: `abandon après ${MAX_ATTEMPTS} essais` });
      return;
    }
    this.journal.add({ kind: 'error', who: `webhook « ${p.hook.name} »`, what: `${p.event} · ${p.label}`, code, ms, note: `nouvel essai dans ${Math.round(delay / 60_000)} min` });
    this.queue.push({ ...p, attempt: p.attempt + 1, dueAt: Date.now() + delay });
  }

  /** Livraisons en reprise et abandons, pour le tableau de bord. */
  stats(): { delivered24h: number; retrying: number; abandoned24h: number } {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    let delivered = 0;
    let abandoned = 0;
    for (const list of this.deliveries.values()) {
      for (const d of list) {
        if (d.at < since) continue;
        if (d.status !== null && d.status >= 200 && d.status < 300) delivered += 1;
        else if (d.final && d.attempt >= MAX_ATTEMPTS) abandoned += 1;
      }
    }
    return { delivered24h: delivered, retrying: this.queue.length, abandoned24h: abandoned };
  }

  pendingFor(hookId: string): number {
    return this.queue.filter((p) => p.hook.id === hookId).length;
  }

  /** Oublie les livraisons en attente et leur trace (oubli de la machine). */
  clearQueue(): void {
    this.queue = [];
    this.deliveries.clear();
  }

  /** À l'arrêt : les livraisons en attente sont abandonnées (elles ne s'écrivent pas sur le disque). */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.queue.length > 0) {
      this.journal.add({ kind: 'error', who: 'webhooks', what: 'arrêt de la boîte noire', code: 'abandon', note: `${this.queue.length} livraison(s) en attente abandonnée(s)` });
    }
    this.queue = [];
  }

  get busy(): boolean {
    return this.inFlight > 0;
  }
}
