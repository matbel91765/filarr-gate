/**
 * Les textes français des tables générées : `docs/reference/errors.fr.md` et les sections générées de
 * `docs/troubleshooting.fr.md`. Un texte par code, au vouvoiement, avec le vocabulaire de l'aide de
 * Filarr (boîte noire, base, accès, jeton, fente, file « me demander », garde-fou).
 *
 * Les LISTES viennent du code et des vecteurs (voir `scan.ts`), les textes anglais de `codes.ts` :
 * `npm run docs:check` échoue sur un code expliqué dans une langue et pas dans l'autre.
 */

import type { CodeText } from './codes';

/** Les codes de l'API LOCALE (et de l'API de gestion, marqués « Admin »), comme `LOCAL_CODES`. */
export const LOCAL_CODES_FR: Record<string, CodeText & { byStatus?: Record<number, CodeText> }> = {
  aborted: { what: 'Bibliothèque seulement : `openGate()` a été annulé par son `signal`.', fix: 'Rien à corriger ; rouvrez quand vous en avez besoin.' },
  bad_body: {
    what: "Le corps JSON n'est pas ce qu'attend la route : un objet pour une ligne, un tableau d'objets pour plusieurs, jamais un tableau vide.",
    fix: "Envoyez `{ \"champ\": valeur, … }`, ou `[{ … }, { … }]` pour créer plusieurs lignes d'un coup.",
  },
  bad_cursor: { what: "`cursor` n'est pas une valeur donnée par la boîte noire.", fix: 'Passez le `next` de la page précédente, exactement tel que reçu.' },
  bad_filter: {
    what: "Un paramètre de requête n'est ni `champ=valeur` ni `champ[op]=valeur`, ou l'opérateur est inconnu. Dans l'API de gestion, aussi une condition de webhook qui ne se lit pas.",
    fix: "Employez l'un de `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains`, `in`, `empty`. Les paramètres réservés sont `limit`, `cursor`, `fields`, `sort`, `q` et `since`.",
  },
  bad_ip: { what: "Admin : une adresse autorisée d'une clé d'application n'est ni une adresse IP ni une plage CIDR.", fix: 'Écrivez `203.0.113.7` ou `10.0.4.0/24`.' },
  bad_json: { what: "Le corps n'est pas du JSON valide.", fix: 'Vérifiez les guillemets, et envoyez `Content-Type: application/json`.' },
  bad_limit: { what: "`limit` n'est pas un nombre entier d'au moins 1.", fix: 'Passez un nombre de 1 à 1000 (un nombre plus grand est servi comme 1000).' },
  bad_multipart: {
    what: "Le corps `multipart/form-data` d'un dépôt de fichier ne se lit pas.",
    fix: 'Laissez votre bibliothèque HTTP construire le corps multipart (avec une partie `file`) ; ne fixez pas la frontière à la main.',
  },
  bad_package: {
    what: "Le fichier donné à `filarr-gate import` (ou `init --import`) n'est pas un paquet de réglages de Filarr Gate.",
    fix: 'Employez le fichier écrit par `filarr-gate export`, tel quel.',
  },
  bad_path: {
    what: "Le chemin de l'URL ne se décode pas, ou le `path` demandé pour un fichier dépasse 1024 caractères.",
    fix: 'Encodez les morceaux du chemin (`%20`…) ; raccourcissez le chemin demandé.',
  },
  bad_request: { what: "Admin : l'API de gestion a refusé la requête (le message dit pourquoi).", fix: "Lisez `error`, corrigez le champ qu'il nomme, et recommencez." },
  bad_since: { what: "`since` n'est pas un numéro de version.", fix: "Passez la `version` d'une page déjà lue (`since=1042` ou `since=v1042`)." },
  bad_tags: { what: 'Plus de 10 étiquettes, ou une étiquette de plus de 40 caractères, sur un dépôt de fichier.', fix: 'Envoyez 10 étiquettes au plus, de 40 caractères chacune.' },
  bad_value: {
    what: "Une valeur ne convient pas à la colonne où elle s'écrit (un texte pour un nombre, une date mal formée…). `field` nomme le champ.",
    fix: "Envoyez le type JSON qu'attend le champ ; `GET /openapi.json` liste chaque champ avec son type.",
  },
  bad_password: { what: 'Admin : le mot de passe de gestion est faux.', fix: 'Retapez-le. Après 5 échecs en une minute, la boîte noire répond `too_many_attempts` pendant une minute.' },
  bad_response: { what: 'Filarr a accepté un dépôt de fichier sans rendre son identifiant.', fix: 'Recommencez ; si cela persiste, lancez `filarr-gate doctor` et signalez-le.' },
  base_not_found: {
    what: "Aucune base ouverte à cet accès n'a ce slug.",
    fix: "Vérifiez l'adresse : `GET /openapi.json`, ou l'écran **Bases et points d'accès** de l'interface de gestion, liste les slugs.",
  },
  base_read_only: { what: "Filarr a ouvert cette base à l'accès en lecture seule (droit `r`).", fix: "Dans Filarr, ouvrez la base à l'accès en lecture et écriture." },
  body_too_large: {
    what: 'Le corps dépasse ce que la boîte noire accepte (4 Mio pour du JSON ; 8 Kio pour un réveil).',
    fix: 'Envoyez moins de lignes par requête (500 au plus), ou découpez le travail.',
  },
  box_full: {
    what: "La boîte de dépôt liée à l'accès contient déjà autant de dépôts en attente de rangement que Filarr le permet. Rien n'est parti.",
    fix: "Ouvrez Filarr sur un appareil qui range la boîte (bureau ou web), ou rangez les dépôts en attente à la main. Attendre ne suffit pas : quelqu'un doit ouvrir Filarr.",
  },
  box_not_signed: {
    what: "La boîte de dépôt liée à l'accès n'est pas signée par le créateur de l'accès : la boîte noire refuse de sceller des fichiers pour elle.",
    fix: 'Liez de nouveau la boîte depuis Filarr (bureau ou web), qui la signe.',
  },
  confirm_required: { what: 'Admin : oublier la machine demande le mot de confirmation.', fix: "Tapez le mot que demande l'écran." },
  creator_unauthenticated: {
    what: "La boîte noire n'a pas pu authentifier la clé du créateur de l'accès ; elle refuse donc les objets signés (boîtes de dépôt, définitions de synchro, migrations). Le plus souvent, l'accès date d'avant la révision 3 et n'a pas d'étiquette du créateur.",
    fix: 'Dans Filarr (bureau ou web), **Paramètres › Accès API**, remplacez le jeton de cet accès, puis donnez le nouveau jeton à la boîte noire.',
  },
  csrf: {
    what: "Admin : une écriture vers l'API de gestion sans l'en-tête `X-Gate-Admin: 1`.",
    fix: "Passez par l'interface de gestion ou par la commande `filarr-gate` ; un script doit envoyer l'en-tête.",
  },
  deposit_failed: { what: 'Le dépôt du fichier a échoué pour une raison inattendue (le message dit laquelle).', fix: 'Recommencez ; voyez le journal de la boîte noire.' },
  deposit_not_found: { what: "Aucun dépôt de cette boîte noire n'a cet identifiant.", fix: "Employez l'`id` (`dp_…`) rendu par `POST /v1/files`." },
  field_managed: {
    what: "Cette colonne est alimentée par une source externe (la synchro l'écrit, sens `in`) : l'API locale ne l'écrit pas.",
    fix: 'Changez la valeur dans la source ; ou, dans Filarr, faites-en une colonne à vous (détachez-la de la synchro).',
  },
  field_read_only: {
    what: "Ce champ est calculé dans Filarr (formule, agrégat, date de création ou de modification, lien retour) et ne s'écrit jamais.",
    fix: 'Retirez-le du corps ; écrivez les colonnes dont il est calculé.',
  },
  file_required: { what: 'Un dépôt multipart sans partie `file`.', fix: 'Nommez la partie `file`, ou envoyez les octets bruts avec `?name=` (ou un en-tête `X-File-Name`).' },
  file_too_large: {
    what: "Le fichier dépasse la limite de la boîte noire ou celle de Filarr (`limit` donne la taille permise, en octets). Rien n'est parti.",
    fix: 'Envoyez un fichier plus petit, ou montez `files_max_bytes` (jamais au-dessus de la limite que donne Filarr).',
  },
  file_type_refused: {
    what: "Le filtre de la boîte noire a refusé le fichier avant que rien ne parte : une extension de la liste des refus (ou absente de la liste des permis), ou une signature d'exécutable (`MZ`, ELF, Mach-O, `#!`). `reason` et `detail` disent laquelle.",
    fix: 'Envoyez un document, pas un programme ; ou changez `files_deny` / `files_allow` dans les réglages de la boîte noire.',
  },
  filarr_unreachable: { what: "Filarr n'a pas pu être joint : l'écriture ou le dépôt n'a PAS eu lieu.", fix: 'Recommencez plus tard ; en attendant, les lectures restent servies depuis la copie.' },
  filarr_write_unavailable: {
    what: "Filarr n'ouvre pas l'écriture à cet accès : le palier ne comprend pas l'écriture par l'API, ou elle n'est pas encore allumée pour le compte.",
    fix: "Voyez **Paramètres › Accès API** dans Filarr, et le palier du compte qui a créé l'accès.",
  },
  files_not_linked: {
    what: "Aucune boîte de dépôt n'est liée à cet accès : il n'y a nulle part où déposer des fichiers.",
    fix: "Dans Filarr, liez une boîte de dépôt à l'accès (palier Pro et plus).",
  },
  forbidden: {
    what: "La clé d'application est valide mais n'a pas le droit ici : cette base, cette vue, cette requête, le SQL, MCP, ou ce genre d'écriture.",
    fix: "Créez une clé avec les points d'accès qu'il lui faut (interface de gestion, **Clés des applications**), ou élargissez celle-ci.",
  },
  internal: { what: "Une erreur inattendue à l'intérieur de la boîte noire.", fix: 'Regardez le journal de la boîte noire ; si cela se répète, signalez-le avec la ligne du journal.' },
  ip_forbidden: {
    what: "La clé d'application n'accepte que certaines adresses, et cette requête vient d'une autre.",
    fix: 'Appelez depuis une adresse autorisée, ou ajoutez la vôtre à la clé. Derrière un mandataire inverse, réglez `trust_proxy`.',
  },
  key_expired: { what: "La clé d'application a expiré.", fix: "Créez une nouvelle clé ; l'ancienne reste refusée." },
  key_missing: {
    what: 'Deux sens, que le statut distingue.',
    fix: 'Voir ci-dessous.',
    byStatus: {
      401: { what: "Aucune clé d'application sur la requête.", fix: 'Envoyez `Authorization: Bearer gk_…` (ou `X-Gate-Key: gk_…`).' },
      409: {
        what: "Écriture impossible : la boîte noire ne détient pas la clé de la génération actuelle `(e, g)` de la base (elle a changé, par exemple après la révocation d'un autre accès). `keys` liste ce qui manque.",
        fix: "Le créateur de l'accès ouvre Filarr (bureau, web ou mobile, déverrouillé) : les clés sont rescellées en quelques secondes, et l'écriture reprend.",
      },
    },
  },
  key_not_found: {
    what: "Admin : aucune clé d'application n'a cet identifiant.",
    fix: "Listez les clés (`filarr-gate keys list`) et employez l'un des identifiants affichés.",
  },
  key_paused: { what: "La clé d'application est en pause.", fix: "Reprenez-la dans l'interface de gestion (**Clés des applications**)." },
  key_rate: {
    what: "La clé d'application a épuisé ses requêtes de la minute. `Retry-After` donne les secondes à attendre.",
    fix: 'Attendez `Retry-After` secondes, ou montez le débit de la clé.',
  },
  key_unknown: { what: "Clé d'application inconnue ou révoquée.", fix: 'Vérifiez la clé ; une clé révoquée ne revient jamais : créez-en une nouvelle.' },
  login_required: { what: "Admin : l'API de gestion demande une session.", fix: "Connectez-vous à l'interface de gestion, ou employez `filarr-gate` sur la même machine." },
  method_not_allowed: {
    what: 'Cette route ne prend pas cette méthode HTTP (les vues sont en lecture seule ; les fichiers prennent `POST` et `GET`).',
    fix: "Voyez la référence de l'API pour les méthodes de chaque route.",
  },
  name_required: { what: 'Un dépôt de fichier sans nom de fichier, ou une requête enregistrée sans nom.', fix: 'Donnez le nom du fichier (avec son extension), ou un nom à la requête.' },
  no_token: {
    what: "La boîte noire n'a pas de jeton en service (ou, en 409, rien à exporter ni à importer sans jeton).",
    fix: "Donnez-lui le jeton : `filarr-gate init --token flr_live_…`, l'écran de mise en route, ou `FILARR_GATE_TOKEN`.",
  },
  not_found: {
    what: 'Chemin inconnu, ou fonction éteinte sur cette boîte noire (`/metrics`, `/mcp`, `/_filarr/notify`).',
    fix: 'Vérifiez le chemin ; allumez la fonction (réglages `metrics`, `mcp`, `notify`).',
  },
  notify_bad_signature: {
    what: "Un réveil poussé dont la signature n'est pas valide pour ce jeton (pas envoyé par Filarr pour cet accès).",
    fix: "Rien à faire si ce n'était pas Filarr. Après un remplacement de jeton, les anciens réveils sont refusés : c'est attendu.",
  },
  notify_malformed: {
    what: 'Un réveil poussé sans en-tête `Filarr-Notify` ou sans corps lisible.',
    fix: "Seul Filarr appelle cette route ; cherchez ce qui d'autre envoie des requêtes à `/_filarr/notify`.",
  },
  notify_stale: {
    what: "Un réveil poussé signé à plus de 5 minutes de l'horloge de cette machine.",
    fix: "Remettez l'horloge de la machine à l'heure (NTP) ; `filarr-gate doctor` montre l'écart.",
  },
  origin_forbidden: {
    what: "La requête vient d'une page web dont l'origine n'est pas dans la liste CORS de la boîte noire (CORS fermé d'office).",
    fix: "Ajoutez l'origine de la page à `cors_origins` (par exemple `https://shop.example.com`). Ne mettez jamais une clé d'écriture dans une page publique.",
  },
  other_access: { what: "`filarr-gate export --for-token` a reçu le jeton d'un AUTRE accès.", fix: 'Donnez le nouveau jeton du même accès (celui que Filarr montre quand vous le migrez).' },
  package_unreadable: {
    what: "Le paquet de réglages a été scellé pour un autre jeton : cette boîte noire ne peut pas l'ouvrir.",
    fix: 'Exportez de nouveau, avec `--for-token` réglé sur le jeton de CETTE boîte noire.',
  },
  password_from_env: {
    what: "Admin : le mot de passe de gestion vient de `FILARR_GATE_ADMIN_PASSWORD` et ne se change pas dans l'interface.",
    fix: 'Changez la variable et redémarrez.',
  },
  query_not_found: { what: "Aucune requête enregistrée n'a ce slug.", fix: "L'interface de gestion (**Explorateur SQL**) liste les requêtes enregistrées et leurs adresses." },
  row_not_found: { what: "Aucune ligne vivante n'a cet identifiant dans cette base.", fix: "Vérifiez l'`id` ; une ligne supprimée dans Filarr n'est plus servie." },
  rows_managed: {
    what: "Les lignes de cette base viennent d'une source externe (miroir, ou clé naturelle) : l'API locale n'y crée ni n'y supprime de lignes.",
    fix: "Créez ou supprimez la ligne dans la source ; le passage suivant de la synchro l'apporte à Filarr.",
  },
  same_token: { what: '`export --for-token` a reçu le propre jeton de cette boîte noire.', fix: 'Donnez le jeton de la boîte noire qui prend la suite.' },
  scope_files: {
    what: "La clé d'application n'a pas la portée `files` : elle ne peut pas déposer de fichiers.",
    fix: 'Créez une clé qui a la portée fichiers (`filarr-gate keys create --name … --files`).',
  },
  scope_required: { what: "Admin : une nouvelle clé d'application doit ouvrir au moins un point d'accès (ou le SQL, ou MCP).", fix: "Cochez au moins un point d'accès." },
  settings_refused: {
    what: "Admin : un réglage n'a pas pu être changé : il est fixé par une variable d'environnement ou par `gate.toml`, ou la valeur est invalide (le message dit lequel).",
    fix: 'Changez-le là où il est fixé, ou corrigez la valeur.',
  },
  setup_code_required: {
    what: 'Admin : la première mise en route se fait depuis une autre machine, ce qui demande le code de mise en route.',
    fix: 'Tapez le code à 6 chiffres que la boîte noire a affiché dans sa console au démarrage.',
  },
  setup_done: { what: 'Admin : la première mise en route est déjà faite.', fix: 'Connectez-vous avec le mot de passe de gestion.' },
  source_not_found: { what: "Admin : aucune définition de synchro qui désigne cette boîte noire n'a cet identifiant.", fix: 'Listez-les avec `filarr-gate sources list`.' },
  sql_empty: { what: 'La requête SQL est vide.', fix: 'Envoyez `{ "sql": "SELECT …" }`.' },
  sql_error: {
    what: "La requête est du SQL valide mais ne peut pas s'exécuter (table ou colonne inconnue, mauvaise fonction…). `sqlCode` donne le code du moteur.",
    fix: "Corrigez la requête ; `GET /admin/api/sql/tables` (ou l'explorateur SQL) liste les tables et les colonnes.",
  },
  sql_read_only: { what: 'Seuls `SELECT` (et `WITH … SELECT`) passent par `/v1/sql`.', fix: "Écrivez par `POST`, `PATCH` et `DELETE` sur les points d'accès de la base." },
  sql_syntax: { what: 'La requête ne se lit pas. `position` désigne le caractère où la lecture a échoué.', fix: 'Corrigez la syntaxe (dialecte SQLite).' },
  sql_too_long: { what: 'La requête dépasse 64 Kio.', fix: 'Raccourcissez-la, ou enregistrez-la comme requête et appelez `/v1/q/<slug>`.' },
  tls_missing: {
    what: "Admin : le fichier de certificat ou de clé donné pour HTTPS n'existe pas sur cette machine.",
    fix: "Donnez des chemins qui existent et que l'utilisateur de la boîte noire peut lire.",
  },
  token_from_env: {
    what: "Admin : le jeton vient de `FILARR_GATE_TOKEN` et ne se remplace pas dans l'interface.",
    fix: 'Changez la variable (ou le secret du Worker) et redémarrez.',
  },
  token_refused: {
    what: "Admin : Filarr a refusé le jeton saisi (inconnu, révoqué ou expiré) ; il n'a donc pas été gardé.",
    fix: "Recopiez le jeton `flr_live_…` en entier ; s'il a été remplacé ou révoqué, demandez-en un nouveau à Filarr.",
  },
  token_required: { what: 'Bibliothèque seulement : `openGate()` sans jeton.', fix: 'Passez `openGate({ token: process.env.FILARR_GATE_TOKEN })`.' },
  too_many_attempts: { what: 'Admin : 5 mots de passe faux en une minute.', fix: 'Attendez une minute.' },
  too_many_rows: { what: 'Plus de 500 lignes dans une même requête de création.', fix: 'Envoyez 500 lignes au plus par requête.' },
  unknown_field: {
    what: "Un nom de champ n'existe pas dans cette base (dans un filtre, `sort`, `fields`, ou un corps écrit). `field` le nomme.",
    fix: 'Employez les noms de champs JSON que liste `GET /openapi.json` (ils suivent les noms des colonnes, sans accents).',
  },
  unknown_option: {
    what: "Une valeur de sélection n'est pas l'une des options de la colonne.",
    fix: "Envoyez l'un des libellés d'option (le message les liste) ; ajoutez d'abord l'option dans Filarr.",
  },
  view_not_found: { what: "Cette base n'a pas de vue de ce slug.", fix: 'Vérifiez le slug de la vue dans `GET /openapi.json`. Une vue renommée dans Filarr garde son slug.' },
  weak_password: { what: 'Admin : le mot de passe de gestion doit compter 10 caractères au moins.', fix: 'Choisissez-en un plus long.' },
  webhook_not_found: { what: "Admin : aucun webhook n'a cet identifiant.", fix: "Listez les webhooks dans l'interface de gestion." },
  write_disabled: {
    what: "L'écriture vers Filarr est éteinte sur cette boîte noire (le réglage `write`, éteint d'office).",
    fix: "Réglez `FILARR_GATE_WRITE=true` (ou `write = true` dans `gate.toml`, ou l'écran **Réglages**), et donnez à la clé un droit d'écriture.",
  },
  write_failed: { what: 'Une écriture a échoué pour une raison inattendue (le message dit laquelle).', fix: 'Recommencez ; voyez le journal de la boîte noire.' },
};

