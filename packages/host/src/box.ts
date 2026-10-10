/**
 * UNE BOÎTE HÉBERGÉE — l'objet durable `GateBox` d'un accès, créé en juridiction UE — contrat
 * `gate-heberge-1` § 7, § 8, § 9.3.
 *
 * Le cœur est celui de `filarr-gate` sur Cloudflare (`CloudflareGate` : réplique, API, webhooks,
 * SQL, MCP, synchros externes https, fente à fichiers), avec ce que le service ajoute :
 *
 *  - LE JETON vient de l'API, SCELLÉ vers `HOST_ENC` (`GET /api-access/hosted/:id/token`, requête
 *    signée) ; il est ouvert en mémoire à chaque réveil, jamais écrit ;
 *  - `K_box` (tirée du jeton) chiffre TOUT l'état au repos (`SealedStorage`, PH3) ;
 *  - toute requête vers l'API porte `Filarr-Gate-Host` (`signedFetch`) ;
 *  - LES RÉVEILS (`ctl.<domaine>/_filarr/notify/<accessId>`, HMAC sous `A_notify`) disent « relis » ;
 *    l'état de la boîte (en service, en sommeil, à effacer) se lit TOUJOURS dans la réponse de l'API,
 *    jamais dans le réveil ;
 *  - LE SOMMEIL : plus rien n'est servi (`503 gate_asleep`), la mémoire est vidée, l'état chiffré
 *    et le jeton scellé restent ; réveil sans geste quand l'API dit `running` ;
 *  - L'EFFACEMENT : tout le stockage de l'objet est effacé, la mémoire vidée, puis un reçu signé
 *    (`HOST_SIG`) est remis à l'API ; une base retirée seule donne un reçu partiel ;
 *  - LA GESTION par le créateur, seulement par le canal signé `/_admin/*` (aucune interface web) ;
 *  - LE COMPTE DES APPELS (1 000 000 par mois, `429 hosted_quota_calls`), remis chaque heure ;
 *  - L'EXPORT des réglages vers une boîte chez soi (`PUT /api-access/hosted/:id/export`), scellé
 *    vers l'identité en attente après vérification de `bindSig` par la clé ÉPINGLÉE du créateur.
 *
 * Ce que l'objet garde EN CLAIR (`host:meta`) : l'identifiant de l'accès, le nom d'hôte, l'état,
 * la raison et la fin d'un sommeil, les magasins et la génération tenue (pour le reçu), le compte
 * des appels du mois, un reçu à remettre. Rien qui vienne d'une base, d'un logiciel ou d'un réglage.
 */

import { CloudflareGate, type DoContext } from '../../cloudflare/src/host';
import type { DoStorage } from '../../cloudflare/src/storage';
import { deriveAccessKeys3, readNotifyBody, verifyNotify, type NotifyBody } from '../../core/src/engine/gate/access3';
import { deriveBoxKey, openSealedToken } from '../../core/src/engine/gate/host';
import { readSettings, sealSettingsFor } from '../../core/src/engine/gate/settings';
import { fromBase64Std, parseAccessToken } from '../../core/src/engine/store/apiAccess';
import { utf8Decode, type StoreCrypto } from '../../core/src/engine/store/crypto';
import { curves, storeCrypto } from '../../gate/src/crypto/providers';
import { wipeIdentity } from '../../gate/src/replica/token';
import { randomToken } from '../../gate/src/util/bytes';
import { DirectoryClient } from './directory';
import { apiUrlOf, domainOf, appOriginOf, HOST_VERSION, userAgent, type HostEnv } from './env';
import { HostApi, HostApiError, signedFetch, type HostedToken } from './hostApi';
import { corsHeaders, gateAsleep, json, nextMonthUtc, notFound, periodOf } from './http';
import { loadKeyring, signingKey, type HostKeyring } from './keys';
import { opsError } from './ops';
import { HOST_PREFIX, SealedStorage } from './sealedStorage';
import { CREATOR_HEADER, ERASED_ALL, RECEIPT_REASONS, parseCreatorHeader, signReceipt, verifyAdminRequest, type ErasureReceipt, type ReceiptReason, type WithdrawCause, WITHDRAW_CAUSES } from './wire';

/** Le stockage brut de l'objet durable. */
export interface RawStorage extends DoStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface BoxDeps {
  storage: RawStorage;
  waitUntil(promise: Promise<unknown>): void;
  env: HostEnv;
  directory: Pick<DirectoryClient, 'register' | 'tombstone'>;
  /** Le `fetch` du moteur (essais : le Filarr en mémoire). */
  fetchImpl?: typeof fetch;
  now?: () => number;
  crypto?: StoreCrypto;
  /** Le trousseau (essais : des clés de test épinglées) ; sinon les secrets et `docs/hosted-keys.json`. */
  ring?: HostKeyring;
  /** Essais : les intervalles de relève et de remise des comptes. */
  timing?: { checkEveryMs?: number; usageEveryMs?: number };
}

/** Les en-têtes posés par le Worker devant l'objet (jamais ceux du client : il les retire). */
export const INTERNAL = {
  route: 'x-filarr-host-route',
  access: 'x-filarr-host-access',
  name: 'x-filarr-host-name',
} as const;

