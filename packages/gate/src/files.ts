/**
 * La fente à fichiers, vue de la bibliothèque et du serveur (`gate-fichiers-1`).
 *
 * 1. le FILTRE, avant que rien ne parte (extension, signature d'exécutable,
 *    taille ; boîte pleine lue dans `self`) ;
 * 2. la boîte ne scelle que vers une clé de boîte SIGNÉE par le créateur, dont
 *    la clé de signature est authentifiée par `creatorTag` ; sinon elle refuse
 *    (« boîte de dépôt non signée ») ;
 * 3. le dépôt scellé au format de la passerelle : `init`, morceaux, `finalize` ;
 * 4. le statut se relit (`GET /api-access/self/files/:did`) : `deposited`,
 *    `filed`, `rejected`, `expired` — jamais OÙ ni sous quel nom.
 *
 * Les refus du serveur gardent leur code (`box_full`, `api_quota_files`…) ; les
 * refus locaux ont les codes de l'API locale (`415 file_type_refused`, `413
 * file_too_large`, `409 box_full`).
 */

import { checkFile, normalizeTags, sealDeposit, MAX_SOURCE_LENGTH, type FileFilter } from '../../core/src/engine/gate/files';
import { curves, storeCrypto } from './crypto/providers';
import { ApiError } from './data/query';
import { FilarrError, RateLimitError, UnreachableError } from './replica/http';
import type { Replicator } from './replica/replicator';

export interface DepositInput {
  /** Nom d'origine du fichier (avec son extension). */
  name: string;
  /** Type MIME ; d'office tiré de l'extension, sinon `application/octet-stream`. */
  mimeType?: string;
  /** Chemin demandé par l'appelant, relatif au dossier cible (appliqué par l'appli si elle l'accepte). */
  path?: string;
  /** Étiquettes : 10 au plus, 40 caractères chacune. */
  tags?: string[];
  /** Le nom de la clé d'application qui dépose (40 caractères au plus). */
  source?: string;
}

export interface DepositResult {
  /** Identifiant chez Filarr. */
  depositId: string;
  /** Numéro du dépôt dans le mois, pour cette boîte. */
  seq: number | null;
  status: 'deposited';
  depositedAt: string;
  sizeBytes: number;
  sha256: string;
}

export interface DepositStatus {
  status: 'deposited' | 'filed' | 'rejected' | 'expired';
  depositedAt: string | null;
  filedAt: string | null;
}

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

export function mimeOf(name: string): string {
  const i = name.lastIndexOf('.');
  return (i > 0 ? MIME[name.slice(i).toLowerCase()] : undefined) ?? 'application/octet-stream';
}

/** Les refus de Filarr en refus de l'API locale, codes gardés. */
export function filarrToApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof RateLimitError) return new ApiError(429, err.code, `Filarr limite les dépôts (${err.code})`, { retryAfter: Math.ceil(err.retryAfterMs / 1000) });
  if (err instanceof UnreachableError) return new ApiError(503, 'filarr_unreachable', 'Filarr est injoignable : le fichier n’est pas déposé.');
  if (err instanceof FilarrError) {
    const status = [403, 404, 409, 413].includes(err.status) ? err.status : 502;
    const extra: Record<string, unknown> = {};
    if (typeof err.body.limit === 'number') extra.limit = err.body.limit;
    return new ApiError(status, err.code, `Filarr a refusé le dépôt (${err.code})`, extra);
  }
  return new ApiError(500, 'deposit_failed', (err as Error)?.message ?? String(err));
}

/**
 * Dépose un fichier. Lève une `ApiError` (code et statut de l'API locale) sur tout
 * refus, local ou de Filarr ; rien n'est parti si le refus est local.
 */
