/**
 * Le journal LOCAL de la boîte noire : chaque requête servie, chaque échange
 * avec Filarr, chaque geste d'administration. Gardé sur cette machine (fichiers
 * JSON Lines par jour, retenue réglable), jamais envoyé ailleurs. Il ne contient
 * ni jeton, ni clé, ni contenu de ligne : des chemins, des codes, des comptes.
 */

import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export type JournalKind = 'read' | 'write' | 'error' | 'filarr' | 'admin';

export interface JournalEntry {
  at: string;
  kind: JournalKind;
  /** Qui : le nom d'une clé d'application, « Filarr », « administration », « inconnu · ip ». */
  who: string;
  /** Quoi : méthode et chemin, ou l'événement. */
  what: string;
  /** Le résultat : un statut HTTP, ou un mot (« synchro », « clés »…). */
  code: string;
  ms?: number;
  note?: string;
}

const MEMORY_MAX = 5000;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export class Journal {
  private entries: JournalEntry[] = [];
  private listeners = new Set<(e: JournalEntry) => void>();
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string | null,
    public retentionDays = 30
  ) {}

  add(entry: Omit<JournalEntry, 'at'> & { at?: string }): JournalEntry {
    const full: JournalEntry = { at: entry.at ?? new Date().toISOString(), ...entry } as JournalEntry;
    this.entries.push(full);
    if (this.entries.length > MEMORY_MAX) this.entries.splice(0, this.entries.length - MEMORY_MAX);
    for (const fn of this.listeners) fn(full);
    if (this.dir) {
      const dir = this.dir;
      const line = `${JSON.stringify(full)}\n`;
      this.writing = this.writing
        .then(async () => {
          await mkdir(dir, { recursive: true });
          await appendFile(join(dir, `${full.at.slice(0, 10)}.jsonl`), line, { mode: 0o600 });
        })
        .catch(() => undefined);
    }
    return full;
  }

  subscribe(fn: (e: JournalEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Les entrées récentes (en mémoire), les plus récentes d'abord. */
  list(opts: { kind?: JournalKind | 'all'; q?: string; limit?: number; since?: string } = {}): JournalEntry[] {
    const q = opts.q?.trim().toLowerCase() ?? '';
    const out: JournalEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < (opts.limit ?? 200); i -= 1) {
      const e = this.entries[i]!;
      if (opts.since && e.at < opts.since) break;
      if (opts.kind && opts.kind !== 'all' && e.kind !== opts.kind) continue;
      if (q && !`${e.who} ${e.what} ${e.code} ${e.note ?? ''}`.toLowerCase().includes(q)) continue;
      out.push(e);
    }
    return out;
  }

  /** Le compte des entrées récentes par sorte. */
  counts(since?: string): Record<JournalKind | 'all', number> {
    const out = { all: 0, read: 0, write: 0, error: 0, filarr: 0, admin: 0 };
    for (const e of this.entries) {
      if (since && e.at < since) continue;
      out.all += 1;
      out[e.kind] += 1;
    }
    return out;
  }

  /** Tout le journal gardé, en JSON Lines (les fichiers, sinon la mémoire). */
  async export(): Promise<string> {
    await this.writing;
    if (!this.dir) return this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => DAY_FILE.test(f)).sort();
    let out = '';
    for (const f of files) out += await readFile(join(this.dir, f), 'utf8').catch(() => '');
    return out;
  }

  /** Efface les jours au-delà de la retenue. */
  async prune(now = Date.now()): Promise<void> {
    if (!this.dir) return;
    const limit = new Date(now - this.retentionDays * 86_400_000).toISOString().slice(0, 10);
    for (const f of await readdir(this.dir).catch(() => [] as string[])) {
      const m = DAY_FILE.exec(f);
      if (m && m[1]! < limit) await rm(join(this.dir, f), { force: true });
    }
  }

  async clear(): Promise<void> {
    this.entries = [];
    await this.writing;
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }

  flushed(): Promise<void> {
    return this.writing;
  }
}
