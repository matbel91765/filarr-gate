// Écrit dans filarr-gate (origine) — cœur pur, à recopier tel quel par filarg (lot B2).
/**
 * Types et conversions — contrat `source-externe-1` § 4.
 *
 * On compare TOUJOURS dans le domaine de Filarr : `toFilarr(valeur source)`
 * contre la valeur du registre. `toSource` rend la valeur à écrire, dans une
 * forme que chaque connecteur pose dans son type de colonne. L'aller-retour
 * `toFilarr(toSource(v)) = v` tient pour toute valeur admise (aux arrondis près,
 * qui sont de l'écho, § 6.5).
 */

import { codeUnitOrder } from '../store/canonical';
import { toBase64Url, utf8Encode } from '../store/crypto';
import type { Sha256 } from './identity';

export interface OptionSpec {
  id: string;
  label: string;
  [extra: string]: unknown;
}

export interface PropSpec {
  id: string;
  type: string;
  options?: OptionSpec[];
}

/** Options créées pendant la conversion (libellé inconnu, `createOptions`). */
export interface OptionMint {
  propId: string;
  option: OptionSpec;
}

export interface ConvertOptions {
  /** Créer une option pour un libellé inconnu (vrai d'office en `mirror` et `both`). */
  createOptions: boolean;
  /** Les options créées s'ajoutent ici (le schéma sera réécrit avec elles). */
  minted?: OptionMint[];
  sha256: Sha256;
}

/** L'identifiant d'une option créée par une synchro : déterministe (deux exécutants créent la même). */
export function mintedOptionId(sha256: Sha256, propId: string, label: string): string {
  return `ext-opt-${toBase64Url(sha256(utf8Encode(`filarr/extsrc/v1|opt|${propId}|${label}`)).slice(0, 9))}`;
}

const TEXT = new Set(['text', 'url', 'email', 'phone', 'note']);
const NUMBER = new Set(['number', 'rating', 'progress']);

/** Un horodatage en ISO 8601 UTC (`Z`), millisecondes seulement si non nulles ; `null` si illisible. */
export function isoUtc(value: unknown): string | null {
  let d: Date;
  if (value instanceof Date) d = value;
  else if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return null;
    const v = value.replace(' ', 'T');
    d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`);
  } else return null;
  if (!Number.isFinite(d.getTime())) return null;
  const iso = d.toISOString();
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso;
}

const boolOf = (raw: unknown): boolean => {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'bigint') return raw !== 0n;
  if (typeof raw === 'string') return /^(1|true|t|yes|y|oui|vrai|x|✓)$/i.test(raw.trim());
  return false;
};

/** Une valeur de la source dans le domaine de Filarr (§ 4). */
export function toFilarr(raw: unknown, prop: PropSpec, opts: ConvertOptions): unknown {
  const t = prop.type;
  if (TEXT.has(t)) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number' || typeof raw === 'bigint' || typeof raw === 'boolean') return String(raw);
    if (raw instanceof Date) return isoUtc(raw);
    return canonicalText(raw);
  }
  if (NUMBER.has(t)) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'bigint') return raw >= -9007199254740991n && raw <= 9007199254740991n ? Number(raw) : null;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim().replace(',', '.')) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  if (t === 'checkbox') return boolOf(raw);
  if (t === 'date' || t === 'createdTime' || t === 'updatedTime') {
    if (raw === null || raw === undefined || raw === '') return null;
    return isoUtc(raw);
  }
  if (t === 'select') {
    if (raw === null || raw === undefined || raw === '') return null;
    const label = String(raw);
    return optionId(prop, label, opts);
  }
  if (t === 'multiSelect') {
    const labels = Array.isArray(raw)
      ? raw.map(String)
      : typeof raw === 'string' && raw !== ''
        ? raw.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    const ids = labels.map((l) => optionId(prop, l, opts)).filter((x): x is string => x !== null);
    return [...new Set(ids)].sort(codeUnitOrder);
  }
  if (t === 'person') {
    if (raw === null || raw === undefined || raw === '') return [];
    return Array.isArray(raw) ? raw.map(String) : [String(raw)];
  }
  if (t === 'relation') {
    if (raw === null || raw === undefined || raw === '') return [];
    return Array.isArray(raw) ? raw.map(String) : [String(raw)];
  }
  return raw === undefined ? null : raw;
}

function optionId(prop: PropSpec, label: string, opts: ConvertOptions): string | null {
  const found = prop.options?.find((o) => o.label === label);
  if (found) return found.id;
  const minted = opts.minted?.find((m) => m.propId === prop.id && m.option.label === label);
  if (minted) return minted.option.id;
  if (!opts.createOptions) return null;
  const option: OptionSpec = { id: mintedOptionId(opts.sha256, prop.id, label), label };
  opts.minted?.push({ propId: prop.id, option });
  return option.id;
}

/** Un JSON (`json`, `jsonb`) en texte : le JSON canonique. */
function canonicalText(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => codeUnitOrder(a, b))
          .map(([k, x]) => [k, sort(x)])
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * Une valeur de Filarr à écrire dans la source (§ 4) : texte, nombre, booléen
 * (jamais `null`), date en chaîne, libellé d'option, libellés dans l'ordre des
 * options du schéma. Le connecteur la pose dans son type de colonne.
 */
export function toSource(value: unknown, prop: PropSpec): unknown {
  const t = prop.type;
  if (t === 'checkbox') return value === true;
  if (value === null || value === undefined) return null;
  if (t === 'select') return prop.options?.find((o) => o.id === value)?.label ?? null;
  if (t === 'multiSelect') {
    const ids = Array.isArray(value) ? value.map(String) : [];
    return (prop.options ?? []).filter((o) => ids.includes(o.id)).map((o) => o.label);
  }
  if (NUMBER.has(t)) return typeof value === 'number' && Number.isFinite(value) ? value : null;
  return value;
}
