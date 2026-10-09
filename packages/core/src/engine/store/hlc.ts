// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/store/hlc.ts @ 9b0ca853 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Horloge logique hybride (HLC) du magasin des bases — contrat `db-store-1`, § 4.
 *
 * Une heure s'écrit `<ms:12 hex>-<compteur:4 hex>-<siteId:8 hex>`. Toutes ont la
 * même largeur : l'ORDRE DES CHAÎNES est l'ordre chronologique, sans rien
 * analyser. Le `siteId` (tiré une fois par appareil et par profil) départage
 * deux écritures de la même milliseconde : deux horloges ne sont jamais égales.
 *
 * Elle avance sur le temps physique quand il dépasse la dernière heure vue ;
 * sinon, sur la même milliseconde, par le compteur. Toute heure REÇUE fait
 * avancer la nôtre : une écriture faite après avoir lu celle d'un autre passe
 * toujours après elle, même si les horloges des deux appareils diffèrent.
 */

export const SITE_RE = /^[0-9a-f]{8}$/;
const HLC_RE = /^([0-9a-f]{12})-([0-9a-f]{4})-([0-9a-f]{8})$/;
const MAX_COUNTER = 0xffff;
/** Une heure reçue plus en avance que cela sur l'horloge physique est journalisée (§ 4). */
export const HLC_FAR_AHEAD_MS = 24 * 3600 * 1000;

export interface HlcParts {
  ms: number;
  counter: number;
  site: string;
}

export function formatHlc(ms: number, counter: number, site: string): string {
  if (!SITE_RE.test(site)) throw new Error(`siteId invalide : ${site}`);
  if (!Number.isInteger(ms) || ms < 0 || ms > 0xffffffffffff)
    throw new Error(`heure invalide : ${ms}`);
  if (!Number.isInteger(counter) || counter < 0 || counter > MAX_COUNTER) {
    throw new Error(`compteur invalide : ${counter}`);
  }
  return `${ms.toString(16).padStart(12, '0')}-${counter.toString(16).padStart(4, '0')}-${site}`;
}

export function parseHlc(hlc: string): HlcParts | null {
  const m = HLC_RE.exec(hlc);
  if (!m) return null;
  return { ms: parseInt(m[1]!, 16), counter: parseInt(m[2]!, 16), site: m[3]! };
}

export const isHlc = (value: unknown): value is string =>
  typeof value === 'string' && HLC_RE.test(value);

/** L'heure d'une écriture en ISO (pour `updatedAt`), à la milliseconde. */
export function hlcToIso(hlc: string): string | null {
  const parts = parseHlc(hlc);
  return parts ? new Date(parts.ms).toISOString() : null;
}

export class HlcClock {
  private ms = 0;
  private counter = 0;

  constructor(
    readonly site: string,
    private readonly now: () => number = Date.now
  ) {
    if (!SITE_RE.test(site)) throw new Error(`siteId invalide : ${site}`);
  }

  /** Une heure neuve, strictement après toutes celles qu'on a émises ou vues. */
  tick(): string {
    const physical = Math.floor(this.now());
    if (physical > this.ms) {
      this.ms = physical;
      this.counter = 0;
    } else if (this.counter < MAX_COUNTER) {
      this.counter += 1;
    } else {
      // Le compteur est plein : on emprunte la milliseconde suivante
      this.ms += 1;
      this.counter = 0;
    }
    return formatHlc(this.ms, this.counter, this.site);
  }

  /**
   * Une heure reçue d'ailleurs fait avancer la nôtre. Elle est ACCEPTÉE même
   * très en avance (sinon les appareils divergeraient) ; vrai si elle dépasse
   * l'heure physique de plus de 24 h — à journaliser dans le diagnostic (§ 4).
   */
  observe(hlc: string): boolean {
    const parts = parseHlc(hlc);
    if (!parts) return false;
    if (parts.ms > this.ms || (parts.ms === this.ms && parts.counter > this.counter)) {
      this.ms = parts.ms;
      this.counter = parts.counter;
    }
    return parts.ms - this.now() > HLC_FAR_AHEAD_MS;
  }
}

/** Un `siteId` neuf (8 caractères hexadécimaux) à partir d'octets aléatoires. */
export function siteIdFrom(random4: Uint8Array): string {
  if (random4.length < 4) throw new Error('quatre octets aléatoires attendus');
  let out = '';
  for (let i = 0; i < 4; i += 1) out += random4[i]!.toString(16).padStart(2, '0');
  return out;
}