/** Pourquoi une base n'est pas encore servie, comme `BASE_PROBLEMS`. */
export const BASE_PROBLEMS_FR: Record<string, CodeText> = {
  base_loading: { what: 'La boîte noire fait encore sa première copie de cette base.', fix: 'Patientez quelques secondes ; `GET /health` dit quand chaque base est `ready`.' },
  key_missing: {
    what: "La boîte noire n'a pas la clé de certains blocs `(e, g)` : Filarr a changé les clés de la base, et le créateur ne les a pas encore rescellées pour cet accès. La boîte noire ne saute jamais un bloc en silence.",
    fix: "Le créateur de l'accès ouvre Filarr, déverrouillé : les clés sont rescellées et la boîte noire rattrape son retard toute seule.",
  },
  rollback: {
    what: 'Le serveur a répondu avec une version plus ancienne que celle déjà lue. La boîte noire refuse de revenir en arrière.',
    fix: 'Signalez-le : cela ne devrait jamais arriver avec les serveurs de Filarr. Redémarrer ne le masque pas.',
  },
  head_missing: { what: "Filarr n'a pas de tête pour une version qu'il a annoncée.", fix: 'Attendez le prochain changement ; signalez-le si cela persiste.' },
  head_unverified: {
    what: "La tête de la base n'a pas pu être ouverte ou vérifiée avec les clés que détient la boîte noire.",
    fix: 'Voyez `filarr-gate doctor` ; si une clé vient de changer, le créateur la rescelle en ouvrant Filarr.',
  },
  slot_missing: { what: "Un bloc nommé par la tête n'a pas pu être téléchargé.", fix: 'La boîte noire réessaie seule ; si cela persiste, lancez `filarr-gate doctor`.' },
  slot_unreadable: { what: "Un bloc n'a pas pu être déchiffré.", fix: 'Signalez-le avec la ligne du journal ; la boîte noire continue de servir son dernier état complet.' },
  slot_substituted: {
    what: "Un bloc ne correspondait pas à l'empreinte que la tête donne pour lui : quelqu'un ou quelque chose l'a changé. Il est refusé.",
    fix: 'Signalez-le. La boîte noire ne sert jamais un bloc qui échoue à ce contrôle.',
  },
  unreachable: { what: "Filarr n'a pas pu être joint pendant la lecture de cette base.", fix: 'La boîte noire réessaie ; les lectures restent servies depuis la dernière copie complète.' },
};

