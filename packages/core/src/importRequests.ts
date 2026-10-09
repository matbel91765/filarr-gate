// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/importRequests.ts @ 8d960938 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Demandes d'import en attente, par identité de base.
 *
 * « Base depuis une note… » (menu « / ») insère un bloc NEUF puis doit ouvrir le
 * panneau d'import DANS ce bloc. La commande d'insertion ne voit pas la vue
 * React qui naîtra de son contenu : elle dépose une demande ici, sous l'identité
 * qu'elle vient de frapper, et la vue du nœud la reprend à son montage.
 *
 * Mémoire LOCALE et éphémère : rien n'entre dans le document (une demande est un
 * geste, pas un réglage). Une demande non reprise meurt avec la session.
 */

export type ImportRequestKind = 'note' | 'paste' | 'file';

const pending = new Map<string, ImportRequestKind>();

export function requestImportOnMount(dbId: string, kind: ImportRequestKind): void {
  if (dbId !== '') pending.set(dbId, kind);
}

/** Reprend (et efface) la demande d'une base ; `null` s'il n'y en a pas. */
export function takeImportRequest(dbId: string): ImportRequestKind | null {
  const kind = pending.get(dbId);
  if (kind === undefined) return null;
  pending.delete(dbId);
  return kind;
}

/**
 * Bases NEUVES de cette session : le bandeau « Par où commencer ? » ne se montre
 * que là. Une base laissée vide il y a trois semaines n'a pas à le reproposer à
 * chaque ouverture de la note — on sait où sont « Importer » et les modèles.
 */
const fresh = new Set<string>();

export function markFreshDb(dbId: string): void {
  if (dbId !== '') fresh.add(dbId);
}

export function isFreshDb(dbId: string): boolean {
  return fresh.has(dbId);
}

export function forgetFreshDb(dbId: string): void {
  fresh.delete(dbId);
}
