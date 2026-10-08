/**
 * LE MIROIR D'UN MAGASIN — la boîte noire en lectrice (et rédactrice) `db-store-1`,
 * avec la génération du contrat `api-base-1` § 2.
 *
 * LIRE : la tête (`GET /dbstore/:id/head` → `{ seq, head, hk, g }`), ouverte sous
 * la clé que nomme `hk` ; puis les seuls blocs dont la version a changé, pris au
 * cache local ou demandés par `slots:batchGet`. Chaque corps est VÉRIFIÉ contre
 * le `mac` de la tête avant d'être ouvert, sous la `K_db(e, g)` que nomme SON
 * entrée (`g` absent vaut 0). Les lignes sont rebâties en mémoire (registres
 * « dernier écrit gagne » → `DbRow`), jamais écrites en clair sur le disque.
 *
 * Une clé absente pour un `(e, g)` de la tête ou d'un bloc n'est JAMAIS sautée :
 * le miroir garde son dernier état complet et dit « clé manquante pour (e, g) ».
 * Un état partiel n'est jamais servi.
 *
 * ÉCRIRE (§ 7, derrière l'interrupteur de la boîte noire) : registres « dernier
 * écrit gagne », blocs scellés sous `K_db(e courante, g courante)`, tête
 * rescellée, `commit` en compare-and-swap sur `baseSeq`. Un `409` (`seq_conflict`,
 * `stale_generation`…) fait relire la tête, resceller et rejouer : la fusion des
 * registres est une union, rejouer les mêmes écritures ne change rien.
 */

import type { DbRow } from '../core/types';
import {
  headKeyBytes,
  isCover,
  layoutSlot,
  merkleRoot,
  openHead,
  openSlot,
  placeHash,
  prefixFor,
  sealHead,
  slotMac,
  verifySlot,
  type LaidSlot,
  type SlotEntry,
  type StoreHead,
} from '../core/engine/store/codec';
import { canonicalJson } from '../core/engine/store/canonical';
import { fromBase64Url, toBase64Url, type StoreKeys } from '../core/engine/store/crypto';
import { HlcClock } from '../core/engine/store/hlc';
import { positionBetween } from '../core/engine/store/fracIndex';
import {
  applyOp,
  FIELD_ORDER,
  materializeRows,
  mergeRow,
  ownRegister,
  ownRow,
  type StoreOp,
  type StoreRows,
} from '../core/engine/store/registers';
import { headZones, type SlotZone } from '../core/engine/store/zones';
import { storeCrypto as c } from '../crypto/providers';
import { keyId, type Rights } from './access';
import { refOf, type BlockCache } from './blockCache';
import { FilarrError, type FilarrClient } from './http';

export interface HeadResponse {
  seq: number;
  head: string | null;
  hk?: { e?: unknown; g?: unknown } | null;
  g?: unknown;
}

export interface ChangesResponse {
  seq: number;
  slots?: Array<{ p: string; ver: number; e: number; g?: number }>;
  removed?: string[];
}

export interface KeyRef {
  e: number;
  g: number;
}

export type MirrorStatus =
  /** Jamais encore lu. */
  | 'loading'
  | 'ready'
  /** La tête ou un bloc demande une `K_db(e, g)` que l'accès n'a pas (encore) : le dernier état reste servi. */
  | 'missing_key'
  /** Tête ou bloc qui ne passe pas la vérification, ou serveur qui recule : rien n'est installé. */
  | 'unverified'
  /** Quota ou débit atteint chez Filarr : le dernier état reste servi, nouvel essai plus tard. */
  | 'waiting'
  /** Filarr refuse ce magasin à l'accès. */
  | 'refused'
  /** Filarr injoignable : le dernier état reste servi. */
  | 'offline';

export interface MirrorProblem {
  code: string;
  message: string;
  keys?: KeyRef[];
}