export const ACCESS_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** 1 000 000 d'appels par mois et par boîte (§ 7.3), sauf barème plus précis lu dans `self.limits`. */
export const HOSTED_CALLS_PER_MONTH = 1_000_000;
/** Relève de l'état chez l'API, en plus des réveils : 5 minutes au plus tard (§ 2.3). */
export const CHECK_EVERY_MS = 5 * 60_000;
/** Remise du compte des appels : chaque heure (§ 7.3). */
export const USAGE_EVERY_MS = 3_600_000;
/** Un réveil d'une boîte froide coûte une lecture signée : une par 5 s au plus. */
const COLD_WAKE_MIN_MS = 5_000;
/** Un reçu non remis est réessayé. */
const RECEIPT_RETRY_MS = 10 * 60_000;
const ADMIN_MAX_BYTES = 12 * 1024 * 1024;
const NOTIFY_MAX_BYTES = 8192;

/** Les routes de gestion FERMÉES sur le service : pas de jeton, de mot de passe, d'oubli, de migration par fichier. */
const ADMIN_BLOCKED = /^\/(login|logout|setup(\/.*)?|token|password|forget|export|import)$/;

export interface PendingReceipt {
  receipt: ErasureReceipt;
  sig: string | null;
}

export interface BoxMeta {
  v: 1;
  accessId: string;
  hostName: string | null;
  keyId: string | null;
  state: 'running' | 'asleep' | 'erased';
  sleepReason: string | null;
  sleepUntil: string | null;
  /** Les magasins et la génération que la boîte tient (pour les reçus). */
  stores: Array<{ storeId: string; g: number }>;
  /** Le paquet initial (`s` du jeton scellé) est appliqué. */
  initApplied: boolean;
  /** Première fois que l'API a dit « effacer » (`requestedAt` du reçu). */
  erasingSince: string | null;
  receipts: PendingReceipt[];
  /** Après une migration vers chez soi : l'ancienne adresse redirige 30 jours (§ 8.4). */
  redirect?: { to: string; until: string } | null;
  calls: { period: string; n: number; reported: number; reportedAt: number };
  checkedAt: number;
}

const META = `${HOST_PREFIX}meta`;
const PIN_CREATOR = 'pin:creator';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * La raison d'un effacement complet (PH9) : `eraseReason` de l'API, telle quelle ; une API d'avant ne la donne pas,
 * le service la déduit alors (`sleepReason`, puis `migrated` si une redirection est posée, sinon `revoked`).
 */
export function erasureReason(t: Pick<HostedToken, 'sleepReason' | 'redirectTo' | 'eraseReason'>): ReceiptReason {
  // `withdrawn` ne sert jamais à un effacement complet (PH10) : une telle valeur est ignorée
  if (typeof t.eraseReason === 'string' && t.eraseReason !== 'withdrawn' && (RECEIPT_REASONS as readonly string[]).includes(t.eraseReason)) return t.eraseReason as ReceiptReason;
  if (t.sleepReason && (RECEIPT_REASONS as readonly string[]).includes(t.sleepReason) && t.sleepReason !== 'withdrawn') return t.sleepReason as ReceiptReason;
  if (t.redirectTo) return 'migrated';
  return 'revoked';
}

/** Les magasins et la génération tenue, lus dans la dernière réponse `self` de la réplique. */
export function heldStores(rawSelf: Record<string, unknown> | null): Array<{ storeId: string; g: number }> | null {
  if (!rawSelf || (isObj(rawSelf.access) && rawSelf.access.pending === true) || !Array.isArray(rawSelf.grants)) return null;
  const out: Array<{ storeId: string; g: number }> = [];
  for (const grant of rawSelf.grants as unknown[]) {
    if (!isObj(grant) || typeof grant.storeId !== 'string') continue;
    let g = 0;
    for (const k of Array.isArray(grant.keys) ? grant.keys : []) if (isObj(k) && typeof k.g === 'number' && k.g > g) g = k.g;
    out.push({ storeId: grant.storeId, g });
  }
  return out.sort((a, b) => (a.storeId < b.storeId ? -1 : a.storeId > b.storeId ? 1 : 0));
}

export interface OpenedToken {
  token: string;
  s: Record<string, unknown> | undefined;
  kBox: Uint8Array;
  aNotify: Uint8Array;
}

/**
 * Ouvre le jeton scellé (§ 2.1) avec la clé `HOST_ENC` qu'il désigne, et en tire `K_box` (§ 7.1,
 * PH2) et `A_notify` (api-base-1 rév. 3 § 5 bis). Lève si la clé manque (`host_key_missing`), si le
 * scellé ne s'ouvre pas, ou si `a`, `k` ou `t` ne sont pas ceux de cet accès (PH1).
 */
export async function openHostedToken(c: StoreCrypto, ring: HostKeyring, t: Pick<HostedToken, 'accessId' | 'keyId' | 'sealedToken'>): Promise<OpenedToken> {
  const key = ring.enc.get(t.keyId);
  if (!key) throw new Error('host_key_missing');
  if (!t.sealedToken) throw new Error('jeton scellé effacé');
  const plain = await openSealedToken(c, curves, key.privateKey, t.sealedToken, { accessId: t.accessId, keyId: t.keyId });
  const parsed = parseAccessToken(plain.t);
  if (!parsed) throw new Error('jeton illisible');
  const kBox = await deriveBoxKey(c, parsed.accessIdBytes, parsed.secret);
  const { aNotify, aMac } = await deriveAccessKeys3(c, parsed.accessIdBytes, parsed.secret);
  aMac.fill(0);
  parsed.secret.fill(0);
  return { token: plain.t, s: plain.s, kBox, aNotify };
}

