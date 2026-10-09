// Écrit dans filarr-gate (origine) — cœur pur, à recopier tel quel par filarg (lot B2).
/**
 * La fente à fichiers — contrat `gate-fichiers-1`.
 *
 * La boîte noire DÉPOSE un fichier dans la boîte de dépôt du créateur, au format
 * EXACT d'un dépôt fait par la page (`requestSeal.ts` du worker) : le site, le
 * mobile et l'appli l'ouvrent sans rien savoir de son origine.
 *
 *  - `K_file` aléatoire (32 o) ;
 *  - manifeste JSON chiffré AES-256-GCM sous `K_file`, IV de 12 o, SANS AAD ;
 *  - morceaux de 16 Mio en clair : `IV(12) ‖ chiffré ‖ étiquette(16)`, sans AAD ;
 *  - `K_file` scellé à la clé publique X25519 de la boîte :
 *    `éphémère(32) ‖ IV(12) ‖ AES-256-GCM(KEK, K_file)`, KEK = HKDF-SHA256(secret
 *    partagé, sel = éphémère ‖ clé de la boîte, info `filarr.filerequest.seal.v1`),
 *    en base64 STANDARD.
 *
 * La boîte ne scelle que vers une clé de boîte SIGNÉE par le créateur (`boxSig`,
 * § 1), dont la clé de signature est authentifiée par `creatorTag` : un serveur
 * qui servirait sa propre clé de boîte lirait sinon chaque fichier.
 *
 * Le filtre (§ 3) tourne AVANT que rien ne parte : exécutables et scripts, par
 * extension et par signature, et taille.
 *
 * Cœur portable (StoreCrypto et AccessCurves injectés), `strict` et
 * `noUncheckedIndexedAccess`.
 */

import { fromBase64Std, toBase64Std, type AccessCurves } from '../store/apiAccess';
import {
  concatBytes,
  fromBase64Url,
  utf8Decode,
  utf8Encode,
  type StoreCrypto,
} from '../store/crypto';

export const FILE_REQUEST_SEAL_INFO = 'filarr.filerequest.seal.v1';
export const GATE_OUTCOME_INFO = 'filarr.gate.outcome.v1';
/** Taille d'un morceau EN CLAIR (celle de la page de dépôt). */
export const DEPOSIT_CHUNK_SIZE = 16 * 1024 * 1024;
/** Plafond du contrat : 100 Mio par fichier (réglable plus bas, jamais plus haut). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Étiquettes : 10 au plus, 40 caractères chacune ; source : 40 caractères. */
export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 40;
export const MAX_SOURCE_LENGTH = 40;
/** L'issue scellée : 4 Kio de clair au plus (§ 7.2). */
export const MAX_OUTCOME_BYTES = 4096;

const KEY_BYTES = 32;
const IV_BYTES = 12;

// ==================== Le scellé X25519 (même construction, info au choix) ====================

/**
 * `éphémère ‖ IV ‖ AES-256-GCM(KEK, clair)`, KEK = HKDF(secret partagé, éphémère ‖
 * destinataire, `info`). C'est celle de `userKeypair` (info `filarr.userkey.seal.v1`),
 * de la page de dépôt (`filarr.filerequest.seal.v1`) et de l'issue
 * (`filarr.gate.outcome.v1`). L'éphémère et l'IV sont imposables pour les vecteurs.
 */
export async function sealX25519(
  c: StoreCrypto,
  curves: AccessCurves,
  recipientPub: Uint8Array,
  plaintext: Uint8Array,
  info: string,
  fixed?: { ephemeralPriv: Uint8Array; iv: Uint8Array }
): Promise<Uint8Array> {
  if (recipientPub.length !== KEY_BYTES) throw new Error('clé publique de 32 octets attendue');
  const ephPriv = fixed ? fixed.ephemeralPriv : c.randomBytes(KEY_BYTES);
  const ephPub = curves.x25519PublicKey(ephPriv);
  const shared = curves.x25519Shared(ephPriv, recipientPub);
  const kek = await c.hkdf(shared, concatBytes(ephPub, recipientPub), info, KEY_BYTES);
  const iv = fixed ? fixed.iv : c.randomBytes(IV_BYTES);
  const ct = await c.aesGcmEncrypt(kek, iv, plaintext, new Uint8Array(0));
  if (!fixed) ephPriv.fill(0);
  shared.fill(0);
  return concatBytes(ephPub, iv, ct);
}

