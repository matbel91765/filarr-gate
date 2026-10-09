/**
 * L'état de la boîte noire : ce qu'elle garde d'une exécution à l'autre.
 *
 * - l'identifiant d'installation (`siteId`), l'empreinte du mot de passe
 *   d'administration (scrypt), les clés des applications (EMPREINTES
 *   seulement), les webhooks et leurs secrets de signature, les requêtes
 *   enregistrées, les noms des champs JSON, les réglages faits dans l'interface ;
 * - révision 3 : le suivi des dépôts de fichiers (identifiant, statut, taille,
 *   heures — jamais un nom ni un contenu), l'état des synchros externes, et les
 *   clés des bases externes, CHIFFRÉES sous une clé tirée du jeton (`A_local`).
 *
 * Indépendant du moteur : l'hôte fournit où l'écrire (`StateBackend` : un
 * fichier 0600 sous Node, le stockage de l'objet durable sous Workers). Aucune
 * ligne déchiffrée n'est jamais écrite ici.
 */

import { scryptAsync } from '@noble/hashes/scrypt.js';
import { fromBase64Url, toBase64Url, utf8Encode } from '../../core/src/engine/store/crypto';
import { randomBytes, timingSafeEqualBytes } from '../../gate/src/util/bytes';
import type { FieldNameStore } from '../../gate/src/data/fields';
import type { Settings } from './settings';

export type KeyScope =
  | { target: 'all'; read: true }
  | { target: 'base'; storeId: string; read: boolean; create: boolean; update: boolean; delete: boolean }
  | { target: 'view'; storeId: string; viewId: string; read: true }
  | { target: 'query'; queryId: string; read: true }
  /** Révision 3 : déposer des fichiers par `POST /v1/files` (`gate-fichiers-1` § 12). */
  | { target: 'files'; deposit: true };

export interface AppKeyRecord {
  id: string;
  name: string;
  /** Le début de la clé, pour la reconnaître (`gk_erp_3k…`). */
  prefix: string;
  /** SHA-256 de la clé, en hexadécimal : la clé elle-même n'est jamais gardée. */
  hash: string;
  scopes: KeyScope[];
  /** `POST /v1/sql` sur les bases que la clé peut lire. */
  sql: boolean;
  /** Le serveur MCP (lecture seule, selon les mêmes droits). */
  mcp: boolean;
  /** Requêtes par minute. */
  rateLimit: number;
  /** Adresses ou plages CIDR autorisées ; vide = toutes. */
  ipAllow: string[];
  expiresAt: string | null;
  paused: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  lastIp: string | null;
}

export type WebhookEvent = 'row.created' | 'row.updated' | 'row.deleted' | 'gate.quota' | 'file.filed' | 'sync.done' | 'sync.failed';

export interface WebhookRecord {
  id: string;
  name: string;
  url: string;
  secret: string;
  /** La base (et la vue) suivie ; `null` pour un webhook des seuls avis (quota, fichiers, synchros). */
  target: { storeId: string; viewId?: string } | null;
  events: WebhookEvent[];
  /** Condition SQL sur la ligne (`montant > 0`), évaluée par le moteur SQL de Filarr. */
  filter: string | null;
  /** Ne livrer que quand la condition DEVIENT vraie (« statut devient 'Perdu' »). */
  transition: boolean;
  /** Champs envoyés ; `null` = toute la ligne. */
  fields: string[] | null;
  /** Relations résolues (la ligne visée, si sa base est ouverte). */
  expand: string[];
  paused: boolean;
  createdAt: string;
}

export interface SavedQuery {
  id: string;
  name: string;
  slug: string;
  sql: string;
  createdAt: string;
  updatedAt: string;
}

/** Un dépôt fait par cette boîte noire (aucun nom, aucun contenu : `gate-fichiers-1` § 0). */
export interface DepositRecord {
  /** Identifiant local rendu à l'appelant (`dp_…`). */
  id: string;
  /** Identifiant chez Filarr (`depositId`), une fois `init` accepté. */
  depositId: string | null;
  seq: number | null;
  status: 'sending' | 'deposited' | 'filed' | 'rejected' | 'expired' | 'failed';
  sizeBytes: number;
  /** La clé d'application qui a déposé (son nom). */
  source: string | null;
  createdAt: string;
  depositedAt: string | null;
  filedAt: string | null;
  error: string | null;
}

/** L'état local d'une synchro externe (définitions lues dans les magasins, `source-externe-1`). */
export interface SyncRecord {
  defId: string;
  storeId: string;
  /** Mise en pause par l'administrateur de la boîte. */
  paused: boolean;
  lastRunAt: string | null;
  lastOkAt: string | null;
  nextRunAt: string | null;
  failures: number;
  /** Révision de l'état publié (`ext-status`). */
  statusRev: number;
  /** Révision de la file publiée (`ext-queue`). */
  queueRev: number;
  /** Dernière décision acquittée (`ext-resolve`). */
  resolvedUpTo: number;
}