export interface RowDiff {
  storeId: string;
  seq: number;
  origin: 'filarr' | 'gate';
  created: DbRow[];
  updated: Array<{ before: DbRow; after: DbRow }>;
  deleted: DbRow[];
}

interface MirrorSlot {
  ver: number;
  e: number;
  g: number;
  mac: string;
  rows: StoreRows;
  bytes: number;
}

export class StoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreIntegrityError';
  }
}

export class KeyMissingError extends Error {
  constructor(readonly keys: KeyRef[]) {
    super(`clé manquante pour ${keys.map((k) => `(${k.e}, ${k.g})`).join(', ') || 'la tête'}`);
    this.name = 'KeyMissingError';
  }
}

export class WriteRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = 'WriteRefusedError';
  }
}

const isNat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const entryGen = (entry: SlotEntry): number => {
  const g = (entry as SlotEntry & { g?: unknown }).g;
  return isNat(g) ? g : 0;
};
const urlPrefix = (p: string): string => (p === '' ? '-' : p);

/** Corps en ligne dans une validation tant que le budget tient ; au-delà, un dépôt (`stage`). */
const INLINE_MAX = 64 * 1024;
const INLINE_BUDGET = 2 * 1024 * 1024;
const BATCH_MAX_BYTES = 2 * 1024 * 1024;

export interface MirrorDeps {
  client: FilarrClient;
  cache: BlockCache;
  site: string;
  now?: () => number;
}

export class StoreMirror {
  status: MirrorStatus = 'loading';
  problem: MirrorProblem | null = null;
  seq = 0;
  head: StoreHead | null = null;
  /** La clé qui scelle la tête lue (`hk`). */
  hk: KeyRef | null = null;
  /** La génération COURANTE du magasin (`g` de la réponse de tête). */
  generation = 0;
  rows: DbRow[] = [];
  /** `seq` du changement le plus récent vu par cette boîte noire, par ligne. */
  readonly rowSeq = new Map<string, number>();
  lastSyncAt: string | null = null;
  readonly clock: HlcClock;