export async function depositFile(
  replicator: Replicator,
  content: Uint8Array,
  input: DepositInput,
  filter: FileFilter
): Promise<DepositResult> {
  const client = replicator.client;
  const identity = replicator.identity;
  if (!client || !identity) throw new ApiError(503, 'no_token', 'Aucun jeton en service.');
  const files = replicator.files;
  if (!files) throw new ApiError(409, 'files_not_linked', 'Aucune boîte de dépôt n’est liée à cet accès : liez-en une dans Filarr (Réglages › Accès API).');
  if (replicator.creator.status !== 'authenticated') {
    const why =
      replicator.creator.status === 'untagged'
        ? 'cet accès n’a pas d’étiquette du créateur : remplacez le jeton depuis Filarr (bureau ou web)'
        : replicator.creator.status === 'absent'
          ? 'Filarr ne donne pas la clé du créateur (serveur trop ancien)'
          : `clé du créateur non authentifiée (${replicator.creator.reason ?? 'refus'})`;
    throw new ApiError(409, 'creator_unauthenticated', `Dépôt refusé : ${why}.`);
  }
  if (!files.signed) throw new ApiError(409, 'box_not_signed', 'Dépôt refusé : la boîte de dépôt n’est pas signée par le créateur de l’accès.');
  const name = input.name.split(/[\\/]/).pop()?.trim() ?? '';
  const refusal = checkFile(name, content.length, content.subarray(0, 8), filter, files.limits.maxFileBytes);
  if (refusal) {
    if (refusal.code === 'file_too_large') throw new ApiError(413, 'file_too_large', `Fichier trop lourd (${refusal.limit} octets au plus).`, { limit: refusal.limit });
    if (refusal.code === 'file_empty_name') throw new ApiError(400, 'name_required', 'Le nom du fichier est requis.');
    throw new ApiError(415, 'file_type_refused', `Type de fichier refusé par la boîte noire (${refusal.reason} : ${refusal.detail}).`, { reason: refusal.reason, detail: refusal.detail });
  }
  if (files.limits.pendingMax > 0 && files.pending.n >= files.limits.pendingMax) {
    throw new ApiError(409, 'box_full', `${files.pending.n} dépôts attendent d’être rangés : ouvrez Filarr pour les ranger.`);
  }
  const tags = input.tags ? normalizeTags(input.tags) : [];
  if (tags === null) throw new ApiError(400, 'bad_tags', 'Étiquettes : 10 au plus, 40 caractères chacune.');
  if (input.path !== undefined && input.path.length > 1024) throw new ApiError(400, 'bad_path', 'Chemin demandé trop long.');
  const source = input.source?.slice(0, MAX_SOURCE_LENGTH);
  const accessName = typeof replicator.access?.name === 'string' ? replicator.access.name : undefined;
  const sealed = await sealDeposit(
    storeCrypto,
    curves,
    content,
    {
      fileName: name,
      mimeType: input.mimeType && input.mimeType.trim() !== '' ? input.mimeType : mimeOf(name),
      ...(input.path ? { path: input.path } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(source ? { source } : {}),
      ...(accessName ? { accessName } : {}),
      depositedAt: new Date().toISOString(),
    },
    files.publicKey
  );
  try {
    const init = await client.json<{ depositId?: unknown; seq?: unknown }>('POST', 'api-access/self/files/init', {
      sealedFileKey: sealed.sealedFileKey,
      encryptedManifest: sealed.encryptedManifest,
      encryptedManifestIv: sealed.encryptedManifestIv,
      totalChunks: sealed.totalChunks,
      sizeBytes: sealed.sizeBytes,
    });
    if (typeof init.depositId !== 'string') throw new ApiError(502, 'bad_response', 'Filarr n’a pas rendu d’identifiant de dépôt.');
    const did = init.depositId;
    for (let i = 0; i < sealed.chunks.length; i += 1) {
      await client.putBytes(`api-access/self/files/${encodeURIComponent(did)}/chunk/${i}`, sealed.chunks[i]!);
    }
    const fin = await client.json<{ status?: unknown; depositedAt?: unknown }>('POST', `api-access/self/files/${encodeURIComponent(did)}/finalize`, {});
    // La boîte se remplit : la prochaine lecture de `self` le dira, en attendant on compte
    files.pending.n += 1;
    files.pending.bytes += sealed.sizeBytes;
    return {
      depositId: did,
      seq: typeof init.seq === 'number' ? init.seq : null,
      status: 'deposited',
      depositedAt: typeof fin.depositedAt === 'string' ? fin.depositedAt : new Date().toISOString(),
      sizeBytes: sealed.sizeBytes,
      sha256: sealed.manifest.sha256,
    };
  } catch (err) {
    throw filarrToApiError(err);
  }
}

/** Le statut d'un dépôt, relu chez Filarr. */
export async function depositStatus(replicator: Replicator, depositId: string): Promise<DepositStatus> {
  const client = replicator.client;
  if (!client) throw new ApiError(503, 'no_token', 'Aucun jeton en service.');
  try {
    const res = await client.json<{ status?: unknown; depositedAt?: unknown; filedAt?: unknown }>('GET', `api-access/self/files/${encodeURIComponent(depositId)}`);
    const status = ['deposited', 'filed', 'rejected', 'expired'].includes(String(res.status)) ? (res.status as DepositStatus['status']) : 'deposited';
    return {
      status,
      depositedAt: typeof res.depositedAt === 'string' ? res.depositedAt : null,
      filedAt: typeof res.filedAt === 'string' ? res.filedAt : null,
    };
  } catch (err) {
    throw filarrToApiError(err);
  }
}

/** Les dépôts de CET accès depuis une date, et leur statut (100 par page). */
export async function listDeposits(
  replicator: Replicator,
  since?: string
): Promise<Array<{ depositId: string } & DepositStatus>> {
  const client = replicator.client;
  if (!client) throw new ApiError(503, 'no_token', 'Aucun jeton en service.');
  const out: Array<{ depositId: string } & DepositStatus> = [];
  let next: string | null = since ?? null;
  for (let page = 0; page < 50; page += 1) {
    const q: string = next ? `?since=${encodeURIComponent(next)}` : '';
    let res: { deposits?: unknown; next?: unknown };
    try {
      res = await client.json<{ deposits?: unknown; next?: unknown }>('GET', `api-access/self/files${q}`);
    } catch (err) {
      throw filarrToApiError(err);
    }
    for (const d of Array.isArray(res.deposits) ? res.deposits : []) {
      const o = d as Record<string, unknown>;
      if (typeof o.depositId !== 'string') continue;
      out.push({
        depositId: o.depositId,
        status: ['deposited', 'filed', 'rejected', 'expired'].includes(String(o.status)) ? (o.status as DepositStatus['status']) : 'deposited',
        depositedAt: typeof o.depositedAt === 'string' ? o.depositedAt : null,
        filedAt: typeof o.filedAt === 'string' ? o.filedAt : null,
      });
    }
    if (typeof res.next !== 'string' || res.next === '' || res.next === next) break;
    next = res.next;
  }
  return out;
}
