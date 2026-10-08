/**
 * Cale de plateforme : le stockage par profil de l'application (localStorage du
 * renderer) n'existe pas dans la boîte noire. Le cœur n'y range que des
 * préférences d'affichage (onglet actif, clé TMDB) ; ici elles vivent en mémoire.
 */

const memory = new Map<string, string>();

export function getItem(key: string): string | null {
  return memory.get(key) ?? null;
}

export function getItemWithLegacyFallback(key: string): string | null {
  return getItem(key);
}

export function setItem(key: string, value: string): void {
  memory.set(key, value);
}

export function removeItem(key: string): void {
  memory.delete(key);
}