/** L'état de la liaison avec Filarr, comme `LINK_STATES`. */
export const LINK_STATES_FR: Record<string, CodeText> = {
  no_token: { what: 'Pas encore de jeton.', fix: "Donnez son jeton à la boîte noire (écran de mise en route, `filarr-gate init`, ou `FILARR_GATE_TOKEN`)." },
  connecting: { what: 'Démarrage, ou reconnexion après une pause.', fix: 'Rien : cela passe tout seul.' },
  live: { what: 'Le flux des changements est ouvert : un changement fait dans Filarr arrive à la boîte noire en une seconde environ.', fix: 'Rien.' },
  polling: {
    what: 'Pas de flux en direct (palier Free, variante Cloudflare, ou flux refusé) : la boîte noire relève Filarr au rythme de son palier, et à chaque réveil poussé.',
    fix: 'Rien. Pour aller plus vite sans flux, donnez à Filarr une adresse de réveil (`/_filarr/notify`).',
  },
  offline: {
    what: 'Filarr ne répond pas. La boîte noire continue de servir sa dernière copie et réessaie à intervalles de plus en plus espacés.',
    fix: 'Vérifiez le réseau et le DNS de la machine ; `filarr-gate doctor` teste Filarr.',
  },
  limited: {
    what: 'Filarr limite cet accès (un `429`) : la boîte noire attend `Retry-After` et continue de servir sa copie.',
    fix: 'Voyez **Consommation et limites** (interface de gestion) et les limites du palier dans Filarr.',
  },
  paused: { what: "L'accès est en pause dans Filarr.", fix: 'Rouvrez-le dans Filarr, **Paramètres › Accès API**.' },
  not_switched: {
    what: "Les accès API ne sont pas encore ouverts pour le compte Filarr qui a créé l'accès.",
    fix: 'Rien à faire sur la boîte noire : elle démarre dès que Filarr les ouvre.',
  },
  ip_forbidden: {
    what: "Filarr refuse l'adresse IP de cette machine pour cet accès (adresses autorisées).",
    fix: "Ajoutez l'adresse publique de la machine à l'accès dans Filarr, ou faites tourner la boîte noire depuis une adresse autorisée.",
  },
  revoked: {
    what: "L'accès a été révoqué, ou son jeton remplacé : la boîte noire a effacé sa copie et ses clés.",
    fix: 'Donnez un nouveau jeton à la boîte noire (jeton remplacé : le nouveau, montré par Filarr).',
  },
  expired: {
    what: "L'accès a atteint son échéance : la boîte noire a effacé sa copie.",
    fix: "Créez un nouvel accès dans Filarr, ou repoussez l'échéance avant qu'elle n'arrive, la prochaine fois.",
  },
  unknown_access: { what: "Filarr ne connaît pas ce jeton (mal recopié, ou venu d'un autre serveur Filarr).", fix: 'Recopiez le jeton en entier ; vérifiez `FILARR_GATE_API_URL`.' },
  upgrade_required: { what: "Cette version de Filarr Gate est trop ancienne pour l'API de Filarr.", fix: 'Mettez Filarr Gate à jour.' },
  pending: {
    what: "Le jeton est une identité neuve qui attend une migration : seuls l'accès et le paquet de réglages répondent.",
    fix: 'Terminez la migration dans Filarr (« Effacer et changer les clés »), ou abandonnez-la.',
  },
  asleep: { what: 'Une boîte hébergée est en sommeil (paiement, palier ou politique).', fix: 'Voyez **Paramètres › Accès API** dans Filarr.' },
  error: { what: "Filarr a refusé quelque chose d'inattendu ; `detail` et le journal disent quoi.", fix: 'Lancez `filarr-gate doctor`.' },
};

