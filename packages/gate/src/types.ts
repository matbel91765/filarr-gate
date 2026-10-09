/**
 * Les types publics de `@filarr/gate`. Ils ne dépendent d'aucun type interne :
 * un programme qui importe la bibliothèque ne voit que ceux-ci.
 */

/** Une ligne, en objet JSON : `id`, un champ par colonne (nom tiré de la colonne), `created_at`, `updated_at`. */
export type Row = { id: string; created_at: string | null; updated_at: string | null } & Record<string, unknown>;

/** Une ligne à écrire : les champs par leur nom JSON (`null` vide une cellule). */
export type RowInput = Record<string, unknown>;

/** Une page de lignes : un tableau, plus de quoi continuer. */
export type RowList = Row[] & {
  /** Le curseur de la page suivante (`cursor`), ou `null`. */
  next: string | null;
  /** Le nombre de lignes qui répondent, toutes pages confondues. */
  total: number;
  /** La version (`seq`) du magasin servie. */
  version: number;
  /** Les champs dont la base visée n'est pas ouverte à cet accès (relations, agrégats). */
  unresolved?: string[];
};

export type Primitive = string | number | boolean;

/** Une condition sur un champ : une valeur (égalité), ou des opérateurs. */
export type FieldCondition =
  | Primitive
  | {
      eq?: Primitive;
      ne?: Primitive;
      lt?: Primitive;
      lte?: Primitive;
      gt?: Primitive;
      gte?: Primitive;
      /** Contient (texte), ou compte parmi (liste). */
      contains?: Primitive;
      /** Une valeur parmi celles-ci. */
      in?: Primitive[];
      /** Vide (`true`) ou rempli (`false`). */
      empty?: boolean;
    };

export interface RowsOptions {
  /** Conditions par champ, toutes vraies (ET). */
  where?: Record<string, FieldCondition>;
  /** Tri : `"montant"`, `"-montant"` (décroissant), ou une liste. */
  sort?: string | string[];
  /** 100 d'office, 1 000 au plus. */
  limit?: number;
  /** Le curseur rendu par la page précédente (`next`). */
  cursor?: string;
  /** Les champs à rendre (`id` toujours). */
  fields?: string[];
  /** Recherche rapide dans le texte. */
  q?: string;
  /** Seulement les lignes changées depuis cette version. */
  since?: number;
}

export interface ViewRowsOptions {
  limit?: number;
  cursor?: string;
}

export interface FieldInfo {
  /** Nom JSON du champ. */
  name: string;
  /** Nom de la colonne dans Filarr. */
  column: string;
  /** Type de la colonne dans Filarr (`text`, `number`, `select`, `relation`…). */
  type: string;
  /** Type de la valeur JSON. */
  json: 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'string[]' | 'object';
  /** Écrit par l'API (les colonnes calculées ne le sont pas). */
  writable: boolean;
  /** Valeurs permises (libellés des options). */
  options?: string[];
}

export interface ViewSummary {
  slug: string;
  name: string;
  type: string;
}

export type BaseStatus = 'loading' | 'ready' | 'missing_key' | 'unverified' | 'waiting' | 'refused' | 'offline';

export interface BaseSummary {
  slug: string;
  title: string;
  /** `r` : lecture ; `rw` : écriture possible (si l'écriture est ouverte). */
  rights: 'r' | 'rw';
  status: BaseStatus;
  version: number;
  rows: number;
  fields: FieldInfo[];
  views: ViewSummary[];
}

export interface ChangeEvent {
  /** Le slug de la base. */
  base: string;
  version: number;
  /** `filarr` : écrit dans Filarr ; `gate` : écrit par cette bibliothèque. */
  origin: 'filarr' | 'gate';
  added: Row[];
  changed: Array<{ before: Row; after: Row }>;
  removed: Row[];
}

export type LinkState =
  | 'no_token'
  | 'connecting'
  | 'live'
  | 'polling'
  | 'offline'
  | 'limited'
  | 'paused'
  | 'not_switched'
  | 'ip_forbidden'
  | 'revoked'
  | 'expired'
  | 'unknown_access'
  | 'upgrade_required'
  | 'pending'
  | 'asleep'
  | 'error';

export interface GateStatus {
  link: LinkState;
  detail: string | null;
  accessId: string | null;
  accessName: string | null;
  tier: string | null;
  /** L'écriture est-elle ouverte par Filarr à cet accès ? */
  filarrWrite: boolean;
  /** La clé de signature du créateur (`authenticated` : fichiers et objets signés acceptés). */
  creator: 'absent' | 'untagged' | 'authenticated' | 'refused';
  /** Une boîte de dépôt est-elle liée (et signée) ? */
  files: { linked: boolean; signed: boolean; pending: number };
  bases: Array<{ slug: string | null; status: BaseStatus; version: number; problem: string | null }>;
  lastChangeAt: string | null;
  quota: { sync?: { used: number; max: number }; bytes?: { used: number; max: number }; writes?: { used: number; max: number } } | null;
}

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
  ms: number;
  scanned: number;
  truncated: boolean;
}

export interface DepositOptions {
  /** Nom d'origine du fichier, avec son extension. */
  name: string;
  mimeType?: string;
  /** Chemin demandé, relatif au dossier cible (appliqué par l'appli si la boîte l'accepte). */
  path?: string;
  /** Étiquettes : 10 au plus, 40 caractères chacune. */
  tags?: string[];
  /** Qui dépose (40 caractères au plus) : apparaît dans le modèle de nom `{source}`. */
  source?: string;
}

export interface FileDeposit {
  depositId: string;
  seq: number | null;
  status: 'deposited';
  depositedAt: string;
  sizeBytes: number;
  /** SHA-256 du clair (il voyage dans le manifeste chiffré, jamais en clair). */
  sha256: string;
}

export interface FileStatus {
  status: 'deposited' | 'filed' | 'rejected' | 'expired';
  depositedAt: string | null;
  filedAt: string | null;
}

/** Une erreur de la bibliothèque : `code` stable (le même que l'API de Filarr Gate), `status` HTTP équivalent. */
export interface GateErrorShape extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
}
