/**
 * Cale de plateforme : le trousseau de l'application (secrets de connecteurs)
 * n'existe pas dans la boîte noire. Aucun secret n'y est jamais trouvé.
 */

export function cachedSecret(_service: string): string | null {
  return null;
}
