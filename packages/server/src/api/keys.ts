/**
 * Les clés des applications : vos logiciels n'ont jamais le jeton Filarr. Chacun
 * reçoit SA clé, limitée aux points d'accès qu'il lui faut, en lecture ou en
 * écriture, avec un débit maximal et des adresses autorisées. La clé n'est
 * montrée qu'une fois ; la boîte noire n'en garde que l'empreinte (SHA-256).
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { AppKeyRecord, KeyScope, StateStore } from '../state';

export type WriteOp = 'create' | 'update' | 'delete';

export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

/** `gk_<trois lettres du nom>_<32 caractères>` */
export function newAppKey(name: string): string {
  const tag = (name.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '') || 'app').slice(0, 3).padEnd(3, 'x');
  return `gk_${tag}_${randomBytes(24).toString('base64url')}`;
}

// ==================== Adresses ====================

function ipToBigInt(ip: string): { v: bigint; bits: number } | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  if (isIP(ip) === 4) return { v: ip.split('.').reduce((n, part) => (n << 8n) + BigInt(Number(part)), 0n), bits: 32 };
  if (isIP(ip) === 6) {
    const [head, tail] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
    const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
    if (groups.length !== 8) return null;
    return { v: groups.reduce((n, g) => (n << 16n) + BigInt(parseInt(g || '0', 16)), 0n), bits: 128 };
  }
  return null;
}

/** `ip` est-elle dans la plage `cidr` (ou égale à l'adresse) ? */
export function ipInRange(ip: string, cidr: string): boolean {
  const [base, len] = cidr.trim().split('/');
  const a = ipToBigInt(ip);
  const b = ipToBigInt(base ?? '');
  if (!a || !b || a.bits !== b.bits) return false;
  const prefix = len === undefined ? a.bits : Number(len);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > a.bits) return false;
  const shift = BigInt(a.bits - prefix);
  return a.v >> shift === b.v >> shift;
}

export function validRange(cidr: string): boolean {
  const [base, len] = cidr.trim().split('/');
  const parsed = ipToBigInt(base ?? '');
  if (!parsed) return false;
  if (len === undefined) return true;
  const n = Number(len);
  return Number.isInteger(n) && n >= 0 && n <= parsed.bits;
}

// ==================== Le registre des clés ====================

export interface KeyCheck {
  key: AppKeyRecord | null;
  /** Code de refus, s'il y en a un. */
  refusal?: { status: number; code: string; message: string; retryAfter?: number };
}

export interface NewKeyInput {
  name: string;
  scopes: KeyScope[];
  sql?: boolean;
  mcp?: boolean;
  rateLimit?: number;
  ipAllow?: string[];
  expiresAt?: string | null;
}

export class KeyRegistry {
  /** Requêtes de la minute en cours, par clé. */
  private windows = new Map<string, { start: number; count: number }>();
  /** Requêtes servies, par clé et par heure (24 h glissantes). */
  private hourly = new Map<string, Array<{ hour: number; count: number }>>();

  constructor(private readonly state: StateStore) {}

  list(): AppKeyRecord[] {
    return this.state.data.keys;
  }

  get(id: string): AppKeyRecord | undefined {
    return this.state.data.keys.find((k) => k.id === id);
  }

  create(input: NewKeyInput): { record: AppKeyRecord; key: string } {
    const name = input.name.trim();
    if (!name) throw new Error('Nom de la clé manquant');
    for (const r of input.ipAllow ?? []) if (!validRange(r)) throw new Error(`Adresse ou plage invalide : ${r}`);
    const key = newAppKey(name);
    const record: AppKeyRecord = {
      id: randomUUID(),
      name,
      prefix: `${key.slice(0, 9)}…`,
      hash: hashKey(key),
      scopes: input.scopes,
      sql: input.sql ?? false,
      mcp: input.mcp ?? false,
      rateLimit: Math.max(1, Math.min(100_000, Math.round(input.rateLimit ?? 600))),
      ipAllow: input.ipAllow ?? [],
      expiresAt: input.expiresAt ?? null,
      paused: false,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      lastIp: null,
    };
    this.state.data.keys.push(record);
    this.state.saveNow();
    return { record, key };
  }

  update(id: string, patch: Partial<Pick<AppKeyRecord, 'name' | 'paused' | 'scopes' | 'sql' | 'mcp' | 'rateLimit' | 'ipAllow' | 'expiresAt'>>): AppKeyRecord {
    const record = this.get(id);
    if (!record) throw new Error('Clé inconnue');
    for (const r of patch.ipAllow ?? []) if (!validRange(r)) throw new Error(`Adresse ou plage invalide : ${r}`);
    Object.assign(record, patch);
    this.state.saveNow();
    return record;
  }