/** Les codes que Filarr rend à une boîte noire hors des vecteurs de la révision 3, comme `FILARR_REV2` (le statut vient de lui). */
export const FILARR_REV2_FR: Record<string, CodeText & { gate: string }> = {
  api_access_unknown: { what: 'Filarr ne connaît pas ce jeton.', gate: "S'arrête, efface sa copie, liaison `unknown_access`.", fix: 'Recopiez le jeton en entier ; vérifiez `FILARR_GATE_API_URL`.' },
  api_access_revoked: { what: "L'accès a été révoqué, ou son jeton remplacé.", gate: "S'arrête, efface sa copie et ses clés, liaison `revoked`.", fix: 'Donnez un nouveau jeton à la boîte noire.' },
  api_access_expired: {
    what: "L'accès a expiré.",
    gate: "S'arrête, efface sa copie, liaison `expired`.",
    fix: "Créez un nouvel accès, ou changez l'échéance dans Filarr avant qu'elle n'arrive.",
  },
  api_access_paused: { what: "L'accès est en pause dans Filarr.", gate: 'Garde sa copie, la sert, réessaie ; liaison `paused`.', fix: "Rouvrez l'accès dans Filarr." },
  api_ip_forbidden: {
    what: "L'adresse IP de cette machine n'est pas autorisée pour cet accès.",
    gate: 'Liaison `ip_forbidden`, continue de servir sa copie.',
    fix: "Autorisez l'adresse dans Filarr, ou appelez depuis une adresse autorisée.",
  },
  store_not_granted: {
    what: "La base n'est pas (ou plus) ouverte à cet accès, ou seulement en lecture alors qu'une écriture a été tentée.",
    gate: 'Relit ses droits ; une écriture devient `403 base_read_only`.',
    fix: "Ouvrez la base à l'accès dans Filarr (en lecture et écriture pour écrire).",
  },
  api_base_not_switched: { what: 'Les accès API ne sont pas encore ouverts pour le compte du créateur.', gate: 'Liaison `not_switched`, réessaie.', fix: 'Rien à faire sur la boîte noire.' },
  api_tier_stream: { what: "Le palier n'a pas de flux en direct (Free).", gate: 'Relève à la place, jamais plus vite que le palier ne le permet.', fix: 'Rien ; ou un palier avec les changements en direct.' },
  api_tier_write: { what: "Le palier ne comprend pas l'écriture par l'API.", gate: "Transmet le refus à l'application qui a écrit.", fix: "Un palier qui comprend l'écriture, ou la lecture seule." },
  api_write_unavailable: { what: "L'écriture par l'API n'est pas encore allumée du côté de Filarr.", gate: 'Transmet le refus.', fix: 'Rien à faire sur la boîte noire.' },
  api_rate: {
    what: "L'accès envoie trop de requêtes par minute à Filarr.",
    gate: "Suspend tout échange avec Filarr jusqu'à `Retry-After` ; les lectures locales continuent.",
    fix: 'Rien ; cela reprend. Faire tourner moins de boîtes noires sur le même jeton aide.',
  },
  api_poll_interval: {
    what: 'Palier Free : une base a été relevée plus tôt que permis.',
    gate: "Retient cette base jusqu'à `Retry-After`.",
    fix: 'Rien ; la boîte noire ne relève jamais plus vite que `poll_seconds` et le palier.',
  },
  api_quota_sync: {
    what: 'Le compte a épuisé ses requêtes de synchro du mois.',
    gate: 'Ralentit cette base (tête et changements au plus toutes les 900 s) ; les lectures locales continuent.',
    fix: 'Attendez le mois suivant (UTC), ou un palier supérieur.',
  },
  api_quota_bytes: {
    what: 'Le compte a épuisé son volume téléchargé du mois.',
    gate: "Cesse de télécharger des blocs jusqu'au 1er (UTC) ; continue de servir ce qu'elle a.",
    fix: 'Attendez le mois suivant, ou un palier supérieur.',
  },
  api_quota_writes: {
    what: 'Le compte a épuisé ses écritures acceptées (validations) de la journée.',
    gate: "Refuse l'écriture avec `Retry-After` jusqu'à 00:00 UTC.",
    fix: "Groupez les lignes : une requête de 500 lignes ne fait qu'une validation.",
  },
  vault_frozen: { what: 'Le coffre de cette base est gelé (lecture seule).', gate: "Refuse l'écriture.", fix: "Voyez l'état du coffre dans Filarr." },
  client_upgrade_required: { what: 'Filarr ne parle plus cette version du protocole.', gate: 'Liaison `upgrade_required`.', fix: 'Mettez Filarr Gate à jour.' },
  seq_conflict: {
    what: "Quelqu'un a écrit dans la base au même moment.",
    gate: 'Relit la tête, rescelle et rejoue (les registres fusionnent) : invisible pour vos logiciels.',
    fix: 'Rien.',
  },
  stale_generation: {
    what: 'La base est passée à une nouvelle génération de clés pendant que la boîte noire écrivait.',
    gate: 'Relit et rejoue sous la nouvelle clé, si elle la détient ; sinon `409 key_missing`.',
    fix: 'Rien, ou laissez le créateur ouvrir Filarr.',
  },
  slot_version: { what: 'Un bloc a été réécrit entre-temps.', gate: 'Relit et rejoue.', fix: 'Rien.' },
  bad_cover: { what: "La liste des blocs de l'écriture ne correspond plus à la tête.", gate: 'Relit et rejoue.', fix: 'Rien.' },
};