export class BoxRuntime {
  private readonly env: HostEnv;
  private readonly storage: RawStorage;
  private readonly now: () => number;
  private readonly c: StoreCrypto;
  private readonly baseFetch: typeof fetch;
  private readonly ring: HostKeyring;
  private readonly api: HostApi | null;
  private readonly apiUrl: string | null;
  private meta: BoxMeta | null = null;
  private gate: CloudflareGate | null = null;
  private kBox: Uint8Array | null = null;
  /** La vue chiffrée que tient la boîte ouverte (fermée au sommeil et à l'effacement). */
  private sealed: SealedStorage | null = null;
  private aNotify: Uint8Array | null = null;
  /** La clé du créateur épinglée (copie en mémoire de l'entrée chiffrée `pin:creator`). */
  private pinned: string | null = null;
  private opening: Promise<void> | null = null;
  private refreshing: Promise<string> | null = null;
  private lastColdMiss = 0;
  private readonly seenAdmin = new Map<string, number>();
  private readonly checkEveryMs: number;
  private readonly usageEveryMs: number;

  constructor(private readonly deps: BoxDeps) {
    this.env = deps.env;
    this.storage = deps.storage;
    this.now = deps.now ?? (() => Date.now());
    this.c = deps.crypto ?? storeCrypto;
    const base = deps.fetchImpl ?? fetch;
    this.baseFetch = (input, init) => base(input, init);
    this.ring = deps.ring ?? loadKeyring(this.env);
    this.checkEveryMs = deps.timing?.checkEveryMs ?? CHECK_EVERY_MS;
    this.usageEveryMs = deps.timing?.usageEveryMs ?? USAGE_EVERY_MS;
    this.apiUrl = apiUrlOf(this.env);
    this.api = this.apiUrl ? new HostApi(this.apiUrl, () => signingKey(this.ring, this.now()), userAgent, this.baseFetch, this.now) : null;
  }

  // ==================== Les métadonnées en clair ====================

  private async loadMeta(accessId?: string): Promise<BoxMeta | null> {
    if (!this.meta) this.meta = (await this.storage.get<BoxMeta>(META)) ?? null;
    if (!this.meta && accessId) {
      this.meta = {
        v: 1,
        accessId,
        hostName: null,
        keyId: null,
        state: 'running',
        sleepReason: null,
        sleepUntil: null,
        stores: [],
        initApplied: false,
        erasingSince: null,
        receipts: [],
        calls: { period: periodOf(this.now()), n: 0, reported: 0, reportedAt: 0 },
        checkedAt: 0,
      };
    }
    if (this.meta && accessId && this.meta.accessId !== accessId) throw new Error('objet d’un autre accès');
    return this.meta;
  }

  private async saveMeta(): Promise<void> {
    if (this.meta) await this.storage.put(META, this.meta);
  }

  /** Pour les essais et l'exploitation : l'état sans contenu. */
  async status(): Promise<{ meta: BoxMeta | null; open: boolean; link: string | null }> {
    return { meta: await this.loadMeta(), open: this.gate !== null, link: this.gate?.replicator.link ?? null };
  }

  /** Vide la mémoire sans rien effacer (essais, arrêt de l'objet). */
  async dispose(): Promise<void> {
    await this.close(true);
  }

  // ==================== Entrée ====================

  async fetch(request: Request): Promise<Response> {
    const accessId = request.headers.get(INTERNAL.access) ?? '';
    if (!ACCESS_ID_RE.test(accessId)) return notFound();
    try {
      await this.loadMeta(accessId);
    } catch {
      return notFound();
    }
    const route = request.headers.get(INTERNAL.route);
    if (route === 'notify') return this.handleNotify(request);
    if (route === 'box') return this.handleBox(request, request.headers.get(INTERNAL.name) ?? '');
    return notFound();
  }

  // ==================== L'état lu chez l'API ====================