/** Ouvre un scellé X25519 ; lève s'il n'est pas pour cette clé ou s'il a été altéré. */
export async function openX25519(
  c: StoreCrypto,
  curves: AccessCurves,
  recipientPriv: Uint8Array,
  blob: Uint8Array,
  info: string
): Promise<Uint8Array> {
  if (blob.length < KEY_BYTES + IV_BYTES + 16) throw new Error('scellé trop court');
  const ephPub = blob.slice(0, KEY_BYTES);
  const iv = blob.slice(KEY_BYTES, KEY_BYTES + IV_BYTES);
  const shared = curves.x25519Shared(recipientPriv, ephPub);
  const recipient = curves.x25519PublicKey(recipientPriv);
  const kek = await c.hkdf(shared, concatBytes(ephPub, recipient), info, KEY_BYTES);
  return c.aesGcmDecrypt(kek, iv, blob.slice(KEY_BYTES + IV_BYTES), new Uint8Array(0));
}

// ==================== La signature de la boîte (§ 1) ====================

/** `filarr/gate/v1|box|<accessId>|<requestId>|<clé publique de la boîte, base64url>` */
export function boxSigMessage(accessId: string, requestId: string, boxPublicKey: string): Uint8Array {
  return utf8Encode(`filarr/gate/v1|box|${accessId}|${requestId}|${boxPublicKey}`);
}

/**
 * Vrai si `boxSig` (base64url) est la signature Ed25519, par la clé de signature
 * du créateur (base64 standard), de la clé publique de la boîte liée à l'accès.
 */
export function verifyBoxSig(
  curves: AccessCurves,
  creatorSigningPublicKey: string,
  accessId: string,
  requestId: string,
  boxPublicKey: string,
  boxSig: string
): boolean {
  try {
    const pub = fromBase64Std(creatorSigningPublicKey);
    const sig = fromBase64Url(boxSig);
    if (pub.length !== 32 || sig.length !== 64) return false;
    if (fromBase64Url(boxPublicKey).length !== KEY_BYTES) return false;
    return curves.ed25519Verify(sig, boxSigMessage(accessId, requestId, boxPublicKey), pub);
  } catch {
    return false;
  }
}

// ==================== Le filtre (§ 3) ====================

/** Extensions refusées par défaut (§ 3), en minuscules, avec leur point. */
export const DEFAULT_DENIED_EXTENSIONS: readonly string[] = [
  '.exe', '.msi', '.bat', '.cmd', '.ps1', '.sh', '.js', '.app', '.com', '.scr', '.vbs',
  '.jar', '.dll', '.apk', '.dmg', '.pkg', '.deb', '.rpm', '.lnk', '.reg', '.hta',
];

/** L'extension d'un nom (minuscules, avec le point), ou `''`. */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 && i < base.length - 1 ? base.slice(i).toLowerCase() : '';
}

/** La signature d'un exécutable en tête du fichier, ou `null` (`MZ`, ELF, Mach-O, `#!`). */
export function executableSignature(head: Uint8Array): string | null {
  const b = (i: number): number => head[i] ?? -1;
  if (b(0) === 0x4d && b(1) === 0x5a) return 'MZ';
  if (b(0) === 0x7f && b(1) === 0x45 && b(2) === 0x4c && b(3) === 0x46) return 'ELF';
  const word = ((b(0) << 24) | (b(1) << 16) | (b(2) << 8) | b(3)) >>> 0;
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(word)) return 'Mach-O';
  if (b(0) === 0x23 && b(1) === 0x21) return '#!';
  return null;
}

export interface FileFilter {
  /** Extensions refusées (d'office : la liste du contrat). */
  deny: readonly string[];
  /** Si non vide : SEULES ces extensions passent (la signature d'exécutable reste refusée). */
  allow?: readonly string[];
  /** Taille maximale, plafonnée à 100 Mio. */
  maxBytes: number;
}

export const DEFAULT_FILE_FILTER: FileFilter = { deny: DEFAULT_DENIED_EXTENSIONS, maxBytes: MAX_FILE_BYTES };

export type FilterRefusal =
  | { code: 'file_type_refused'; reason: 'extension' | 'signature' | 'not_allowed'; detail: string }
  | { code: 'file_too_large'; limit: number }
  | { code: 'file_empty_name' };

/**
 * Le filtre de la boîte, AVANT tout envoi. `null` : le fichier passe. La taille
 * se compare au plus petit de : réglage de la boîte, 100 Mio, limite de Filarr.
 */