/** Les codes de la révision 3 (vecteurs `boite-noire-v2-serveur`), comme `FILARR_REV3`. */
export const FILARR_REV3_FR: Record<string, CodeText & { gate?: string }> = {
  reauth_required: { what: "Confier une base à la boîte hébergée demande une preuve d'identité fraîche.", fix: "Filarr la demande à l'écran (mot de passe, code de double authentification ou clé d'accès)." },
  reauth_failed: { what: "La preuve d'identité est fausse.", fix: 'Recommencez ; après 10 essais en une heure, patientez.' },
  api_tier_hosted: { what: 'La boîte hébergée demande le palier Pro ou plus.', fix: 'Un palier supérieur, ou une boîte noire chez vous.' },
  hosting_forbidden: { what: "L'organisation interdit les boîtes hébergées.", fix: "Voyez avec un administrateur de l'organisation, ou installez la boîte noire chez vous." },
  hosting_not_switched: { what: "La boîte hébergée n'est pas encore ouverte pour ce compte.", fix: "Rien à faire : elle s'ouvre compte par compte." },
  consent_outdated: { what: "Le texte de l'accord a changé depuis que vous l'avez accepté.", fix: 'Filarr réaffiche le nouveau texte ; acceptez-le pour garder la base confiée.' },
  host_key_unknown: { what: 'Votre appli Filarr ne connaît pas la clé actuelle du service hébergé.', fix: "Mettez l'appli Filarr à jour." },
  hosting_billing_unavailable: { what: "Aucun abonnement Stripe ne peut porter l'option pour ce payeur.", fix: "Gérez la facturation dans Filarr, ou facturez l'organisation." },
  hosting_exists: { what: 'Cet accès est déjà hébergé.', fix: "Rien ; pour changer l'endroit où il tourne, passez par la migration." },
  consent_required: { what: "Ajouter une base à un accès hébergé demande d'abord un accord pour cette base.", fix: "Acceptez l'accord pour elle dans Filarr, puis ajoutez-la." },
  hosting_not_found: { what: "Cet accès n'est pas hébergé.", fix: 'Rien.' },
  migration_pending: { what: 'Une migration de cet accès est déjà en cours.', fix: 'Terminez-la ou abandonnez-la dans Filarr.' },
  migration_not_ready: {
    what: "La nouvelle boîte noire n'a pas encore importé son paquet de réglages.",
    fix: "Démarrez la nouvelle boîte noire avec son nouveau jeton, attendez l'import, puis basculez.",
  },
  hosting_too_large: { what: 'Les bases à confier sont trop lourdes pour une boîte hébergée.', fix: 'Confiez-en moins, ou installez la boîte noire chez vous.' },
  hosting_asleep: {
    what: 'La boîte hébergée est en sommeil (paiement, palier ou politique). `remedy` dit ce qui la réveille.',
    gate: 'Liaison `asleep`.',
    fix: 'Voyez **Paramètres › Accès API** dans Filarr.',
  },
  hosted_origin_required: {
    what: "Le jeton d'une boîte hébergée a été présenté hors du service hébergé.",
    gate: 'Refusé, car un jeton hébergé ne sert à rien ailleurs.',
    fix: "Rien : c'est ce qui protège ce jeton.",
  },
  api_access_pending: {
    what: 'Une identité neuve, en attente de migration, a appelé autre chose que `self` ou son import.',
    gate: 'Liaison `pending` ; lit son paquet de réglages et attend.',
    fix: 'Terminez la migration dans Filarr.',
  },
  api_tier_files: { what: "Recevoir des fichiers par l'API demande le palier Pro ou plus.", gate: 'Transmet le refus (`403`).', fix: 'Un palier supérieur.' },
  files_not_switched: { what: "Les fichiers par l'API ne sont pas encore ouverts pour ce compte.", gate: 'Transmet le refus.', fix: "Rien : ils s'ouvrent compte par compte." },
  files_not_linked: { what: "Aucune boîte de dépôt n'est liée à l'accès.", gate: "Refuse avant d'envoyer (`409`).", fix: 'Liez une boîte de dépôt dans Filarr.' },
  box_not_permanent: { what: "La boîte liée à l'accès n'est pas une boîte de dépôt permanente.", gate: 'Transmet le refus.', fix: 'Liez une boîte permanente (Filarr en crée une pour vous).' },
  box_not_found: { what: "La boîte de dépôt liée n'existe plus.", gate: 'Transmet le refus.', fix: 'Liez-en une autre dans Filarr.' },
  deposit_not_found: { what: 'Filarr ne connaît pas ce dépôt.', gate: 'État inconnu.', fix: "Vérifiez l'identifiant." },
  box_full: {
    what: "Trop de dépôts attendent dans la boîte d'être rangés.",
    gate: "Refuse avant d'envoyer quand elle le sait déjà ; sinon, transmet le refus.",
    fix: 'Ouvrez Filarr pour les ranger.',
  },
  box_storage_full: { what: 'Les dépôts en attente dans la boîte prennent trop de place.', gate: 'Transmet le refus (`413`).', fix: 'Ouvrez Filarr pour les ranger.' },
  file_too_large: { what: 'Le fichier dépasse la taille que Filarr accepte (`limit`).', gate: "Refuse avant d'envoyer quand elle connaît la limite.", fix: 'Envoyez un fichier plus petit.' },
  api_quota_files: {
    what: 'Le compte a déposé ce mois-ci autant de fichiers que son palier le permet.',
    gate: "Transmet le refus avec `Retry-After` (jusqu'au 1er, UTC).",
    fix: 'Attendez le mois suivant.',
  },
  api_quota_file_bytes: {
    what: "Le compte a déposé ce mois-ci autant d'octets de fichiers que son palier le permet.",
    gate: 'Transmet le refus avec `Retry-After`.',
    fix: 'Attendez le mois suivant.',
  },
  ext_status_conflict: { what: "Deux rédacteurs ont publié l'état d'une synchro en même temps.", gate: 'Relit la révision et republie.', fix: 'Rien.' },
  ext_queue_conflict: { what: "Deux rédacteurs ont publié la file des conflits d'une synchro en même temps.", gate: 'Relit la révision et republie.', fix: 'Rien.' },
  ext_resolve_full: {
    what: "Trop de décisions attendent l'exécutant de la synchro.",
    fix: 'Vérifiez que la boîte noire qui exécute la synchro tourne : elle lit les décisions à son passage suivant.',
  },
  extdb_lease_held: {
    what: 'Un autre processus tient le bail de cette synchro (deux boîtes noires lancées avec le même jeton).',
    gate: 'Saute le passage, état `waiting` (`extdb_lease_held`), réessaie plus tard.',
    fix: "Une seule boîte noire par jeton : arrêtez l'autre instance.",
  },
  extdb_relay_off: { what: 'Web seulement : le relais de Filarr pour les bases externes est éteint.', fix: "Lancez la synchro depuis l'appli de bureau ou une boîte noire." },
};

