/**
 * Les langues de l'interface : le français, d'office, et l'anglais.
 *
 * La clé d'un texte EST son texte français (celui de la maquette) : un écran se
 * lit tel quel. `en.ts` en donne la traduction ; un essai vérifie qu'aucun texte
 * ne manque. Les variables s'écrivent `{nom}`.
 */

import { signal } from '@preact/signals';
import { EN } from './en';

export type Lang = 'fr' | 'en';

function initial(): Lang {
  try {
    const saved = localStorage.getItem('filarr-gate-lang');
    if (saved === 'fr' || saved === 'en') return saved;
  } catch {
    /* stockage indisponible */
  }
  return 'fr';
}

export const lang = signal<Lang>(initial());

export function setLang(next: Lang): void {
  lang.value = next;
  document.documentElement.lang = next;
  try {
    localStorage.setItem('filarr-gate-lang', next);
  } catch {
    /* stockage indisponible */
  }
}

/** Marque un texte traduit plus loin par `t(variable)` (pour l'essai des traductions). */
export const tr = (fr: string): string => fr;

export function t(fr: string, vars?: Record<string, string | number>): string {
  const text = lang.value === 'en' ? (EN[fr] ?? fr) : fr;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (vars[name] === undefined ? whole : String(vars[name])));
}

/** Pluriel simple : `plural(n, 'ligne', 'lignes')`, les deux formes passant par `t`. */
export function plural(n: number, one: string, many: string): string {
  return t(Math.abs(n) >= 2 ? many : one, { n: fmtNumber(n) });
}

const locale = () => (lang.value === 'en' ? 'en-GB' : 'fr-FR');

export function fmtNumber(n: number | null | undefined, digits?: number): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(locale(), digits === undefined ? {} : { maximumFractionDigits: digits }).format(n);
}

/** Octets en Kio, Mio, Gio (écrits « Ko, Mo, Go » en français, comme la maquette). */
export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const units = lang.value === 'en' ? ['B', 'KB', 'MB', 'GB', 'TB'] : ['o', 'Ko', 'Mo', 'Go', 'To'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${fmtNumber(v, v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale(), withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(d);
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** « il y a 4 s », « hier, 18:02 »… */
export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const s = Math.round((Date.now() - then) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  if (Math.abs(s) < 60) return rtf.format(-s, 'second');
  if (Math.abs(s) < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (Math.abs(s) < 86_400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (Math.abs(s) < 7 * 86_400) return rtf.format(-Math.round(s / 86_400), 'day');
  return fmtDate(iso);
}

/** « 212 k / 1 M » : les compteurs du tableau de bord. */
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}