  /** Une clé révoquée cesse de répondre tout de suite : son empreinte disparaît. */
  revoke(id: string): boolean {
    const before = this.state.data.keys.length;
    this.state.data.keys = this.state.data.keys.filter((k) => k.id !== id);
    this.state.saveNow();
    return this.state.data.keys.length < before;
  }

  /** Requêtes servies à une clé sur les dernières 24 h. */
  count24h(id: string): number {
    const hour = Math.floor(Date.now() / 3_600_000);
    return (this.hourly.get(id) ?? []).filter((h) => h.hour > hour - 24).reduce((n, h) => n + h.count, 0);
  }

  /** La part du débit consommée dans la minute en cours (0 à 1). */
  rateUsage(id: string): number {
    const w = this.windows.get(id);
    const key = this.get(id);
    if (!w || !key || Date.now() - w.start >= 60_000) return 0;
    return w.count / key.rateLimit;
  }

  private bumpHourly(id: string): void {
    const hour = Math.floor(Date.now() / 3_600_000);
    let entries = this.hourly.get(id);
    if (!entries) this.hourly.set(id, (entries = []));
    const last = entries[entries.length - 1];
    if (last && last.hour === hour) last.count += 1;
    else entries.push({ hour, count: 1 });
    while (entries.length > 0 && entries[0]!.hour <= hour - 24) entries.shift();
  }

  /** Authentifie `Authorization: Bearer gk_…` (ou `X-Gate-Key`) et applique débit, adresses, échéance. */
  check(header: string | undefined, alt: string | undefined, ip: string): KeyCheck {
    const raw = (header?.startsWith('Bearer ') ? header.slice(7) : alt ?? '').trim();
    if (!raw) return { key: null, refusal: { status: 401, code: 'key_missing', message: 'Clé absente : Authorization: Bearer gk_…' } };
    const hash = Buffer.from(hashKey(raw), 'hex');
    const record = this.state.data.keys.find((k) => {
      const other = Buffer.from(k.hash, 'hex');
      return other.length === hash.length && timingSafeEqual(other, hash);
    });
    if (!record) return { key: null, refusal: { status: 401, code: 'key_unknown', message: 'Clé inconnue ou révoquée' } };
    if (record.paused) return { key: record, refusal: { status: 403, code: 'key_paused', message: 'Clé en pause' } };
    if (record.expiresAt && Date.parse(record.expiresAt) < Date.now())
      return { key: record, refusal: { status: 403, code: 'key_expired', message: 'Clé expirée' } };
    if (record.ipAllow.length > 0 && !record.ipAllow.some((r) => ipInRange(ip, r)))
      return { key: record, refusal: { status: 403, code: 'ip_forbidden', message: `Adresse ${ip} non autorisée pour cette clé` } };
    const now = Date.now();
    let w = this.windows.get(record.id);
    if (!w || now - w.start >= 60_000) this.windows.set(record.id, (w = { start: now, count: 0 }));
    if (w.count >= record.rateLimit) {
      const retryAfter = Math.ceil((w.start + 60_000 - now) / 1000);
      return { key: record, refusal: { status: 429, code: 'key_rate', message: `Débit de la clé atteint (${record.rateLimit}/min)`, retryAfter } };
    }
    w.count += 1;
    this.bumpHourly(record.id);
    record.lastUsedAt = new Date().toISOString();
    record.lastIp = ip;
    // Une trace d'usage : l'état s'écrit au plus toutes les 5 s, même sous une forte charge
    this.state.save(5000);
    return { key: record };
  }
}

// ==================== Les droits d'une clé ====================

export function canReadBase(key: AppKeyRecord, storeId: string): boolean {
  return key.scopes.some((s) => s.target === 'all' || (s.target === 'base' && s.storeId === storeId && s.read));
}

export function canReadView(key: AppKeyRecord, storeId: string, viewId: string): boolean {
  return canReadBase(key, storeId) || key.scopes.some((s) => s.target === 'view' && s.storeId === storeId && s.viewId === viewId);
}

export function canReadQuery(key: AppKeyRecord, queryId: string): boolean {
  return key.scopes.some((s) => s.target === 'all' || (s.target === 'query' && s.queryId === queryId));
}

export function canWrite(key: AppKeyRecord, storeId: string, op: WriteOp): boolean {
  return key.scopes.some((s) => s.target === 'base' && s.storeId === storeId && s[op] === true);
}