/** Les états d'une synchro externe, comme `SYNC_CODES`. */
export const SYNC_CODES_FR: Record<string, CodeText> = {
  extdb_key_missing: {
    what: "La clé de la base externe n'a pas été donnée à la boîte noire.",
    fix: 'Donnez-la : écran **Sources**, `filarr-gate sources key <id> --stdin`, `FILARR_GATE_EXTDB_<ID>`, ou `gate.toml`.',
  },
  extdb_key_refused: {
    what: "La base externe a refusé la clé (401 ou 403). Rien n'a été supprimé.",
    fix: 'Créez une nouvelle clé avec les droits dont la synchro a besoin, et donnez-la à la boîte noire.',
  },
  extdb_unreachable: {
    what: "La base externe n'a pas répondu (ou c'est un connecteur TCP sur une variante sans TCP).",
    fix: "Vérifiez l'hôte et le réseau depuis la machine de la boîte noire ; PostgreSQL et MySQL demandent la boîte noire Node ou Docker.",
  },
  extdb_timeout: { what: 'La base externe a mis trop longtemps.', fix: 'Vérifiez sa charge ; ajoutez un index sur la clé et sur le repère.' },
  extdb_tls: { what: 'La connexion chiffrée a échoué (certificat).', fix: 'Corrigez le certificat, ou choisissez `require` dans Filarr ; `off-local` seulement sur un réseau local.' },
  extdb_not_found: {
    what: "La table, la feuille ou la base n'existe pas (ou une source `query` devait écrire).",
    fix: 'Vérifiez les noms dans la définition de la synchro.',
  },
  extdb_upstream_limited: { what: 'Le service externe demande de ralentir (429).', fix: 'Rien ; la boîte noire attend, et le passage suivant reprend.' },
  extdb_too_large: { what: 'Plus de 100 000 lignes lues pour une même définition.', fix: 'Resserrez la source (une requête, une vue, un filtre).' },
  extdb_schema_changed: { what: 'Les colonnes de la source ont changé : un choix attend dans Filarr.', fix: 'Ouvrez la base dans Filarr et choisissez.' },
  extdb_quota_writes: {
    what: "Les écritures du jour dans Filarr sont épuisées ; les changements attendent 00:00 UTC. Rien n'est perdu.",
    fix: 'Rien ; ou moins de passages.',
  },
  extdb_tier: { what: 'Le palier ne comprend pas la synchro planifiée (Solo et plus).', fix: 'Un palier supérieur.' },
  extdb_unsigned: {
    what: "La définition n'est pas signée par le créateur de l'accès (quelqu'un d'autre l'a changée), ou la clé du créateur n'est pas authentifiée.",
    fix: 'Le créateur approuve le changement dans Filarr ; un accès sans étiquette du créateur doit voir son jeton remplacé.',
  },
  extdb_lease_held: { what: 'Une autre instance de cette boîte noire exécute cette synchro.', fix: 'Une seule boîte noire par jeton.' },
  extdb_guard: {
    what: "Garde-fou : trop de lignes seraient marquées ou supprimées d'un coup. Rien n'a été écrit.",
    fix: 'Vérifiez la source ; pour continuer, pour ce passage seulement, donnez votre accord dans Filarr, ou lancez `filarr-gate sources run <id> --ack-guard <passage>`.',
  },
  extdb_conflict_burst: {
    what: "Trop de nouveaux conflits en un passage. Rien n'a été écrit.",
    fix: 'Vérifiez le sens et la clé de ligne ; sur un premier passage, tranchez avec `--initial source` ou `--initial filarr`.',
  },
  extdb_def_newer: { what: 'La définition a été écrite par une version plus récente de Filarr.', fix: 'Mettez Filarr Gate à jour.' },
  extdb_conflicts_pending: {
    what: 'La synchro tourne ; des cellules attendent une décision dans la file « me demander ».',
    fix: 'Tranchez-les dans Filarr ; le passage suivant applique les décisions.',
  },
  extdb_queue_full: {
    what: 'La file « me demander » est pleine ; les nouveaux conflits attendent une place, et leurs cellules ne se synchronisent pas.',
    fix: 'Tranchez des conflits dans Filarr, ou choisissez une politique automatique.',
  },
  extdb_policy_missing: {
    what: 'Une définition dans les deux sens sans politique de conflit (écrite par un Filarr plus ancien). Rien ne tourne.',
    fix: 'Choisissez les politiques dans Filarr ; il signe de nouveau la définition.',
  },
  extdb_def_invalid: {
    what: 'Boîte noire seulement : la définition échoue à la validation (le détail liste les codes, comme `host_mismatch`).',
    fix: 'Corrigez la définition dans Filarr.',
  },
  extdb_not_runner: {
    what: "Boîte noire seulement : un import ponctuel (`once`) n'est jamais exécuté par une boîte noire ; il tourne dans l'appli Filarr.",
    fix: "Lancez l'import depuis Filarr.",
  },
  extdb_relay_limited: { what: 'Web seulement : le débit du relais pour les bases externes est épuisé.', fix: "Attendez, ou lancez la synchro depuis l'appli de bureau ou une boîte noire." },
  extdb_web_unsupported: {
    what: 'Web seulement : ce connecteur ne peut pas joindre sa base depuis un navigateur (PostgreSQL, MySQL).',
    fix: "Lancez la synchro depuis l'appli de bureau ou une boîte noire.",
  },
};