export function checkFile(
  name: string,
  size: number,
  head: Uint8Array,
  filter: FileFilter,
  serverMaxBytes?: number
): FilterRefusal | null {
  if (name.trim() === '') return { code: 'file_empty_name' };
  const limit = Math.min(
    Math.max(0, Math.floor(filter.maxBytes)),
    MAX_FILE_BYTES,
    serverMaxBytes !== undefined && serverMaxBytes > 0 ? serverMaxBytes : MAX_FILE_BYTES
  );
  if (size > limit) return { code: 'file_too_large', limit };
  const ext = extensionOf(name);
  const allow = (filter.allow ?? []).map((e) => e.toLowerCase());
  if (allow.length > 0 && !allow.includes(ext)) {
    return { code: 'file_type_refused', reason: 'not_allowed', detail: ext || '(sans extension)' };
  }
  if (filter.deny.map((e) => e.toLowerCase()).includes(ext)) {
    return { code: 'file_type_refused', reason: 'extension', detail: ext };
  }
  const sig = executableSignature(head);
  if (sig) return { code: 'file_type_refused', reason: 'signature', detail: sig };
  return null;
}

/** Les étiquettes reçues : 10 au plus, 40 caractères chacune, sans vide ni doublon ; `null` si refusées. */
export function normalizeTags(raw: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const t of raw) {
    const tag = t.trim();
    if (tag === '') continue;
    if (tag.length > MAX_TAG_LENGTH || /[\u0000-\u001f\u007f]/.test(tag)) return null;
    if (!out.includes(tag)) out.push(tag);
  }
  return out.length > MAX_TAGS ? null : out;
}

// ==================== Le dépôt (§ 2) ====================

/** Le manifeste en clair d'un dépôt de la boîte noire, dans l'ordre du contrat. */
export interface GateManifest {
  fileName: string;
  mimeType: string;
  size: number;
  totalChunks: number;
  channel: 'gate';
  sha256: string;
  path?: string;
  tags?: string[];
  source?: string;
  accessName?: string;
  depositedAt: string;
}

export interface SealedDeposit {
  /** `K_file` scellé à la clé de la boîte (base64 standard). */
  sealedFileKey: string;
  encryptedManifest: string;
  encryptedManifestIv: string;
  totalChunks: number;
  sizeBytes: number;
  /** Morceaux chiffrés, dans l'ordre. */
  chunks: Uint8Array[];
  manifest: GateManifest;
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export interface DepositMeta {
  fileName: string;
  mimeType: string;
  path?: string;
  tags?: string[];
  source?: string;
  accessName?: string;
  depositedAt: string;
}

/** Le manifeste en JSON, clés dans l'ordre du contrat, champs facultatifs omis quand vides. */
export function manifestJson(m: GateManifest): string {
  const o: Record<string, unknown> = {
    fileName: m.fileName,
    mimeType: m.mimeType,
    size: m.size,
    totalChunks: m.totalChunks,
    channel: m.channel,
    sha256: m.sha256,
  };
  if (m.path !== undefined && m.path !== '') o.path = m.path;
  if (m.tags !== undefined && m.tags.length > 0) o.tags = m.tags;
  if (m.source !== undefined && m.source !== '') o.source = m.source;
  if (m.accessName !== undefined && m.accessName !== '') o.accessName = m.accessName;
  o.depositedAt = m.depositedAt;
  return JSON.stringify(o);
}

/**
 * Un fichier → un dépôt scellé pour la boîte (`boxPublicKey` en base64url).
 * `fixed` impose `K_file`, les IV et l'éphémère : vecteurs seulement.
 */
export async function sealDeposit(
  c: StoreCrypto,
  curves: AccessCurves,
  content: Uint8Array,
  meta: DepositMeta,
  boxPublicKey: string,
  fixed?: { fileKey: Uint8Array; manifestIv: Uint8Array; chunkIvs: Uint8Array[]; ephemeralPriv: Uint8Array; sealIv: Uint8Array }
): Promise<SealedDeposit> {
  const fileKey = fixed ? fixed.fileKey : c.randomBytes(KEY_BYTES);
  try {
    const totalChunks = Math.max(1, Math.ceil(content.length / DEPOSIT_CHUNK_SIZE));
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < totalChunks; i += 1) {
      const plain = content.subarray(i * DEPOSIT_CHUNK_SIZE, (i + 1) * DEPOSIT_CHUNK_SIZE);
      const iv = fixed ? (fixed.chunkIvs[i] ?? c.randomBytes(IV_BYTES)) : c.randomBytes(IV_BYTES);
      chunks.push(concatBytes(iv, await c.aesGcmEncrypt(fileKey, iv, plain, new Uint8Array(0))));
    }
    const manifest: GateManifest = {
      fileName: meta.fileName,
      mimeType: meta.mimeType,
      size: content.length,
      totalChunks,
      channel: 'gate',
      sha256: toHex(await c.sha256(content)),
      ...(meta.path !== undefined ? { path: meta.path } : {}),
      ...(meta.tags !== undefined ? { tags: meta.tags } : {}),
      ...(meta.source !== undefined ? { source: meta.source } : {}),
      ...(meta.accessName !== undefined ? { accessName: meta.accessName } : {}),
      depositedAt: meta.depositedAt,
    };
    const manifestIv = fixed ? fixed.manifestIv : c.randomBytes(IV_BYTES);
    const encrypted = await c.aesGcmEncrypt(fileKey, manifestIv, utf8Encode(manifestJson(manifest)), new Uint8Array(0));
    const sealed = await sealX25519(
      c,
      curves,
      fromBase64Url(boxPublicKey),
      fileKey,
      FILE_REQUEST_SEAL_INFO,
      fixed ? { ephemeralPriv: fixed.ephemeralPriv, iv: fixed.sealIv } : undefined
    );
    return {
      sealedFileKey: toBase64Std(sealed),
      encryptedManifest: toBase64Std(encrypted),
      encryptedManifestIv: toBase64Std(manifestIv),
      totalChunks,
      sizeBytes: content.length,
      chunks,
      manifest,
    };
  } finally {
    if (!fixed) fileKey.fill(0);
  }
}

