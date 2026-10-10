/**
 * Les textes français des tables générées de `docs/troubleshooting.fr.md` : les codes de la
 * révision 3 (vecteurs `boite-noire-v2-serveur`) et les états de la liaison. Les LISTES viennent
 * du code et des vecteurs ; `npm run docs:check` échoue sur un code sans texte.
 */

import type { CodeText } from './codes';

export const FILARR_REV3_FR: Record<string, CodeText> = {
  reauth_required: { what: 'Confier une base à la boîte hébergée demande une preuve d’identité fraîche.', fix: 'Filarr la demande à l’écran (mot de passe, code de double authentification ou clé d’accès).' },
  reauth_failed: { what: 'La preuve d’identité est fausse.', fix: 'Recommencez ; après 10 essais en une heure, patientez.' },
  api_tier_hosted: { what: 'La boîte hébergée demande le palier Pro ou plus.', fix: 'Un palier supérieur, ou une boîte noire chez vous.' },
  hosting_forbidden: { what: 'L’organisation interdit les boîtes hébergées.', fix: 'Voyez avec un administrateur de l’organisation, ou installez la boîte chez vous.' },
  hosting_not_switched: { what: 'La boîte hébergée n’est pas encore ouverte pour ce compte.', fix: 'Rien à faire : elle s’ouvre compte par compte.' },
  consent_outdated: { what: 'Le texte de l’accord a changé depuis que vous l’avez accepté.', fix: 'Filarr remontre le nouveau texte ; acceptez-le pour garder la base confiée.' },
  host_key_unknown: { what: 'Votre appli Filarr ne connaît pas la clé actuelle du service hébergé.', fix: 'Mettez l’appli Filarr à jour.' },
  hosting_billing_unavailable: { what: 'Aucun abonnement Stripe ne peut porter l’option pour ce payeur.', fix: 'Gérez la facturation dans Filarr, ou facturez l’organisation.' },
  hosting_exists: { what: 'Cet accès est déjà hébergé.', fix: 'Rien ; pour changer l’endroit où il tourne, passez par la migration.' },
  consent_required: { what: 'Ajouter une base à un accès hébergé demande d’abord un accord pour cette base.', fix: 'Acceptez l’accord pour elle dans Filarr, puis ajoutez-la.' },
  hosting_not_found: { what: 'Cet accès n’est pas hébergé.', fix: 'Rien.' },
  migration_pending: { what: 'Une migration de cet accès est déjà en cours.', fix: 'Terminez-la ou abandonnez-la dans Filarr.' },
  migration_not_ready: { what: 'La nouvelle boîte n’a pas encore importé son paquet de réglages.', fix: 'Démarrez la nouvelle boîte avec son nouveau jeton, attendez l’import, puis basculez.' },
  hosting_too_large: { what: 'Les bases à confier sont trop lourdes pour une boîte hébergée.', fix: 'Confiez-en moins, ou installez la boîte chez vous.' },
  hosting_asleep: { what: 'La boîte hébergée est en sommeil (paiement, palier ou politique). Le remède dit ce qui la réveille.', fix: 'Voyez Réglages › Accès API dans Filarr.' },
  hosted_origin_required: { what: 'Le jeton d’une boîte hébergée a été présenté hors du service hébergé : il est refusé.', fix: 'Rien : c’est ce qui protège ce jeton.' },
  api_access_pending: { what: 'Une identité neuve, en attente d’une migration, a appelé autre chose que `self` ou son paquet.', fix: 'Terminez la migration dans Filarr.' },
  api_tier_files: { what: 'Recevoir des fichiers par l’API demande le palier Pro ou plus.', fix: 'Un palier supérieur.' },
  files_not_switched: { what: 'Les fichiers par l’API ne sont pas encore ouverts pour ce compte.', fix: 'Rien : ils s’ouvrent compte par compte.' },
  files_not_linked: { what: 'Aucune boîte de dépôt n’est liée à l’accès.', fix: 'Liez une boîte de dépôt dans Filarr.' },
  box_not_permanent: { what: 'La boîte liée n’est pas une boîte de dépôt permanente.', fix: 'Liez une boîte permanente (Filarr en crée une pour vous).' },
  box_not_found: { what: 'La boîte de dépôt liée n’existe plus.', fix: 'Liez-en une autre dans Filarr.' },
  deposit_not_found: { what: 'Filarr ne connaît pas ce dépôt.', fix: 'Vérifiez l’identifiant.' },
  box_full: { what: 'Trop de dépôts attendent d’être rangés dans la boîte.', fix: 'Ouvrez Filarr pour les ranger : attendre ne suffit pas.' },
  box_storage_full: { what: 'Les dépôts en attente prennent trop de place.', fix: 'Ouvrez Filarr pour les ranger.' },
  file_too_large: { what: 'Le fichier dépasse la taille que Filarr accepte (`limit`).', fix: 'Envoyez un fichier plus petit.' },
  api_quota_files: { what: 'Le compte a déposé ce mois-ci autant de fichiers que son palier le permet.', fix: 'Attendez le mois suivant (le 1er, en UTC).' },
  api_quota_file_bytes: { what: 'Le compte a déposé ce mois-ci autant d’octets de fichiers que son palier le permet.', fix: 'Attendez le mois suivant.' },
  ext_status_conflict: { what: 'Deux rédacteurs ont publié l’état d’une synchro en même temps.', fix: 'Rien : la boîte relit la révision et republie.' },
  ext_queue_conflict: { what: 'Deux rédacteurs ont publié la file des conflits en même temps.', fix: 'Rien : la boîte relit la révision et republie.' },
  ext_resolve_full: { what: 'Trop de décisions attendent l’exécutant de la synchro.', fix: 'Vérifiez que la boîte qui exécute la synchro tourne : elle lit les décisions au passage suivant.' },
  extdb_lease_held: { what: 'Un autre processus tient le bail de cette synchro (deux boîtes lancées avec le même jeton).', fix: 'Une seule boîte par jeton : arrêtez l’autre instance.' },
  extdb_relay_off: { what: 'Sur le web : le relais de Filarr pour les bases externes est éteint.', fix: 'Lancez la synchro depuis le bureau, ou confiez-la à une boîte noire.' },
};