export interface PersistedState {
  version: 1;
  siteId: string;
  admin: { passwordHash: string | null };
  settings: Partial<Settings>;
  keys: AppKeyRecord[];
  webhooks: WebhookRecord[];
  queries: SavedQuery[];
  /** `storeId → propertyId → nom du champ JSON`, posé une fois et gardé (un renommage ne casse rien). */
  fieldNames: Record<string, Record<string, string>>;
  /** Révision 3 : les dépôts récents de cette boîte (500 au plus). */
  deposits: DepositRecord[];
  /** Révision 3 : l'état local des synchros externes, par définition. */
  sync: Record<string, SyncRecord>;
  /** Révision 3 : clés des bases externes, CHIFFRÉES sous `A_local` (`defId → scellé`). */
  extdbKeys: Record<string, string>;
  /** Révision 3 : champs d'un paquet de réglages importé que cette version ne connaît pas (gardés). */
  importedExtra?: Record<string, unknown>;
}

/** Où l'état s'écrit : un fichier 0600 (Node), le stockage d'un objet durable (Workers), rien (essais). */
export interface StateBackend {
  /** Écrit le JSON entier (atomiquement si possible). */
  save(json: string): void | Promise<void>;
  /** Efface l'état (oubli de la machine). */
  wipe?(): void | Promise<void>;
  /** Où c'est rangé, pour l'affichage (`null` : nulle part, ou ailleurs que sur un disque). */
  readonly location: string | null;
}

export function freshState(): PersistedState {
  return {
    version: 1,
    siteId: Array.from(randomBytes(4), (b) => b.toString(16).padStart(2, '0')).join(''),
    admin: { passwordHash: null },
    settings: {},
    keys: [],
    webhooks: [],
    queries: [],
    fieldNames: {},
    deposits: [],
    sync: {},
    extdbKeys: {},
  };
}

/** Un état relu, complété des champs qu'une version plus ancienne n'écrivait pas. */
export function parseState(json: string | null): PersistedState {
  if (!json) return freshState();
  const parsed = JSON.parse(json) as Partial<PersistedState>;
  const fresh = freshState();
  return { ...fresh, ...parsed, admin: { ...fresh.admin, ...parsed.admin } } as PersistedState;
}

export const memoryBackend = (): StateBackend => ({ save: () => undefined, location: null });

export class StateStore implements FieldNameStore {
  data: PersistedState;
  private saving: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly backend: StateBackend,
    initial: string | null = null
  ) {
    this.data = parseState(initial);
    if (initial === null) this.saveNow();
  }

  /** Où l'état est rangé (un répertoire sous Node). */
  get dir(): string | null {
    return this.backend.location;
  }

  /** Enregistre tout de suite (une écriture asynchrone de l'hôte est suivie : `flushed()`). */
  saveNow(): void {
    if (this.saving) clearTimeout(this.saving);
    this.saving = null;
    const json = `${JSON.stringify(this.data, null, 2)}\n`;
    const out = this.backend.save(json);
    if (out && typeof (out as Promise<void>).then === 'function') {
      this.writes = this.writes.then(() => out).catch(() => undefined);
    }
  }

  /** Enregistre bientôt (plusieurs changements groupés ; `delayMs` long pour les simples traces d'usage). */
  save(delayMs = 200): void {
    if (this.saving) return;
    this.saving = setTimeout(() => this.saveNow(), delayMs);
    (this.saving as { unref?: () => void }).unref?.();
  }

  /** Les écritures en cours sont faites. */
  async flushed(): Promise<void> {
    if (this.saving) this.saveNow();
    await this.writes;
  }

  // ---------- FieldNameStore (bibliothèque) ----------

  names(storeId: string): Record<string, string> {
    return (this.data.fieldNames[storeId] ??= {});
  }

  changed(): void {
    this.save();
  }

  // ---------- Le mot de passe d'administration ----------

  static async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await scryptAsync(utf8Encode(password), salt, { N: 16384, r: 8, p: 1, dkLen: 32 });
    return `scrypt$16384$8$1$${b64(salt)}$${b64(key)}`;
  }

  static async verifyPassword(password: string, stored: string | null): Promise<boolean> {
    if (!stored) return false;
    const [kind, n, r, p, salt, hash] = stored.split('$');
    if (kind !== 'scrypt' || !salt || !hash) return false;
    const expected = unb64(hash);
    const got = await scryptAsync(utf8Encode(password), unb64(salt), { N: Number(n), r: Number(r), p: Number(p), dkLen: expected.length });
    return timingSafeEqualBytes(got, expected);
  }

  /** Oublie cette machine : un état neuf (l'hôte efface le reste : jeton, cache, journal). */
  async wipe(): Promise<void> {
    await this.backend.wipe?.();
    this.data = freshState();
    this.saveNow();
  }
}

/** base64 standard (le format des empreintes scrypt écrites par la version 0.1). */
function b64(bytes: Uint8Array): string {
  const url = toBase64Url(bytes).replace(/-/g, '+').replace(/_/g, '/');
  return url + '='.repeat((4 - (url.length % 4)) % 4);
}

function unb64(text: string): Uint8Array {
  return fromBase64Url(text.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'));
}