/**
 * Ouvre un dépôt avec la clé privée de la boîte (ce que fait l'appli, et ce que
 * vérifient les essais) : le manifeste et le contenu, morceaux concaténés.
 */
export async function openDeposit(
  c: StoreCrypto,
  curves: AccessCurves,
  boxPrivateKey: Uint8Array,
  deposit: { sealedFileKey: string; encryptedManifest: string; encryptedManifestIv: string },
  chunks: readonly Uint8Array[]
): Promise<{ manifest: Record<string, unknown>; bytes: Uint8Array }> {
  const fileKey = await openX25519(c, curves, boxPrivateKey, fromBase64Std(deposit.sealedFileKey), FILE_REQUEST_SEAL_INFO);
  const manifest = JSON.parse(
    utf8Decode(await c.aesGcmDecrypt(fileKey, fromBase64Std(deposit.encryptedManifestIv), fromBase64Std(deposit.encryptedManifest), new Uint8Array(0)))
  ) as Record<string, unknown>;
  const parts: Uint8Array[] = [];
  for (const chunk of chunks) {
    parts.push(await c.aesGcmDecrypt(fileKey, chunk.slice(0, IV_BYTES), chunk.slice(IV_BYTES), new Uint8Array(0)));
  }
  fileKey.fill(0);
  return { manifest, bytes: concatBytes(...parts) };
}

// ==================== L'issue scellée (§ 7.2, écrite par l'appli) ====================

export interface GateOutcome {
  v: 1;
  result: 'filed' | 'duplicate' | 'path_refused' | 'rejected';
  folder?: string;
  name?: string;
  rule?: string;
  by?: string;
  filedAt?: string;
  sha256Verified?: boolean;
}

/** `outcome = sealToBox(JSON, clé de la boîte, info filarr.gate.outcome.v1)`, base64 standard. */
export async function sealOutcome(
  c: StoreCrypto,
  curves: AccessCurves,
  boxPublicKey: string,
  outcome: GateOutcome,
  fixed?: { ephemeralPriv: Uint8Array; iv: Uint8Array }
): Promise<string> {
  const plain = utf8Encode(JSON.stringify(outcome));
  if (plain.length > MAX_OUTCOME_BYTES) throw new Error('issue trop longue (4 Kio au plus)');
  return toBase64Std(await sealX25519(c, curves, fromBase64Url(boxPublicKey), plain, GATE_OUTCOME_INFO, fixed));
}

export async function openOutcome(
  c: StoreCrypto,
  curves: AccessCurves,
  boxPrivateKey: Uint8Array,
  sealed: string
): Promise<GateOutcome> {
  return JSON.parse(utf8Decode(await openX25519(c, curves, boxPrivateKey, fromBase64Std(sealed), GATE_OUTCOME_INFO))) as GateOutcome;
}
