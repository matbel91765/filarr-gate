/**
 * Ce que la documentation lit dans le CODE (jamais tapé à la main) : les codes que l'API locale
 * peut rendre et leurs statuts HTTP, les états de la liaison, les états des synchros, les codes
 * de Filarr des vecteurs de la révision 3, et les variables d'environnement que le code connaît.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Chaque fichier `.ts` / `.tsx` sous un dossier (ni `dist`, ni `node_modules`). */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const read = (p: string): string => readFileSync(p, 'utf8');

/** `code → statuts` de chaque `new ApiError(<statut>, '<code>'` et refus de clé de la bibliothèque et du serveur. */
export function localApiCodes(): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const add = (code: string, status: number) => {
    if (!out.has(code)) out.set(code, new Set());
    out.get(code)!.add(status);
  };
  const files = [...sourceFiles(join(ROOT, 'packages', 'gate', 'src')), ...sourceFiles(join(ROOT, 'packages', 'server', 'src'))];
  for (const f of files) {
    const text = read(f);
    for (const m of text.matchAll(/new ApiError\(\s*(\d{3}),\s*'([a-z0-9_]+)'/g)) add(m[2]!, Number(m[1]));
    for (const m of text.matchAll(/status: (\d{3}), code: '([a-z0-9_]+)'/g)) add(m[2]!, Number(m[1]));
    for (const m of text.matchAll(/json\((\d{3}), \{ error: [^}]*code: '([a-z0-9_]+)' \}\)/g)) add(m[2]!, Number(m[1]));
  }
  // Les refus de champ (`FieldError`) sortent en 400 avec leur propre code (`toApiError`)
  const fields = read(join(ROOT, 'packages', 'gate', 'src', 'data', 'fields.ts'));
  const union = /readonly code: ([^,]+),/.exec(fields)?.[1] ?? '';
  for (const m of union.matchAll(/'([a-z_]+)'/g)) add(m[1]!, 400);
  // Les refus d'un réveil poussé : `notify_<verdict>`, les verdicts de `verifyNotify`
  const access3 = read(join(ROOT, 'packages', 'core', 'src', 'engine', 'gate', 'access3.ts'));
  const verdicts = /export type NotifyVerdict = ([^;]+);/.exec(access3)?.[1] ?? '';
  for (const m of verdicts.matchAll(/'([a-z_]+)'/g)) if (m[1] !== 'ok') add(`notify_${m[1]}`, 401);
  add('notify_malformed', 400);
  return out;
}

/** Les états de la liaison (`LinkState` des types publics de la bibliothèque). */
export function linkStates(): string[] {
  const text = read(join(ROOT, 'packages', 'gate', 'src', 'types.ts'));
  const block = /export type LinkState =([\s\S]*?);/.exec(text)?.[1] ?? '';
  return [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

/** Les codes de problème d'une base qu'un `503` peut porter (`setProblem`, `markUnavailable`, `keyMissing`, `base_loading`). */
export function baseProblemCodes(): string[] {
  const out = new Set<string>(['base_loading']);
  for (const f of ['store.ts', 'replicator.ts']) {
    const text = read(join(ROOT, 'packages', 'gate', 'src', 'replica', f));
    for (const m of text.matchAll(/(?:setProblem|markUnavailable)\('[a-z_]+', \{ code: '([a-z_]+)'/g)) out.add(m[1]!);
    for (const m of text.matchAll(/code: '([a-z_]+)',\s*\n\s*message:/g)) out.add(m[1]!);
  }
  return [...out].sort();
}

/** Chaque code d'état `extdb_*` que le cœur et le serveur peuvent publier. */
export function syncCodes(): string[] {
  const out = new Set<string>();
  const files = [...sourceFiles(join(ROOT, 'packages', 'server', 'src', 'sync')), ...sourceFiles(join(ROOT, 'packages', 'core', 'src', 'engine', 'extsrc'))];
  for (const f of files) for (const m of read(f).matchAll(/'(extdb_[a-z_]+)'/g)) out.add(m[1]!);
  return [...out].sort();
}

export interface VectorCode {
  code: string;
  status: number;
  remedy: string[] | 'by-reason' | null;
  retryAfter: boolean;
}

/** Les codes de la révision 3 du worker, tels que les vecteurs `boite-noire-v2-serveur` les donnent. */
export function vectorCodes(): { rows: VectorCode[]; asleep: Record<string, string[] | null> } {
  const v = JSON.parse(read(join(ROOT, 'test', 'vectors', 'boite-noire-v2-serveur.vectors.json'))) as {
    codes: { rows: VectorCode[]; asleepRemedyByReason: Record<string, string[] | null> };
  };
  return { rows: v.codes.rows, asleep: v.codes.asleepRemedyByReason };
}

/** Chaque nom `FILARR_GATE_*` que le code connaît (avec `FILARR_GATE_EXTDB_<ID>` en motif). */
export function knownEnvNames(): Set<string> {
  const out = new Set<string>();
  for (const dir of ['cli', 'server', 'cloudflare', 'gate']) {
    for (const f of sourceFiles(join(ROOT, 'packages', dir, 'src'))) for (const m of read(f).matchAll(/FILARR_GATE_[A-Z0-9_]+/g)) out.add(m[0]);
  }
  for (const f of ['Dockerfile', 'scripts/mock-filarr.ts']) for (const m of read(join(ROOT, f)).matchAll(/FILARR_GATE_[A-Z0-9_]+/g)) out.add(m[0]);
  out.add('FILARR_GATE_EXTDB_<ID>');
  return out;
}

/** Un chemin relatif au dépôt, avec des barres obliques. */
export const rel = (p: string): string => relative(ROOT, p).split('\\').join('/');
