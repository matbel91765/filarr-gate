/**
 * La fente à fichiers côté serveur (`gate-fichiers-1` § 12) : `POST /v1/files`
 * (multipart : `file`, `path`, `tags`), `GET /v1/files/<id>`, le suivi local des
 * dépôts (identifiant, statut, taille, heures — jamais un nom ni un contenu) et
 * le webhook local `file.filed` quand l'appli a rangé le fichier.
 *
 * Les refus locaux ne partent jamais chez Filarr ; ils restent au journal LOCAL
 * de la boîte (« ils ne sont jamais partis », F2).
 */

import type { FileFilter } from '../../core/src/engine/gate/files';
import { ApiError } from '../../gate/src/data/query';
import { depositFile, depositStatus, listDeposits, type DepositInput } from '../../gate/src/files';
import { randomToken } from '../../gate/src/util/bytes';
import type { GateCore } from './core';
import type { AppKeyRecord, DepositRecord } from './state';

/** Dépôts gardés dans l'état (les plus récents). */
const KEEP_DEPOSITS = 500;

export class FileService {
  constructor(private readonly core: GateCore) {}

  filter(): FileFilter {
    const s = this.core.settings;
    return { deny: s.filesDeny, ...(s.filesAllow.length > 0 ? { allow: s.filesAllow } : {}), maxBytes: s.filesMaxBytes };
  }

  list(): DepositRecord[] {
    return this.core.state.data.deposits;
  }

  get(id: string): DepositRecord | undefined {
    return this.core.state.data.deposits.find((d) => d.id === id || d.depositId === id);
  }

  private remember(record: DepositRecord): void {
    const d = this.core.state.data;
    d.deposits = [record, ...d.deposits.filter((x) => x.id !== record.id)].slice(0, KEEP_DEPOSITS);
    this.core.state.save();
  }

  /** Dépose un fichier pour une clé d'application (ou pour l'administration, `key` absent). */
  async deposit(content: Uint8Array, input: DepositInput, key: AppKeyRecord | null): Promise<DepositRecord> {
    const record: DepositRecord = {
      id: `dp_${randomToken(12)}`,
      depositId: null,
      seq: null,
      status: 'sending',
      sizeBytes: content.length,
      source: key?.name ?? input.source ?? null,
      createdAt: new Date().toISOString(),
      depositedAt: null,
      filedAt: null,
      error: null,
    };
    const who = key ? key.name : 'administration';
    try {
      const out = await depositFile(this.core.replicator, content, { ...input, ...(key ? { source: key.name } : {}) }, this.filter());
      record.depositId = out.depositId;
      record.seq = out.seq;
      record.status = 'deposited';
      record.depositedAt = out.depositedAt;
      this.remember(record);
      this.core.metrics.inc('filarr_gate_files_total', { result: 'deposited' });
      this.core.journal.add({ kind: 'files', who, what: `dépôt ${record.id}`, code: 'déposé', note: `${content.length} octets${out.seq !== null ? ` · n° ${out.seq}` : ''}` });
      return record;
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(500, 'deposit_failed', (err as Error).message);
      const local = ['file_type_refused', 'file_too_large', 'box_full', 'name_required', 'bad_tags', 'bad_path', 'files_not_linked', 'creator_unauthenticated', 'box_not_signed', 'no_token'].includes(e.code) && record.depositId === null;
      this.core.metrics.inc('filarr_gate_files_total', { result: local ? 'refused_locally' : 'refused_by_filarr' });
      // Les refus locaux ne sont jamais partis : au journal local seulement, sans le nom du fichier
      this.core.journal.add({ kind: 'files', who, what: local ? 'fichier refusé avant envoi' : 'dépôt refusé par Filarr', code: e.code, note: `${content.length} octets` });
      throw e;
    }
  }

  /** Le statut d'un dépôt (relu chez Filarr tant qu'il n'est pas rangé). */
  async status(id: string): Promise<DepositRecord> {
    const record = this.get(id);
    if (!record) throw new ApiError(404, 'deposit_not_found', `Dépôt inconnu : ${id}`);
    if (record.depositId && record.status === 'deposited') {
      try {
        const st = await depositStatus(this.core.replicator, record.depositId);
        this.update(record, st.status, st.filedAt);
      } catch {
        /* Filarr injoignable : le dernier statut connu */
      }
    }
    return record;
  }

