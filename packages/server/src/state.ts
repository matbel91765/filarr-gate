/**
 * L'état de la boîte noire sur le disque, dans son répertoire (`FILARR_GATE_STATE_DIR`).
 *
 * - `token` : le jeton Filarr, droits 0600, jamais journalisé (absent s'il vient
 *   de l'environnement) ;
 * - `state.json` (0600) : l'identifiant d'installation (`siteId`), l'empreinte du
 *   mot de passe d'administration (scrypt), les clés des applications (EMPREINTES
 *   seulement), les webhooks et leurs secrets de signature, les requêtes
 *   enregistrées, les noms des champs JSON, les réglages faits dans l'interface ;
 * - `blocks/` : le cache des blocs CHIFFRÉS ; `journal/` : le journal local.
 *
 * Aucune ligne déchiffrée n'est jamais écrite ici.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../../cli/src/config';

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

export type KeyScope =
  | { target: 'all'; read: true }
  | { target: 'base'; storeId: string; read: boolean; create: boolean; update: boolean; delete: boolean }
  | { target: 'view'; storeId: string; viewId: string; read: true }
  | { target: 'query'; queryId: string; read: true };

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

export type WebhookEvent = 'row.created' | 'row.updated' | 'row.deleted' | 'gate.quota';

export interface WebhookRecord {
  id: string;
  name: string;
  url: string;
  secret: string;
  /** La base (et la vue) suivie ; `null` pour un webhook des seuls avis de quota. */
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
}

function freshState(): PersistedState {
  return {
    version: 1,
    siteId: randomBytes(4).toString('hex'),
    admin: { passwordHash: null },
    settings: {},
    keys: [],
    webhooks: [],
    queries: [],
    fieldNames: {},
  };
}

/** Écriture atomique, droits 0600. */
function writeSecret(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows : les droits POSIX n'existent pas */
  }
  renameSync(tmp, path);
}

export class StateStore {
  data: PersistedState;
  private saving: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'state.json');
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistedState>;
      this.data = { ...freshState(), ...parsed, admin: { ...freshState().admin, ...parsed.admin } } as PersistedState;
    } else {
      this.data = freshState();
      this.saveNow();
    }
  }

  get blocksDir(): string {
    return join(this.dir, 'blocks');
  }

  get journalDir(): string {
    return join(this.dir, 'journal');
  }

  /** Enregistre tout de suite. */
  saveNow(): void {
    if (this.saving) clearTimeout(this.saving);
    this.saving = null;
    writeSecret(join(this.dir, 'state.json'), `${JSON.stringify(this.data, null, 2)}\n`);
  }

  /** Enregistre bientôt (plusieurs changements groupés ; `delayMs` long pour les simples traces d'usage). */
  save(delayMs = 200): void {
    if (this.saving) return;
    this.saving = setTimeout(() => this.saveNow(), delayMs);
    this.saving.unref?.();
  }

  // ---------- Le jeton ----------

  readToken(): string | null {
    const file = join(this.dir, 'token');
    return existsSync(file) ? readFileSync(file, 'utf8').trim() || null : null;
  }

  writeToken(token: string): void {
    writeSecret(join(this.dir, 'token'), `${token.trim()}\n`);
  }

  deleteToken(): void {
    rmSync(join(this.dir, 'token'), { force: true });
  }

  // ---------- Le mot de passe d'administration ----------

  static async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 });
    return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
  }

  static async verifyPassword(password: string, stored: string | null): Promise<boolean> {
    if (!stored) return false;
    const [kind, n, r, p, salt, hash] = stored.split('$');
    if (kind !== 'scrypt' || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64');
    const got = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  /** Oublie cette machine : état, jeton, cache, journal. */
  wipe(): void {
    rmSync(join(this.dir, 'token'), { force: true });
    rmSync(join(this.dir, 'state.json'), { force: true });
    rmSync(this.blocksDir, { recursive: true, force: true });
    rmSync(this.journalDir, { recursive: true, force: true });
    this.data = freshState();
    this.saveNow();
  }
}