export const LINK_STATES_FR: Record<string, CodeText> = {
  no_token: { what: 'Pas encore de jeton.', fix: 'Donnez le jeton à la boîte (écran de mise en route, `filarr-gate init`, ou `FILARR_GATE_TOKEN`).' },
  connecting: { what: 'Démarrage, ou reconnexion après une pause.', fix: 'Rien : ça passe tout seul.' },
  live: { what: 'Le flux des changements est ouvert : un changement fait dans Filarr arrive en une seconde environ.', fix: 'Rien.' },
  polling: { what: 'Pas de flux (palier Free, variante Cloudflare, ou flux refusé) : la boîte relève Filarr au rythme de son palier, et à chaque réveil poussé.', fix: 'Rien. Pour aller plus vite sans flux, donnez à Filarr une adresse de réveil (`/_filarr/notify`).' },
  offline: { what: 'Filarr ne répond pas. La boîte sert sa dernière copie et réessaie, de plus en plus espacé.', fix: 'Vérifiez le réseau et le DNS de la machine ; `filarr-gate doctor` teste Filarr.' },
  limited: { what: 'Filarr limite cet accès (un `429`) : la boîte attend `Retry-After` et continue de servir sa copie.', fix: 'Voyez Consommation et limites (interface de gestion) et les limites du palier dans Filarr.' },
  paused: { what: 'L’accès est mis en pause dans Filarr.', fix: 'Rouvrez-le dans Filarr, Réglages › Accès API.' },
  not_switched: { what: 'Les accès API ne sont pas encore ouverts pour le compte Filarr qui a créé l’accès.', fix: 'Rien à faire sur la boîte : elle démarre dès que Filarr l’ouvre.' },
  ip_forbidden: { what: 'Filarr refuse l’adresse IP de cette machine pour cet accès (adresses autorisées).', fix: 'Ajoutez l’adresse publique de la machine à l’accès dans Filarr, ou faites tourner la boîte depuis une adresse autorisée.' },
  revoked: { what: 'L’accès a été révoqué, ou son jeton remplacé : la boîte a effacé sa copie et ses clés.', fix: 'Donnez un nouveau jeton à la boîte (jeton remplacé : le nouveau, montré par Filarr).' },
  expired: { what: 'L’accès a atteint son échéance : la boîte a effacé sa copie.', fix: 'Créez un nouvel accès dans Filarr, ou repoussez l’échéance avant qu’elle arrive la prochaine fois.' },
  unknown_access: { what: 'Filarr ne connaît pas ce jeton (mal recopié, ou d’un autre serveur Filarr).', fix: 'Recopiez le jeton entier ; vérifiez `FILARR_GATE_API_URL`.' },
  upgrade_required: { what: 'Cette version de Filarr Gate est trop ancienne pour l’API de Filarr.', fix: 'Mettez Filarr Gate à jour.' },
  pending: { what: 'Le jeton est une identité neuve qui attend une migration : seuls l’accès et le paquet de réglages répondent.', fix: 'Terminez la migration dans Filarr (« Effacer et changer les clés »), ou abandonnez-la.' },
  asleep: { what: 'Une boîte hébergée est en sommeil (paiement, palier ou politique).', fix: 'Voyez Réglages › Accès API dans Filarr.' },
  error: { what: 'Filarr a refusé quelque chose d’inattendu ; `detail` et le journal disent quoi.', fix: 'Lancez `filarr-gate doctor`.' },
};