  private update(record: DepositRecord, status: DepositRecord['status'], filedAt: string | null): void {
    if (record.status === status) return;
    const was = record.status;
    record.status = status;
    if (filedAt) record.filedAt = filedAt;
    if (status === 'filed' && !record.filedAt) record.filedAt = new Date().toISOString();
    this.core.state.save();
    this.core.journal.add({ kind: 'files', who: 'Filarr', what: `dépôt ${record.id}`, code: status, note: `était ${was}` });
    if (status === 'filed' || status === 'rejected' || status === 'expired') this.core.webhooks.onFile(record);
  }

  /**
   * Un dépôt de cet accès a changé (message `files` du flux) ; `null` (réveil sans
   * détail) : relire les statuts récents.
   */
  async onFilesMessage(msg: { depositId: string; status: string } | null): Promise<void> {
    if (msg) {
      const record = this.list().find((d) => d.depositId === msg.depositId);
      if (record && ['deposited', 'filed', 'rejected', 'expired'].includes(msg.status)) {
        let filedAt: string | null = null;
        if (msg.status === 'filed') {
          try {
            filedAt = (await depositStatus(this.core.replicator, msg.depositId)).filedAt;
          } catch {
            filedAt = null;
          }
        }
        this.update(record, msg.status as DepositRecord['status'], filedAt);
      }
      return;
    }
    await this.refresh().catch(() => undefined);
  }

  /** Relit les statuts des dépôts en attente (réveil `files`, ou à la demande). */
  async refresh(): Promise<void> {
    const waiting = this.list().filter((d) => d.status === 'deposited' && d.depositId);
    if (waiting.length === 0) return;
    const oldest = waiting.reduce((min, d) => (d.depositedAt && d.depositedAt < min ? d.depositedAt : min), new Date().toISOString());
    const remote = await listDeposits(this.core.replicator, oldest);
    for (const r of remote) {
      const record = waiting.find((d) => d.depositId === r.depositId);
      if (record) this.update(record, r.status, r.filedAt);
    }
  }
}

/** Lit un envoi `multipart/form-data` de `POST /v1/files` : `file`, `path`, `tags` (répétable ou séparé par des virgules). */
export async function readFileUpload(request: Request, maxBytes: number): Promise<{ content: Uint8Array; input: DepositInput }> {
  const type = request.headers.get('content-type') ?? '';
  const declared = Number(request.headers.get('content-length'));
  // Le corps entier ne doit pas dépasser la taille admise (plus l'enveloppe du multipart)
  if (Number.isFinite(declared) && declared > maxBytes + 64 * 1024) {
    throw new ApiError(413, 'file_too_large', `Fichier trop lourd (${maxBytes} octets au plus).`, { limit: maxBytes });
  }
  if (!type.toLowerCase().startsWith('multipart/form-data')) {
    // Un corps brut : le nom vient de `?name=` ou de `X-File-Name`
    const url = new URL(request.url);
    const name = url.searchParams.get('name') ?? request.headers.get('x-file-name') ?? '';
    const content = new Uint8Array(await request.arrayBuffer());
    const tags = url.searchParams.getAll('tags').flatMap((t) => t.split(','));
    const path = url.searchParams.get('path') ?? undefined;
    return { content, input: { name: decodeURIComponent(name), mimeType: type.split(';')[0]?.trim() || undefined, ...(path ? { path } : {}), ...(tags.length ? { tags } : {}) } as DepositInput };
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ApiError(400, 'bad_multipart', 'Envoi multipart illisible (champ « file » attendu).');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new ApiError(400, 'file_required', 'Champ « file » attendu (multipart/form-data).');
  const blob = file as Blob & { name?: string };
  const content = new Uint8Array(await blob.arrayBuffer());
  const pathField = form.get('path');
  const tags = form
    .getAll('tags')
    .filter((t): t is string => typeof t === 'string')
    .flatMap((t) => t.split(','));
  const nameField = form.get('name');
  return {
    content,
    input: {
      name: typeof nameField === 'string' && nameField !== '' ? nameField : (blob.name ?? ''),
      ...(blob.type ? { mimeType: blob.type } : {}),
      ...(typeof pathField === 'string' && pathField !== '' ? { path: pathField } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    },
  };
}
