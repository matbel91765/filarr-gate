/**
 * LA SEULE SORTIE DE CONSOLE DU SERVICE — contrat `gate-heberge-1` § 10.3.
 *
 * Aucune trace n'est gardée par Cloudflare pour ce script (ni Workers Logs, ni Logpush, ni
 * consommateur de traces : `wrangler.jsonc`, garde de test) ; une console ne sert qu'à qui
 * regarde en direct (`wrangler tail`). Même là, rien qui reprenne une requête, une réponse, une
 * ligne, un nom de fichier, une adresse de webhook ou de base externe, un identifiant : un CODE
 * d'erreur de cette liste fermée, et rien d'autre. Une garde de test refuse tout autre `console.*`
 * dans `packages/host/src`.
 */

export const OPS_CODES = [
  'host_key_missing',
  'box_open_failed',
  'state_unreadable',
  'receipt_failed',
  'export_failed',
  'usage_failed',
  'announce_failed',
  'directory_failed',
  'erase_failed',
] as const;

export type OpsCode = (typeof OPS_CODES)[number];

export function opsError(code: OpsCode): void {
  console.error(`filarr-gate-host ${code}`);
}