  private slots = new Map<string, MirrorSlot>();
  private registers: StoreRows = {};
  private byId = new Map<string, DbRow>();
  private zoneCache = new Map<string, SlotZone>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly storeId: string,
    public rights: Rights,
    public keys: Map<string, StoreKeys>,
    private readonly deps: MirrorDeps
  ) {
    this.clock = new HlcClock(deps.site, deps.now ?? Date.now);
  }

  /** Les opérations d'un magasin passent l'une après l'autre (lecture, écriture). */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Vrai quand un état complet est servi (même ancien). */
  get loaded(): boolean {
    return this.head !== null || (this.status === 'ready' && this.seq === 0);
  }

  get rowCount(): number {
    return this.rows.length;
  }

  get encryptedBytes(): number {
    let n = 0;
    for (const s of this.slots.values()) n += s.bytes;
    return n;
  }

  get blockCount(): number {
    return this.slots.size;
  }

  rowById(id: string): DbRow | undefined {
    return this.byId.get(id);
  }

  /** Les registres d'une ligne (pour calculer une écriture). */
  registersOf(id: string) {
    return ownRow(this.registers, id);
  }

  /** La plus grande position manuelle (`#o`) : une ligne ajoutée se place après elle. */
  lastOrder(): string | null {
    let max: string | null = null;
    for (const regs of Object.values(this.registers)) {
      const o = ownRegister(regs, FIELD_ORDER)?.v;
      if (typeof o === 'string' && (max === null || o > max)) max = o;
    }
    return max;
  }

  /** Une position après la dernière. */
  nextOrder(): string {
    return positionBetween(this.lastOrder(), null);
  }

  /** Les couples `(e, g)` détenus. */
  heldKeys(): KeyRef[] {
    return [...this.keys.values()]
      .map((k) => ({ e: k.epoch, g: k.generation }))
      .sort((a, b) => a.e - b.e || a.g - b.g);
  }

  private setProblem(status: MirrorStatus, problem: MirrorProblem | null): void {
    this.status = status;
    this.problem = problem;
  }

  /** Marque l'état sans le toucher (injoignable, quota). */
  markUnavailable(status: 'offline' | 'waiting' | 'refused', problem: MirrorProblem): void {
    this.setProblem(status, problem);
  }

  // ==================== Lecture ====================

  /** Relit la tête et rattrape les blocs changés ; rend les lignes changées, ou `null`. */
  sync(force = false): Promise<RowDiff | null> {
    return this.serial(() => this.syncNow(force, 0));
  }

  private async syncNow(force: boolean, depth: number): Promise<RowDiff | null> {
    const res = await this.deps.client.json<HeadResponse>('GET', `dbstore/${this.storeId}/head`);
    if (!isNat(res.seq)) throw new StoreIntegrityError('réponse de tête illisible');
    if (res.seq < this.seq) {
      this.setProblem('unverified', {
        code: 'rollback',
        message: `le serveur est revenu en arrière (${res.seq} < ${this.seq})`,
      });
      return null;
    }
    if (isNat(res.g)) this.generation = res.g;
    if (!force && res.seq === this.seq && this.status === 'ready' && this.loaded) return null;

    if (res.head === null || res.head === undefined) {
      if (res.seq !== 0) {
        this.setProblem('unverified', { code: 'head_missing', message: `tête absente au seq ${res.seq}` });
        return null;
      }
      return this.install(0, null, null, new Map(), [], 'filarr');
    }

    const body = fromBase64Url(res.head);
    // La clé de la tête : celle que nomme `hk` ; sans `hk` (serveur d'avant la précision 3.9), toutes
    let candidates: StoreKeys[];
    let named: KeyRef | null = null;
    if (res.hk && isNat(res.hk.e)) {
      named = { e: res.hk.e, g: isNat(res.hk.g) ? res.hk.g : 0 };
      const k = this.keys.get(keyId(named.e, named.g));
      if (!k) return this.keyMissing([named]);
      candidates = [k];
    } else {
      // `hk: null` : une tête d'un rédacteur d'avant la précision 3.9, donc de génération 0 ; l'époque s'essaie
      // comme avant, la plus récente d'abord (contrat api-base-1 § 5, précisions du worker)
      candidates = [...this.keys.values()].filter((k) => k.generation === 0).sort((a, b) => b.epoch - a.epoch);
    }
    let head: StoreHead | null = null;
    let headKeys: StoreKeys | null = null;
    let lastError: unknown = null;
    for (const k of candidates) {
      try {
        head = await openHead(c, k, res.seq, body);
        headKeys = k;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!head || !headKeys) {
      if (named || candidates.length === 0) {
        if (!named) return this.keyMissing([]);
        this.setProblem('unverified', {
          code: 'head_unverified',
          message: `tête illisible : ${(lastError as Error | null)?.message ?? 'aucune clé'}`,
        });
        return null;
      }
      // Sans `hk`, aucune clé détenue n'ouvre la tête : le plus probable est une génération pas encore rescellée
      return this.keyMissing([]);
    }

    // Chaque bloc de la tête demande SA clé : aucune ne doit manquer
    const missing = new Map<string, KeyRef>();
    for (const entry of Object.values(head.slots)) {
      const g = entryGen(entry);
      if (!this.keys.has(keyId(entry.e, g))) missing.set(keyId(entry.e, g), { e: entry.e, g });
    }
    if (missing.size > 0) return this.keyMissing([...missing.values()]);

    const macKey = headKeyBytes(head).mac;
    const fresh = new Map<string, MirrorSlot>();
    const fetchedBodies: Array<{ p: string; ver: number; body: Uint8Array }> = [];
    const open = async (p: string, entry: SlotEntry, slotBody: Uint8Array): Promise<boolean> => {
      if (!(await verifySlot(c, macKey, entry, slotBody))) return false;
      const keys = this.keys.get(keyId(entry.e, entryGen(entry)))!;
      const plain = await openSlot(c, keys, p, entry.ver, slotBody);
      fresh.set(p, { ver: entry.ver, e: entry.e, g: entryGen(entry), mac: entry.mac, rows: plain.rows, bytes: slotBody.length });
      return true;
    };

    let wanted = Object.entries(head.slots).filter(([p, entry]) => {
      const have = this.slots.get(p);
      return !have || have.ver !== entry.ver || have.mac !== entry.mac;
    });
    // Le cache local d'abord : un corps faux ou illisible y est oublié, puis redemandé
    const fromNetwork: Array<[string, SlotEntry]> = [];
    for (const [p, entry] of wanted) {
      const cached = await this.deps.cache.get(this.storeId, p, entry.ver);
      let ok = false;
      if (cached) {
        try {
          ok = await open(p, entry, cached);
        } catch {
          ok = false;
        }
      }
      if (!ok) fromNetwork.push([p, entry]);
    }
    wanted = fromNetwork;

    if (wanted.length > 0) {
      const bodies = await this.batchGet(wanted.map(([p, e]) => ({ p, ver: e.ver })));
      for (const [p, entry] of wanted) {
        const slotBody = bodies.get(refOf(p, entry.ver));
        if (slotBody === undefined || slotBody === null) {
          // Version ramassée ou inconnue : la tête a bougé entre-temps, on la relit une fois
          if (depth === 0) return this.syncNow(true, 1);
          this.setProblem('unverified', { code: 'slot_missing', message: `bloc ${urlPrefix(p)} v${entry.ver} introuvable` });
          return null;
        }
        let ok = false;
        try {
          ok = await open(p, entry, slotBody);
        } catch (err) {
          this.setProblem('unverified', {
            code: 'slot_unreadable',
            message: `bloc ${urlPrefix(p)} v${entry.ver} illisible : ${(err as Error).message}`,
          });
          return null;
        }
        if (!ok) {
          this.setProblem('unverified', {
            code: 'slot_substituted',
            message: `bloc ${urlPrefix(p)} v${entry.ver} substitué : empreinte fausse`,
          });
          return null;
        }
        fetchedBodies.push({ p, ver: entry.ver, body: slotBody });
      }
    }

    const next = new Map<string, MirrorSlot>();
    for (const [p, entry] of Object.entries(head.slots)) {
      const slot = fresh.get(p) ?? this.slots.get(p);
      if (!slot || slot.ver !== entry.ver) {
        this.setProblem('unverified', { code: 'slot_missing', message: `bloc ${urlPrefix(p)} manquant` });
        return null;
      }
      next.set(p, slot);
    }
    const hk: KeyRef = { e: headKeys.epoch, g: headKeys.generation };
    return this.install(res.seq, head, hk, next, fetchedBodies, 'filarr');
  }

  private keyMissing(keys: KeyRef[]): null {
    const what = keys.length > 0 ? keys.map((k) => `(${k.e}, ${k.g})`).join(', ') : 'la tête';
    this.setProblem('missing_key', {
      code: 'key_missing',
      message: `clé manquante pour ${what}`,
      keys,
    });
    return null;
  }

  /** `slots:batchGet`, relancé tant que le serveur dit `more`. */
  private async batchGet(refs: Array<{ p: string; ver: number }>): Promise<Map<string, Uint8Array | null>> {
    const out = new Map<string, Uint8Array | null>();
    let rest = refs;
    for (let round = 0; rest.length > 0 && round < 10_000; round += 1) {
      const res = await this.deps.client.json<{
        slots?: Array<{ p: string; ver: number; body?: string; missing?: boolean }>;
        more?: boolean;
      }>('POST', `dbstore/${this.storeId}/slots:batchGet`, { slots: rest, maxBytes: BATCH_MAX_BYTES });
      const got = Array.isArray(res.slots) ? res.slots : [];
      for (const s of got) {
        if (typeof s.p !== 'string' || !isNat(s.ver)) continue;
        out.set(refOf(s.p, s.ver), s.missing || typeof s.body !== 'string' ? null : fromBase64Url(s.body));
      }
      rest = rest.filter((r) => !out.has(refOf(r.p, r.ver)));
      if (!res.more || got.length === 0) break;
    }
    return out;
  }

  /** Installe un état complet et vérifié ; rend les lignes changées. */
  private install(
    seq: number,
    head: StoreHead | null,
    hk: KeyRef | null,
    slots: Map<string, MirrorSlot>,
    newBodies: Array<{ p: string; ver: number; body: Uint8Array }>,
    origin: 'filarr' | 'gate'
  ): RowDiff {
    const before = this.byId;
    const changedPrefixes = new Set<string>();
    for (const [p, slot] of slots) {
      const old = this.slots.get(p);
      if (!old || old.ver !== slot.ver || old.mac !== slot.mac) changedPrefixes.add(p);
    }
    for (const p of this.slots.keys()) if (!slots.has(p)) changedPrefixes.add(p);
    // Les lignes à comparer : celles des blocs changés, avant et après (une division les déplace sans les changer)
    const touched = new Set<string>();
    const firstLoad = this.head === null;
    for (const p of changedPrefixes) {
      for (const id of Object.keys(this.slots.get(p)?.rows ?? {})) touched.add(id);
      for (const id of Object.keys(slots.get(p)?.rows ?? {})) touched.add(id);
    }

    const registers: StoreRows = {};
    let latest = '';
    for (const slot of slots.values()) {
      for (const [id, regs] of Object.entries(slot.rows)) {
        const existing = ownRow(registers, id);
        registers[id] = existing ? mergeRow(existing, regs) : regs;
        for (const reg of Object.values(regs)) if (reg.t > latest) latest = reg.t;
      }
    }
    if (latest) this.clock.observe(latest);
    if (head) this.clock.observe(head.schema.t);
    this.registers = registers;
    this.slots = slots;
    this.head = head;
    this.hk = hk;
    this.seq = seq;
    this.rows = materializeRows(registers);
    this.byId = new Map(this.rows.map((r) => [r.id, r]));
    this.lastSyncAt = new Date().toISOString();
    this.setProblem('ready', null);

    const diff: RowDiff = { storeId: this.storeId, seq, origin, created: [], updated: [], deleted: [] };
    if (!firstLoad) {
      for (const id of touched) {
        const was = before.get(id);
        const now = this.byId.get(id);
        if (!was && now) diff.created.push(now);
        else if (was && !now) diff.deleted.push(was);
        else if (was && now && canonicalJson(was) !== canonicalJson(now)) diff.updated.push({ before: was, after: now });
      }
    }
    for (const r of [...diff.created, ...diff.deleted]) this.rowSeq.set(r.id, seq);
    for (const u of diff.updated) this.rowSeq.set(u.after.id, seq);
    if (firstLoad) for (const r of this.rows) this.rowSeq.set(r.id, seq);

    // Le cache suit l'état installé : les corps neufs, puis l'oubli de ce que la tête ne désigne plus
    const cache = this.deps.cache;
    const keep = new Set([...slots].map(([p, s]) => refOf(p, s.ver)));
    void (async () => {
      for (const b of newBodies) await cache.put(this.storeId, b.p, b.ver, b.body).catch(() => undefined);
      await cache.prune(this.storeId, keep).catch(() => undefined);
    })();
    return diff;
  }

  /** Oublie tout ce que ce miroir tient en clair (droit retiré, révocation). */
  wipe(): void {
    this.registers = {};
    this.rows = [];
    this.byId = new Map();
    this.slots = new Map();
    this.head = null;
    this.rowSeq.clear();
    for (const k of this.keys.values()) {
      k.kDb.fill(0);
      k.kHead.fill(0);
    }
    this.keys = new Map();
  }

  // ==================== Écriture (§ 7) ====================

  /** Une heure neuve de l'horloge de cette boîte noire. */
  tick(): string {
    return this.clock.tick();
  }

  /** La clé d'écriture : `K_db(e courante, g courante)`. */
  writeKeys(): StoreKeys {
    const head = this.head;
    if (!head) throw new WriteRefusedError('store_empty', 'Cette base n’a pas encore de tête : elle s’écrit d’abord depuis Filarr.');
    const g = this.generation;
    const newestEpoch = Math.max(
      0,
      ...(Array.isArray(head.epochs) ? head.epochs.filter(isNat) : []),
      ...Object.values(head.slots).map((s) => s.e)
    );
    const held = [...this.keys.values()].filter((k) => k.generation === g);
    const best = held.reduce<StoreKeys | null>((a, k) => (!a || k.epoch > a.epoch ? k : a), null);
    if (!best || best.epoch < newestEpoch) throw new KeyMissingError([{ e: newestEpoch, g }]);
    return best;
  }

  /**
   * Valide des écritures (déjà horodatées) : compare-and-swap, et sur un conflit
   * (`seq_conflict`, `stale_generation`, `slot_version`) relecture, rescellement,
   * nouvel essai.
   */
  commit(ops: readonly StoreOp[], maxRetries = 6): Promise<{ seq: number; diff: RowDiff }> {
    return this.serial(async () => {
      if (this.status !== 'ready') await this.syncNow(true, 0);
      let lastCode = 'unknown';
      for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        if (this.status === 'missing_key') throw new KeyMissingError(this.problem?.keys ?? []);
        if (this.status !== 'ready') {
          throw new WriteRefusedError(this.problem?.code ?? 'not_ready', this.problem?.message ?? 'base indisponible', 503);
        }
        const keys = this.writeKeys();
        const result = await this.tryCommit(ops, keys);
        if (result.ok) return { seq: result.seq, diff: result.diff };
        lastCode = result.code;
        if (['seq_conflict', 'stale_generation', 'slot_version', 'bad_cover', 'stage_unknown'].includes(result.code)) {
          if (result.code === 'stale_generation' && isNat(result.g)) this.generation = result.g;
          await this.syncNow(true, 0);
          continue;
        }
        throw new WriteRefusedError(result.code, `Filarr a refusé la validation (${result.code})`, result.status ?? 409);
      }
      throw new WriteRefusedError('too_many_conflicts', `trop de conflits successifs (${lastCode})`);
    });
  }

  private async tryCommit(
    ops: readonly StoreOp[],
    keys: StoreKeys
  ): Promise<
    { ok: true; seq: number; diff: RowDiff } | { ok: false; code: string; g?: number; status?: number }
  > {
    const base = this.head!;
    const { mac: macKey, place: placeKey } = headKeyBytes(base);
    const cover = new Set(Object.keys(base.slots));
    const byPrefix = new Map<string, StoreOp[]>();
    for (const op of ops) {
      const p = prefixFor(await placeHash(c, placeKey, op.r), cover);
      const list = byPrefix.get(p);
      if (list) list.push(op);
      else byPrefix.set(p, [op]);
    }

    const laid: LaidSlot[] = [];
    const removed: string[] = [];
    const index: Record<string, SlotEntry> = { ...base.slots };
    for (const [p, slotOps] of byPrefix) {
      const current = this.slots.get(p);
      if (!current) throw new StoreIntegrityError(`bloc ${urlPrefix(p)} absent de l’état`);
      const rows: StoreRows = { ...current.rows };
      for (const op of slotOps) {
        const row = ownRow(rows, op.r);
        if (row !== undefined && row === ownRow(current.rows, op.r)) rows[op.r] = { ...row };
        applyOp(rows, op);
      }
      const hashes = new Map<string, Uint8Array>();
      for (const id of Object.keys(rows)) hashes.set(id, await placeHash(c, placeKey, id));
      const out = await layoutSlot(c, keys, p, current.ver + 1, rows, hashes);
      delete index[p];
      if (!out.some((s) => s.p === p)) removed.push(p);
      for (const slot of out) {
        index[slot.p] = {
          e: keys.epoch,
          mac: await slotMac(c, macKey, slot.body),
          ver: slot.ver,
          ...(keys.generation > 0 ? { g: keys.generation } : {}),
        } as SlotEntry;
        laid.push(slot);
      }
    }
    if (!isCover(Object.keys(index))) throw new StoreIntegrityError('les blocs écrits ne recouvrent plus l’espace');

    const laidByPrefix = new Map(laid.map((s) => [s.p, s] as const));
    const zoneInputs: Array<readonly [string, { ver: number; rows: StoreRows }]> = [];
    for (const [p, entry] of Object.entries(index)) {
      const rows = laidByPrefix.get(p)?.rows ?? this.slots.get(p)?.rows;
      if (rows) zoneInputs.push([p, { ver: entry.ver, rows }] as const);
    }
    const zones =
      zoneInputs.length === Object.keys(index).length
        ? headZones(zoneInputs, base.schema.properties, this.zoneCache)
        : undefined;
    const epochs = [...new Set(Object.values(index).map((e) => e.e))].sort((a, b) => a - b);
    const head: StoreHead = {
      v: 1,
      dbId: base.dbId,
      keys: base.keys,
      schema: base.schema,
      slots: index,
      root: await merkleRoot(c, macKey, index),
      epochs,
      updated: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
      ...(zones ? { zones } : {}),
    };
    const sealedSeq = this.seq + 1;
    const headBody = await sealHead(c, keys, sealedSeq, head);

    let seq: number;
    try {
      // Les corps : en ligne tant que le budget tient, sinon par dépôt (un refus du dépôt est un refus de la validation)
      let budget = INLINE_BUDGET;
      const slots: Array<Record<string, unknown>> = [];
      for (const slot of laid) {
        const common = { p: slot.p, ver: slot.ver, e: keys.epoch, g: keys.generation };
        if (slot.body.length <= INLINE_MAX && slot.body.length <= budget) {
          budget -= slot.body.length;
          slots.push({ ...common, body: toBase64Url(slot.body) });
        } else {
          const staged = await this.deps.client.putBytes<{ token: string }>(`dbstore/${this.storeId}/stage`, slot.body);
          slots.push({ ...common, stage: staged.token });
        }
      }
      const res = await this.deps.client.json<{ seq: number }>('POST', `dbstore/${this.storeId}/commit`, {
        baseSeq: this.seq,
        slots,
        removed,
        head: toBase64Url(headBody),
        hk: { e: keys.epoch, g: keys.generation },
      });
      seq = res.seq;
    } catch (err) {
      if (err instanceof FilarrError && (err.status === 409 || err.status === 422 || err.status === 413 || err.status === 403)) {
        const g = err.body.g;
        return { ok: false, code: err.code, ...(isNat(g) ? { g } : {}), status: err.status };
      }
      throw err;
    }

    const next = new Map(this.slots);
    for (const p of byPrefix.keys()) next.delete(p);
    for (const slot of laid) {
      const entry = index[slot.p]!;
      next.set(slot.p, { ver: slot.ver, e: entry.e, g: keys.generation, mac: entry.mac, rows: slot.rows, bytes: slot.body.length });
    }
    this.generation = keys.generation;
    const diff = this.install(
      seq,
      head,
      { e: keys.epoch, g: keys.generation },
      next,
      laid.map((s) => ({ p: s.p, ver: s.ver, body: s.body })),
      'gate'
    );
    // Une tête ne se rouvre que sous le seq de son AAD : un serveur qui rend un autre seq impose une relecture
    if (seq !== sealedSeq) this.status = 'loading';
    return { ok: true, seq, diff };
  }
}