  /**
   * Relit l'état de la boîte chez l'API et l'applique : ouvrir, endormir, effacer, exporter.
   * Rend l'état local qui en résulte (`running`, `asleep`, `erased`, `absent`, `unavailable`).
   */
  refresh(): Promise<string> {
    if (!this.refreshing) {
      this.refreshing = this.refreshInner().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async refreshInner(): Promise<string> {
    const meta = this.meta;
    if (!meta || !this.api) return 'unavailable';
    let t: HostedToken;
    try {
      t = await this.api.token(meta.accessId);
    } catch (err) {
      if (err instanceof HostApiError && err.code === 'hosting_not_found') {
        // L'accès n'est pas (ou plus) hébergé : une boîte locale qui tiendrait encore quelque chose l'efface
        if (meta.state !== 'erased' && (this.gate || meta.hostName)) await this.erase({ accessId: meta.accessId, hostName: meta.hostName ?? '', keyId: meta.keyId ?? '', sealedToken: null, state: 'erased', sleepReason: null, sleepUntil: null, redirectTo: null, redirectUntil: null, exportPending: false }, false);
        return 'absent';
      }
      return 'unavailable';
    }
    if (t.accessId !== meta.accessId) return 'unavailable';
    meta.checkedAt = this.now();
    if (t.state === 'erased' || t.state === 'erasing' || t.sealedToken === null) {
      if (meta.state !== 'erased' || meta.receipts.length > 0) await this.erase(t, t.state === 'erasing');
      return 'erased';
    }
    meta.hostName = t.hostName;
    meta.keyId = t.keyId;
    if (meta.state === 'erased') {
      // Un accès effacé puis confié de nouveau (nouveau nom, nouveau jeton scellé) : une boîte neuve
      meta.state = 'running';
      meta.stores = [];
      meta.initApplied = false;
      meta.erasingSince = null;
    }
    if (t.state === 'asleep') {
      await this.sleep(t.sleepReason, t.sleepUntil);
      if (t.exportPending) await this.exportToSelf(t).catch(() => opsError('export_failed'));
      await this.saveMeta();
      return 'asleep';
    }
    meta.state = 'running';
    meta.sleepReason = null;
    meta.sleepUntil = null;
    await this.saveMeta();
    await this.open(t);
    await this.deps.directory.register(t.hostName, meta.accessId).catch(() => opsError('directory_failed'));
    if (t.exportPending) await this.exportToSelf(t).catch(() => opsError('export_failed'));
    return 'running';
  }

  // ==================== Ouvrir ====================

  private open(t: HostedToken): Promise<void> {
    if (this.gate) return Promise.resolve();
    if (!this.opening) {
      this.opening = this.openInner(t).finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  private async unseal(t: HostedToken): Promise<OpenedToken> {
    try {
      return await openHostedToken(this.c, this.ring, t);
    } catch (err) {
      if ((err as Error).message === 'host_key_missing') opsError('host_key_missing');
      throw err;
    }
  }

  private async openInner(t: HostedToken): Promise<void> {
    const meta = this.meta!;
    const { token, s, kBox, aNotify } = await this.unseal(t);
    const fetchImpl = signedFetch(this.apiUrl!, () => signingKey(this.ring, this.now()), this.baseFetch, this.now);
    const gateEnv: Record<string, string> = {
      FILARR_GATE_TOKEN: token,
      FILARR_GATE_API_URL: this.apiUrl!,
      FILARR_GATE_PUBLIC_URL: `https://${t.hostName}.${domainOf(this.env)}`,
      // Verrouillés : aucune métrique publique, schéma OpenAPI derrière une clé, réveils acceptés, relève de 5 min
      FILARR_GATE_METRICS: 'false',
      FILARR_GATE_DOCS: 'false',
      FILARR_GATE_NOTIFY: 'true',
      FILARR_GATE_POLL_SECONDS: '300',
      FILARR_GATE_LOG_LEVEL: 'silent',
    };
    const attempt = async (): Promise<CloudflareGate> => {
      this.sealed?.close();
      const sealed = new SealedStorage(this.storage, { crypto: this.c, kBox, accessId: meta.accessId });
      this.sealed = sealed;
      const storage = Object.assign(sealed, {
        getAlarm: () => this.storage.getAlarm(),
        setAlarm: (at: number) => this.storage.setAlarm(at),
      });
      const ctx: DoContext = { storage, waitUntil: (p) => this.deps.waitUntil(p) };
      return CloudflareGate.open(ctx, gateEnv, { fetchImpl });
    };
    let gate: CloudflareGate;
    try {
      gate = await attempt();
    } catch {
      // Un état qui ne s'ouvre pas sous CE K_box (reste d'un ancien hébergement) : effacé, boîte neuve
      opsError('state_unreadable');
      await this.wipeSealed();
      meta.initApplied = false;
      gate = await attempt();
    }
    // Le canal de gestion entre par le canal local de la boîte, avec un secret qui ne vit qu'ici
    gate.cliSecret = randomToken(24);
    this.gate = gate;
    this.kBox = kBox;
    this.aNotify = aNotify;
    if (!meta.initApplied) {
      if (s && Object.keys(s).length > 0) {
        try {
          gate.applySettings(readSettings(JSON.stringify(s), meta.accessId));
        } catch {
          /* un paquet initial illisible n'empêche pas de servir : les clés se donnent par le canal de gestion */
        }
      }
      meta.initApplied = true;
      await this.saveMeta();
    }
    this.deps.waitUntil(gate.started.then(() => this.afterWork()).catch(() => undefined));
  }

  /** Efface l'état chiffré (jamais `host:meta`). */
  private async wipeSealed(): Promise<void> {
    const all = [...(await this.storage.list({})).keys()].filter((k) => !k.startsWith(HOST_PREFIX));
    for (let i = 0; i < all.length; i += 128) await this.storage.delete(all.slice(i, i + 128));
  }

  /**
   * Vide la mémoire : la boîte, `K_box`. `flush` : verser l'état avant (sommeil, arrêt) ; sinon tout
   * est oublié (effacement). `keepWakeKey` : garder `A_notify` (sommeil) — une clé de réveil, qui
   * n'ouvre rien (l'API en tient la copie), pour vérifier les réveils sans relire le jeton.
   */
  private async close(flush: boolean, keepWakeKey = false): Promise<void> {
    const gate = this.gate;
    this.gate = null;
    if (gate) {
      gate.cliSecret = null;
      // Arrêter (synchros, webhooks, réplique) et verser l'état : il reste chiffré au repos
      await gate.stop().catch(() => undefined);
      if (flush) {
        // La mémoire seulement : lignes déchiffrées et clés dérivées ; le cache chiffré reste
        const r = gate.replicator;
        for (const b of r.bases.values()) b.mirror.wipe();
        r.bases.clear();
        if (r.identity) wipeIdentity(r.identity);
        r.identity = null;
      } else {
        // Effacement : la réplique oublie tout, cache compris
        await gate.replicator.forget().catch(() => undefined);
      }
    }
    this.sealed?.close();
    this.sealed = null;
    this.kBox?.fill(0);
    this.kBox = null;
    this.pinned = null;
    if (!keepWakeKey) {
      this.aNotify?.fill(0);
      this.aNotify = null;
    }
  }

  // ==================== Sommeil (§ 9.3) ====================

  private async sleep(reason: string | null, until: string | null): Promise<void> {
    const meta = this.meta!;
    if (this.gate) {
      await this.pinCreator();
      await this.close(true, true);
    }
    meta.state = 'asleep';
    meta.sleepReason = reason;
    meta.sleepUntil = until;
    await this.storage.setAlarm(this.now() + this.checkEveryMs);
  }

  // ==================== Effacement (§ 8.1, § 8.5) ====================

  private buildReceipt(
    meta: BoxMeta,
    reason: ReceiptReason,
    stores: Array<{ storeId: string; g: number }>,
    erased: readonly string[],
    requestedAt: string,
    cause?: WithdrawCause
  ): ErasureReceipt {
    const key = signingKey(this.ring, this.now());
    return {
      v: 1,
      kind: 'filarr-gate-host/erasure',
      keyId: key?.id ?? '',
      accessId: meta.accessId,
      hostName: meta.hostName ?? '',
      reason,
      ...(cause ? { cause } : {}),
      stores,
      erased: [...erased],
      requestedAt,
      erasedAt: new Date(this.now()).toISOString(),
      version: HOST_VERSION,
      codeHash: typeof this.env.HOST_CODE_HASH === 'string' ? this.env.HOST_CODE_HASH : '',
    };
  }

  private sign(p: PendingReceipt): PendingReceipt {
    if (p.sig) return p;
    const key = signingKey(this.ring, this.now());
    if (!key) {
      opsError('host_key_missing');
      return p;
    }
    const receipt = { ...p.receipt, keyId: key.id };
    return { receipt, sig: signReceipt(key, receipt) };
  }

  /**
   * Efface tout : la boîte en mémoire, `K_box`, le stockage de l'objet. Puis un reçu signé est remis
   * à l'API (`sendReceipt` : faux quand l'API a déjà tout effacé de son côté, sans reçu attendu).
   */
  private async erase(t: HostedToken, sendReceipt: boolean): Promise<void> {
    const meta = this.meta!;
    if (meta.state !== 'erased') {
      // PH9 : l'heure de la demande, telle que l'API la donne ; sinon l'heure où le service l'a vue
      const askedAt = typeof t.eraseRequestedAt === 'string' && Number.isFinite(Date.parse(t.eraseRequestedAt)) ? t.eraseRequestedAt : null;
      if (!meta.erasingSince) meta.erasingSince = askedAt ?? new Date(this.now()).toISOString();
      if (t.hostName) meta.hostName = t.hostName;
      const receipt = this.buildReceipt(meta, erasureReason(t), meta.stores, ERASED_ALL, meta.erasingSince);
      await this.close(false);
      try {
        await this.storage.deleteAlarm();
        await this.storage.deleteAll();
      } catch {
        opsError('erase_failed');
        throw new Error('erase_failed');
      }
      meta.state = 'erased';
      meta.stores = [];
      meta.sleepReason = null;
      meta.sleepUntil = null;
      meta.initApplied = false;
      if (sendReceipt) meta.receipts = [...meta.receipts, this.sign({ receipt, sig: null })];
      await this.saveMeta();
      const redirect = t.redirectTo && t.redirectUntil && /^https:\/\/[^\s]+$/.test(t.redirectTo) && Date.parse(t.redirectUntil) > this.now() ? { to: t.redirectTo, until: t.redirectUntil } : null;
      meta.redirect = redirect;
      await this.saveMeta();
      if (meta.hostName) await this.deps.directory.tombstone(meta.hostName, meta.accessId, redirect).catch(() => opsError('directory_failed'));
    }
    await this.flushReceipts();
  }

  /** Remet les reçus en attente ; ce qui échoue est réessayé par l'alarme. */
  private async flushReceipts(): Promise<void> {
    const meta = this.meta!;
    if (!this.api || meta.receipts.length === 0) return;
    const left: PendingReceipt[] = [];
    for (const raw of meta.receipts) {
      const p = this.sign(raw);
      if (!p.sig) {
        left.push(p);
        continue;
      }
      try {
        await this.api.receipt(meta.accessId, p.receipt, p.sig);
      } catch (err) {
        // Un reçu que l'API refuse pour sa forme ne passera jamais : on ne le garde pas
        if (!(err instanceof HostApiError && (err.status === 400 || err.status === 404))) left.push(p);
        if (!(err instanceof HostApiError)) opsError('receipt_failed');
      }
    }
    meta.receipts = left;
    await this.saveMeta();
    if (left.length > 0) await this.storage.setAlarm(this.now() + RECEIPT_RETRY_MS);
  }

  /**
   * Une base sortie de la boîte (retrait par le créateur ou un administrateur du coffre, accord
   * périmé) : la réplique a déjà effacé ses lignes, ses clés et ses blocs ; reçu partiel (`withdrawn`).
   */
  private async reconcileStores(): Promise<void> {
    const meta = this.meta;
    const gate = this.gate;
    if (!meta || !gate || meta.state !== 'running') return;
    const held = heldStores(gate.replicator.rawSelf);
    if (!held) return;
    const gone = meta.stores.filter((s) => !held.some((h) => h.storeId === s.storeId));
    const same = JSON.stringify(held) === JSON.stringify(meta.stores);
    if (same) return;
    // PH10 : la cause de chaque retrait se lit dans `pendingWithdrawals` de l'API ; absente (API d'avant), pas de `cause`
    const causes = new Map<string, WithdrawCause>();
    if (gone.length > 0 && this.api) {
      try {
        const t = await this.api.token(meta.accessId);
        for (const w of t.pendingWithdrawals ?? []) {
          if (w && typeof w.storeId === 'string' && typeof w.cause === 'string' && (WITHDRAW_CAUSES as readonly string[]).includes(w.cause)) causes.set(w.storeId, w.cause as WithdrawCause);
        }
      } catch {
        /* l'API injoignable : le reçu part sans cause plutôt que pas du tout */
      }
    }
    for (const s of gone) {
      const at = new Date(this.now()).toISOString();
      meta.receipts.push(this.sign({ receipt: this.buildReceipt(meta, 'withdrawn', [s], ['dbKeys', 'copy'], at, causes.get(s.storeId)), sig: null }));
    }
    meta.stores = held;
    await this.saveMeta();
    if (gone.length > 0) await this.flushReceipts();
  }

  // ==================== Export vers chez soi (§ 8.4) ====================

  /** La clé de signature du créateur, authentifiée par `creatorTag`, ÉPINGLÉE dans l'état chiffré. */
  private async pinCreator(): Promise<string | null> {
    const gate = this.gate;
    if (!gate) return null;
    const creator = gate.replicator.creator;
    const fresh = creator.status === 'authenticated' && creator.signingPublicKey ? creator.signingPublicKey : null;
    if (fresh && fresh === this.pinned) return fresh;
    const sealed = this.sealedView();
    if (!sealed) return fresh;
    const kept = (await sealed.get<string>(PIN_CREATOR)) ?? null;
    // Une clé neuve authentifiée par l'étiquette (le créateur a changé de paire) remplace l'épinglée
    if (fresh && kept !== fresh) await sealed.put(PIN_CREATOR, fresh);
    this.pinned = fresh ?? kept;
    sealed.close();
    return this.pinned;
  }

  private sealedView(): SealedStorage | null {
    return this.kBox && this.meta ? new SealedStorage(this.storage, { crypto: this.c, kBox: this.kBox, accessId: this.meta.accessId }) : null;
  }

  private async exportToSelf(t: HostedToken): Promise<void> {
    const meta = this.meta!;
    const api = this.api!;
    const wasAsleep = meta.state === 'asleep';
    if (!this.gate) await this.open(t);
    try {
      const gate = this.gate!;
      const creatorKey = await this.pinCreator();
      if (!creatorKey) throw new Error('clé du créateur non authentifiée');
      const pending = await api.pending(meta.accessId);
      await gate.sync?.cacheShadows();
      const pkg = { ...gate.settingsPackage(), accessId: meta.accessId };
      const sealed = await sealSettingsFor(this.c, curves, pkg, { accessId: meta.accessId, encPublicKey: pending.encPublicKey, bindSig: pending.bindSig }, creatorKey);
      await api.putExport(meta.accessId, sealed);
    } finally {
      if (wasAsleep) await this.close(true, true);
    }
  }

  // ==================== Réveils (§ 2.3) ====================

  private async handleNotify(request: Request): Promise<Response> {
    const meta = this.meta!;
    let raw: string;
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > NOTIFY_MAX_BYTES) return json(413, { error: 'Body too large', code: 'body_too_large' });
      raw = utf8Decode(bytes);
    } catch {
      return json(400, { error: 'Unreadable wake-up', code: 'notify_malformed' });
    }
    const header = request.headers.get('filarr-notify');
    const nowS = Math.floor(this.now() / 1000);
    let aNotify = this.aNotify;
    if (!aNotify) {
      // Boîte froide : la clé du réveil ne s'obtient qu'en ouvrant le jeton scellé (une lecture signée).
      // Une lecture qui n'a pas donné la clé (API injoignable, jeton effacé) n'est pas refaite avant 5 s.
      if (this.now() - this.lastColdMiss < COLD_WAKE_MIN_MS) return json(429, { error: 'Too many wake-ups', code: 'notify_rate' }, { 'Retry-After': '5' });
      if (!this.api) return json(503, { error: 'Service not configured', code: 'host_unconfigured' });
      let t: HostedToken;
      try {
        t = await this.api.token(meta.accessId);
      } catch (err) {
        this.lastColdMiss = this.now();
        if (err instanceof HostApiError && err.code === 'hosting_not_found') return notFound();
        return json(503, { error: 'Filarr unreachable', code: 'filarr_unreachable' });
      }
      if (t.sealedToken === null || t.state === 'erasing' || t.state === 'erased') {
        // Rien à vérifier (le jeton est effacé) : l'état de l'API fait foi, le réveil ne décide rien
        this.lastColdMiss = this.now();
        this.deps.waitUntil(this.refresh().catch(() => undefined));
        return json(202, { ok: true });
      }
      try {
        const opened = await this.unseal(t);
        // Gardée : les réveils suivants se vérifient sans relire le jeton (une lecture par vie de l'objet)
        aNotify = opened.aNotify;
        this.aNotify = aNotify;
        opened.kBox.fill(0);
      } catch {
        this.lastColdMiss = this.now();
        opsError('box_open_failed');
        return json(503, { error: 'Box unavailable', code: 'box_unavailable' });
      }
    }
    const verdict = await verifyNotify(this.c, aNotify, header, raw, nowS);
    if (verdict !== 'ok') return json(401, { error: 'Wake-up refused', code: `notify_${verdict}` });
    const body = readNotifyBody(raw, meta.accessId);
    if (!body) return json(400, { error: 'Unreadable wake-up', code: 'notify_malformed' });
    this.deps.waitUntil(this.onWake(body).catch(() => undefined));
    return json(202, { ok: true });
  }

  private async onWake(body: NotifyBody): Promise<void> {
    // L'état de la boîte, la migration, la révocation : on relit chez l'API
    if (!this.gate || body.t === 'hosting' || body.t === 'export' || body.t === 'revoked') {
      const state = await this.refresh();
      if (state !== 'running' || body.t === 'hosting' || body.t === 'export') {
        await this.afterWork();
        return;
      }
    }
    await this.gate?.replicator.wake(body);
    await this.afterWork();
  }

  /** Après un réveil, une requête ou une alarme : ce que la réplique a appris, reçus, comptes, prochaine alarme. */
  private async afterWork(): Promise<void> {
    const gate = this.gate;
    if (gate) {
      const link = gate.replicator.link;
      // Refus de l'API (sommeil, révocation, jeton inconnu) : l'état se relit chez elle
      if (link === 'asleep' || link === 'revoked' || link === 'unknown_access') {
        const state = await this.refresh();
        if (state !== 'running') return;
      }
      await this.reconcileStores();
      await this.pinCreator().catch(() => undefined);
      await gate.settle().catch(() => undefined);
    }
    await this.reportUsage(false);
  }

  // ==================== Alarme ====================

  async alarm(): Promise<void> {
    const meta = await this.loadMeta();
    if (!meta) return;
    if (meta.state === 'erased') {
      await this.flushReceipts();
      return;
    }
    const due = this.now() - meta.checkedAt >= this.checkEveryMs;
    if (!this.gate || meta.state === 'asleep' || due) {
      const state = await this.refresh();
      if (state === 'asleep') {
        await this.reportUsage(false);
        return;
      }
      if (state !== 'running') {
        if (state === 'unavailable') await this.storage.setAlarm(this.now() + this.checkEveryMs);
        return;
      }
    }
    await this.gate?.onAlarm().catch(() => undefined);
    await this.afterWork();
  }

  // ==================== Appels de la boîte (§ 7.3) ====================

  private callLimit(): number {
    const lim = this.gate?.replicator.limits as Record<string, unknown> | null | undefined;
    const n = lim?.hostedCallsPerMonth;
    return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : HOSTED_CALLS_PER_MONTH;
  }

  /** Compte un appel ; rend la réponse de refus si le mois est épuisé. */
  private async countCall(): Promise<Response | null> {
    const meta = this.meta!;
    const now = this.now();
    const period = periodOf(now);
    if (meta.calls.period !== period) {
      await this.reportUsage(true);
      meta.calls = { period, n: 0, reported: 0, reportedAt: meta.calls.reportedAt };
    }
    if (meta.calls.n >= this.callLimit()) {
      const retry = Math.max(1, Math.ceil((nextMonthUtc(now) - now) / 1000));
      return json(429, { error: 'Monthly calls of this hosted box are used up', code: 'hosted_quota_calls', remedy: ['wait'], retryAfter: retry }, { 'Retry-After': String(retry) });
    }
    meta.calls.n += 1;
    await this.saveMeta();
    return null;
  }

  /** Remet le total du mois (rejouable : l'API garde le plus grand). `force` : avant de changer de mois. */
  private async reportUsage(force: boolean): Promise<void> {
    const meta = this.meta;
    if (!meta || !this.api || meta.calls.n <= meta.calls.reported) return;
    if (!force && this.now() - meta.calls.reportedAt < this.usageEveryMs) return;
    try {
      await this.api.usage([{ accessId: meta.accessId, period: meta.calls.period, calls: meta.calls.n }]);
      meta.calls.reported = meta.calls.n;
      meta.calls.reportedAt = this.now();
      await this.saveMeta();
    } catch {
      opsError('usage_failed');
    }
  }

  // ==================== Requêtes des logiciels et du créateur ====================

  private async handleBox(request: Request, hostName: string): Promise<Response> {
    const meta = this.meta!;
    const url = new URL(request.url);
    const path = url.pathname;
    if (meta.state === 'erased') {
      const r = meta.redirect;
      // La redirection d'une migration, sans lire ni garder la requête (§ 8.4)
      if (r && Date.parse(r.until) > this.now()) return new Response(null, { status: 308, headers: { Location: `${r.to.replace(/\/+$/, '')}${path}${url.search}`, 'Cache-Control': 'no-store' } });
      return notFound();
    }
    if (path === '/_filarr' || path.startsWith('/_filarr/') || path === '/admin' || path.startsWith('/admin/') || path === '/metrics') return notFound();
    if (meta.hostName && hostName !== meta.hostName) return notFound();
    if (!this.gate && meta.state !== 'asleep') {
      const state = await this.refresh().catch(() => 'unavailable');
      if (state === 'erased' || state === 'absent') return notFound();
      if (state === 'unavailable' && !this.gate) return json(503, { error: 'Box unavailable, retry shortly', code: 'box_unavailable' }, { 'Retry-After': '30' });
    }
    if (meta.state === 'asleep' || this.gate?.replicator.link === 'asleep') {
      const reason = meta.state === 'asleep' ? meta.sleepReason : 'service';
      const until = meta.state === 'asleep' ? meta.sleepUntil : null;
      if (path === '/health') return json(200, { status: 'asleep', reason, sleepUntil: until, version: HOST_VERSION });
      return gateAsleep(reason, until);
    }
    const gate = this.gate!;
    try {
      if (path === '/health') {
        const r = gate.replicator;
        const bases = [...r.bases.values()];
        const ready = ['live', 'polling', 'connecting'].includes(r.link) && bases.every((b) => b.mirror.status === 'ready');
        return json(200, { status: r.link === 'connecting' && bases.length === 0 ? 'preparing' : ready ? 'ok' : 'degraded', link: r.link, version: HOST_VERSION });
      }
      if (path === '/_admin' || path.startsWith('/_admin/')) return await this.handleAdmin(request, url, gate);
      const counted = path.startsWith('/v1/') || path === '/mcp' || path === '/openapi.json' || path === '/docs';
      if (counted && request.method !== 'OPTIONS') {
        const refused = await this.countCall();
        if (refused) return refused;
      }
      return await gate.api.handle(request, { remoteAddress: request.headers.get('cf-connecting-ip') ?? '' });
    } finally {
      this.deps.waitUntil(this.afterWork().catch(() => undefined));
    }
  }

  /** Le canal de gestion (§ 7.2) : signé par la clé d'identité du créateur, relayé vers l'API de gestion de la boîte. */
  private async handleAdmin(request: Request, url: URL, gate: CloudflareGate): Promise<Response> {
    const cors = corsHeaders(request.headers.get('origin'), appOriginOf(this.env), `Content-Type, ${CREATOR_HEADER}`);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length > ADMIN_MAX_BYTES) return json(413, { error: 'Body too large', code: 'body_too_large' }, cors);
    const header = request.headers.get(CREATOR_HEADER);
    const creatorKey = await this.pinCreator();
    let pub: Uint8Array | null = null;
    try {
      pub = creatorKey ? fromBase64Std(creatorKey) : null;
    } catch {
      pub = null;
    }
    const nowS = Math.floor(this.now() / 1000);
    const verdict = verifyAdminRequest({ header, method: request.method, pathWithQuery: url.pathname + url.search, body, creatorSigningPublicKey: pub, nowS });
    if (verdict !== 'ok') return json(401, { error: 'Management request refused', code: `admin_${verdict}` }, cors);
    // Une même requête signée ne passe qu'une fois
    const sig = parseCreatorHeader(header)!;
    const seenKey = Array.from(sig.s.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
    for (const [k, until] of this.seenAdmin) if (until < nowS) this.seenAdmin.delete(k);
    // PH11 : chaque (t, signature) une seule fois ; un rejeu est refusé `401 admin_replay`
    if (this.seenAdmin.has(seenKey)) return json(401, { error: 'Replayed management request', code: 'admin_replay' }, cors);
    this.seenAdmin.set(seenKey, nowS + 2 * 300);
    const sub = url.pathname.slice('/_admin'.length).replace(/\/+$/, '') || '/';
    if (ADMIN_BLOCKED.test(sub)) return json(403, { error: 'Not available on a hosted box', code: 'admin_route_forbidden' }, cors);
    if (!gate.cliSecret) return json(503, { error: 'Box unavailable', code: 'box_unavailable' }, cors);
    const forwarded = new Request(`https://${url.host}/admin/api${sub}${url.search}`, {
      method: request.method,
      headers: {
        'Content-Type': request.headers.get('content-type') ?? 'application/json',
        'X-Gate-Admin': '1',
        'X-Gate-CLI': gate.cliSecret,
      },
      ...(body.length > 0 && request.method !== 'GET' && request.method !== 'HEAD' ? { body } : {}),
    });
    // Le canal local de la boîte (celui de la ligne de commande) : la requête vient d'ici, déjà authentifiée
    const res = await gate.admin.handle(forwarded, { remoteAddress: '127.0.0.1' });
    const headers = new Headers(res.headers);
    headers.delete('set-cookie');
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  }
}

