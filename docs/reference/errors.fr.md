<!-- Généré par `npm run docs` depuis le code (packages/gate, packages/server) et les vecteurs test/vectors/boite-noire-v2-serveur.vectors.json : ne pas modifier à la main ; les explications vivent dans scripts/docs/codes.fr.ts. -->

# Codes d'erreur et états

[Read in English](errors.md)

Chaque refus de l'API locale est du JSON : `{ "error": "<message>", "code": "<code>", … }`. **Fiez-vous à `code`** : il est stable ; `error` est un message pour les personnes (en français pour l'instant) et peut changer. Un `429` porte `Retry-After` (en secondes).

Pour la marche à suivre selon ce que vous voyez, consultez [le dépannage](../troubleshooting.fr.md).

- [Codes de l'API locale](#codes-de-lapi-locale)
- [Codes transmis depuis Filarr](#codes-transmis-depuis-filarr)
- [Pourquoi une base n'est pas servie](#pourquoi-une-base-nest-pas-servie)
- [La liaison avec Filarr](#la-liaison-avec-filarr)
- [Ce que Filarr répond à la boîte noire](#ce-que-filarr-répond-à-la-boîte-noire)
- [États d'une synchro externe](#états-dune-synchro-externe)

## Codes de l'API locale

Les codes que la boîte noire rend elle-même à vos logiciels (et, marqués « Admin », ceux de son API de gestion).

| code | statut | ce qui s'est passé | que faire |
|---|---|---|---|
| `aborted` | 499 | Bibliothèque seulement : `openGate()` a été annulé par son `signal`. | Rien à corriger ; rouvrez quand vous en avez besoin. |
| `bad_body` | 400 | Le corps JSON n'est pas ce qu'attend la route : un objet pour une ligne, un tableau d'objets pour plusieurs, jamais un tableau vide. | Envoyez `{ "champ": valeur, … }`, ou `[{ … }, { … }]` pour créer plusieurs lignes d'un coup. |
| `bad_cursor` | 400 | `cursor` n'est pas une valeur donnée par la boîte noire. | Passez le `next` de la page précédente, exactement tel que reçu. |
| `bad_filter` | 400 | Un paramètre de requête n'est ni `champ=valeur` ni `champ[op]=valeur`, ou l'opérateur est inconnu. Dans l'API de gestion, aussi une condition de webhook qui ne se lit pas. | Employez l'un de `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains`, `in`, `empty`. Les paramètres réservés sont `limit`, `cursor`, `fields`, `sort`, `q` et `since`. |
| `bad_ip` | 400 | Admin : une adresse autorisée d'une clé d'application n'est ni une adresse IP ni une plage CIDR. | Écrivez `203.0.113.7` ou `10.0.4.0/24`. |
| `bad_json` | 400 | Le corps n'est pas du JSON valide. | Vérifiez les guillemets, et envoyez `Content-Type: application/json`. |
| `bad_limit` | 400 | `limit` n'est pas un nombre entier d'au moins 1. | Passez un nombre de 1 à 1000 (un nombre plus grand est servi comme 1000). |
| `bad_multipart` | 400 | Le corps `multipart/form-data` d'un dépôt de fichier ne se lit pas. | Laissez votre bibliothèque HTTP construire le corps multipart (avec une partie `file`) ; ne fixez pas la frontière à la main. |
| `bad_package` | 400 | Le fichier donné à `filarr-gate import` (ou `init --import`) n'est pas un paquet de réglages de Filarr Gate. | Employez le fichier écrit par `filarr-gate export`, tel quel. |
| `bad_password` | 401 | Admin : le mot de passe de gestion est faux. | Retapez-le. Après 5 échecs en une minute, la boîte noire répond `too_many_attempts` pendant une minute. |
| `bad_path` | 400 | Le chemin de l'URL ne se décode pas, ou le `path` demandé pour un fichier dépasse 1024 caractères. | Encodez les morceaux du chemin (`%20`…) ; raccourcissez le chemin demandé. |
| `bad_request` | 400 | Admin : l'API de gestion a refusé la requête (le message dit pourquoi). | Lisez `error`, corrigez le champ qu'il nomme, et recommencez. |
| `bad_response` | 502 | Filarr a accepté un dépôt de fichier sans rendre son identifiant. | Recommencez ; si cela persiste, lancez `filarr-gate doctor` et signalez-le. |
| `bad_since` | 400 | `since` n'est pas un numéro de version. | Passez la `version` d'une page déjà lue (`since=1042` ou `since=v1042`). |
| `bad_tags` | 400 | Plus de 10 étiquettes, ou une étiquette de plus de 40 caractères, sur un dépôt de fichier. | Envoyez 10 étiquettes au plus, de 40 caractères chacune. |
| `bad_value` | 400 | Une valeur ne convient pas à la colonne où elle s'écrit (un texte pour un nombre, une date mal formée…). `field` nomme le champ. | Envoyez le type JSON qu'attend le champ ; `GET /openapi.json` liste chaque champ avec son type. |
| `base_not_found` | 404 | Aucune base ouverte à cet accès n'a ce slug. | Vérifiez l'adresse : `GET /openapi.json`, ou l'écran **Bases** de l'interface de gestion, liste les slugs. |
| `base_read_only` | 403 | Filarr a ouvert cette base à l'accès en lecture seule (droit `r`). | Dans Filarr, ouvrez la base à l'accès en lecture et écriture. |
| `body_too_large` | 413 | Le corps dépasse ce que la boîte noire accepte (4 Mio pour du JSON ; 8 Kio pour un réveil). | Envoyez moins de lignes par requête (500 au plus), ou découpez le travail. |
| `box_full` | 409 | La boîte de dépôt liée à l'accès contient déjà autant de dépôts en attente de rangement que Filarr le permet. Rien n'est parti. | Ouvrez Filarr sur un appareil qui range la boîte (bureau ou web), ou rangez les dépôts en attente à la main. Attendre ne suffit pas : quelqu'un doit ouvrir Filarr. |
| `box_not_signed` | 409 | La boîte de dépôt liée à l'accès n'est pas signée par le créateur de l'accès : la boîte noire refuse de sceller des fichiers pour elle. | Liez de nouveau la boîte depuis Filarr (bureau ou web), qui la signe. |
| `confirm_required` | 400 | Admin : oublier la machine demande le mot de confirmation. | Tapez le mot que demande l'écran. |
| `creator_unauthenticated` | 409 | La boîte noire n'a pas pu authentifier la clé du créateur de l'accès ; elle refuse donc les objets signés (boîtes de dépôt, définitions de synchro, migrations). Le plus souvent, l'accès date d'avant la révision 3 et n'a pas d'étiquette du créateur. | Dans Filarr (bureau ou web), **Paramètres › Accès API**, remplacez le jeton de cet accès, puis donnez le nouveau jeton à la boîte noire. |
| `csrf` | 403 | Admin : une écriture vers l'API de gestion sans l'en-tête `X-Gate-Admin: 1`. | Passez par l'interface de gestion ou par la commande `filarr-gate` ; un script doit envoyer l'en-tête. |
| `deposit_failed` | 500 | Le dépôt du fichier a échoué pour une raison inattendue (le message dit laquelle). | Recommencez ; voyez le journal de la boîte noire. |
| `deposit_not_found` | 404 | Aucun dépôt de cette boîte noire n'a cet identifiant. | Employez l'`id` (`dp_…`) rendu par `POST /v1/files`. |
| `field_managed` | 409 | Cette colonne est alimentée par une source externe (la synchro l'écrit, sens `in`) : l'API locale ne l'écrit pas. | Changez la valeur dans la source ; ou, dans Filarr, faites-en une colonne à vous (détachez-la de la synchro). |
| `field_read_only` | 400 | Ce champ est calculé dans Filarr (formule, agrégat, date de création ou de modification, lien retour) et ne s'écrit jamais. | Retirez-le du corps ; écrivez les colonnes dont il est calculé. |
| `filarr_unreachable` | 503 | Filarr n'a pas pu être joint : l'écriture ou le dépôt n'a PAS eu lieu. | Recommencez plus tard ; en attendant, les lectures restent servies depuis la copie. |
| `filarr_write_unavailable` | 403 | Filarr n'ouvre pas l'écriture à cet accès : le palier ne comprend pas l'écriture par l'API, ou elle n'est pas encore allumée pour le compte. | Voyez **Paramètres › Accès API** dans Filarr, et le palier du compte qui a créé l'accès. |
| `file_required` | 400 | Un dépôt multipart sans partie `file`. | Nommez la partie `file`, ou envoyez les octets bruts avec `?name=` (ou un en-tête `X-File-Name`). |
| `file_too_large` | 413 | Le fichier dépasse la limite de la boîte noire ou celle de Filarr (`limit` donne la taille permise, en octets). Rien n'est parti. | Envoyez un fichier plus petit, ou montez `files_max_bytes` (jamais au-dessus de la limite que donne Filarr). |
| `file_type_refused` | 415 | Le filtre de la boîte noire a refusé le fichier avant que rien ne parte : une extension de la liste des refus (ou absente de la liste des permis), ou une signature d'exécutable (`MZ`, ELF, Mach-O, `#!`). `reason` et `detail` disent laquelle. | Envoyez un document, pas un programme ; ou changez `files_deny` / `files_allow` dans les réglages de la boîte noire. |
| `files_not_linked` | 409 | Aucune boîte de dépôt n'est liée à cet accès : il n'y a nulle part où déposer des fichiers. | Dans Filarr, liez une boîte de dépôt à l'accès (palier Pro et plus). |
| `forbidden` | 403 | La clé d'application est valide mais n'a pas le droit ici : cette base, cette vue, cette requête, le SQL, MCP, ou ce genre d'écriture. | Créez une clé avec les points d'accès qu'il lui faut (interface de gestion, **Clés des applications**), ou élargissez celle-ci. |
| `internal` | 500 | Une erreur inattendue à l'intérieur de la boîte noire. | Regardez le journal de la boîte noire ; si cela se répète, signalez-le avec la ligne du journal. |
| `ip_forbidden` | 403 | La clé d'application n'accepte que certaines adresses, et cette requête vient d'une autre. | Appelez depuis une adresse autorisée, ou ajoutez la vôtre à la clé. Derrière un mandataire inverse, réglez `trust_proxy`. |
| `key_expired` | 403 | La clé d'application a expiré. | Créez une nouvelle clé ; l'ancienne reste refusée. |
| `key_missing` | 401 | Aucune clé d'application sur la requête. | Envoyez `Authorization: Bearer gk_…` (ou `X-Gate-Key: gk_…`). |
| `key_missing` | 409 | Écriture impossible : la boîte noire ne détient pas la clé de la génération actuelle `(e, g)` de la base (elle a changé, par exemple après la révocation d'un autre accès). `keys` liste ce qui manque. | Le créateur de l'accès ouvre Filarr (bureau, web ou mobile, déverrouillé) : les clés sont rescellées en quelques secondes, et l'écriture reprend. |
| `key_not_found` | 404 | Admin : aucune clé d'application n'a cet identifiant. | Listez les clés (`filarr-gate keys list`) et employez l'un des identifiants affichés. |
| `key_paused` | 403 | La clé d'application est en pause. | Reprenez-la dans l'interface de gestion (**Clés des applications**). |
| `key_rate` | 429 | La clé d'application a épuisé ses requêtes de la minute. `Retry-After` donne les secondes à attendre. | Attendez `Retry-After` secondes, ou montez le débit de la clé. |
| `key_unknown` | 401 | Clé d'application inconnue ou révoquée. | Vérifiez la clé ; une clé révoquée ne revient jamais : créez-en une nouvelle. |
| `login_required` | 401 | Admin : l'API de gestion demande une session. | Connectez-vous à l'interface de gestion, ou employez `filarr-gate` sur la même machine. |
| `method_not_allowed` | 405 | Cette route ne prend pas cette méthode HTTP (les vues sont en lecture seule ; les fichiers prennent `POST` et `GET`). | Voyez la référence de l'API pour les méthodes de chaque route. |
| `name_required` | 400 | Un dépôt de fichier sans nom de fichier, ou une requête enregistrée sans nom. | Donnez le nom du fichier (avec son extension), ou un nom à la requête. |
| `no_token` | 409, 503 | La boîte noire n'a pas de jeton en service (ou, en 409, rien à exporter ni à importer sans jeton). | Donnez-lui le jeton : `filarr-gate init --token flr_live_…`, l'écran de mise en route, ou `FILARR_GATE_TOKEN`. |
| `not_found` | 404 | Chemin inconnu, ou fonction éteinte sur cette boîte noire (`/metrics`, `/mcp`, `/_filarr/notify`). | Vérifiez le chemin ; allumez la fonction (réglages `metrics`, `mcp`, `notify`). |
| `notify_bad_signature` | 401 | Un réveil poussé dont la signature n'est pas valide pour ce jeton (pas envoyé par Filarr pour cet accès). | Rien à faire si ce n'était pas Filarr. Après un remplacement de jeton, les anciens réveils sont refusés : c'est attendu. |
| `notify_malformed` | 400, 401 | Un réveil poussé sans en-tête `Filarr-Notify` ou sans corps lisible. | Seul Filarr appelle cette route ; cherchez ce qui d'autre envoie des requêtes à `/_filarr/notify`. |
| `notify_stale` | 401 | Un réveil poussé signé à plus de 5 minutes de l'horloge de cette machine. | Remettez l'horloge de la machine à l'heure (NTP) ; `filarr-gate doctor` montre l'écart. |
| `origin_forbidden` | 403 | La requête vient d'une page web dont l'origine n'est pas dans la liste CORS de la boîte noire (CORS fermé d'office). | Ajoutez l'origine de la page à `cors_origins` (par exemple `https://shop.example.com`). Ne mettez jamais une clé d'écriture dans une page publique. |
| `other_access` | 400 | `filarr-gate export --for-token` a reçu le jeton d'un AUTRE accès. | Donnez le nouveau jeton du même accès (celui que Filarr montre quand vous le migrez). |
| `package_unreadable` | 400 | Le paquet de réglages a été scellé pour un autre jeton : cette boîte noire ne peut pas l'ouvrir. | Exportez de nouveau, avec `--for-token` réglé sur le jeton de CETTE boîte noire. |
| `password_from_env` | 409 | Admin : le mot de passe de gestion vient de `FILARR_GATE_ADMIN_PASSWORD` et ne se change pas dans l'interface. | Changez la variable et redémarrez. |
| `query_not_found` | 404 | Aucune requête enregistrée n'a ce slug. | L'interface de gestion (**Explorateur SQL**) liste les requêtes enregistrées et leurs adresses. |
| `row_not_found` | 404 | Aucune ligne vivante n'a cet identifiant dans cette base. | Vérifiez l'`id` ; une ligne supprimée dans Filarr n'est plus servie. |
| `rows_managed` | 409 | Les lignes de cette base viennent d'une source externe (miroir, ou clé naturelle) : l'API locale n'y crée ni n'y supprime de lignes. | Créez ou supprimez la ligne dans la source ; le passage suivant de la synchro l'apporte à Filarr. |
| `same_token` | 400 | `export --for-token` a reçu le propre jeton de cette boîte noire. | Donnez le jeton de la boîte noire qui prend la suite. |
| `scope_files` | 403 | La clé d'application n'a pas la portée `files` : elle ne peut pas déposer de fichiers. | Créez une clé qui a la portée fichiers (`filarr-gate keys create --name … --files`). |
| `scope_required` | 400 | Admin : une nouvelle clé d'application doit ouvrir au moins un point d'accès (ou le SQL, ou MCP). | Cochez au moins un point d'accès. |
| `settings_refused` | 400 | Admin : un réglage n'a pas pu être changé : il est fixé par une variable d'environnement ou par `gate.toml`, ou la valeur est invalide (le message dit lequel). | Changez-le là où il est fixé, ou corrigez la valeur. |
| `setup_code_required` | 403 | Admin : la première mise en route se fait depuis une autre machine, ce qui demande le code de mise en route. | Tapez le code à 6 chiffres que la boîte noire a affiché dans sa console au démarrage. |
| `setup_done` | 409 | Admin : la première mise en route est déjà faite. | Connectez-vous avec le mot de passe de gestion. |
| `source_not_found` | 404 | Admin : aucune définition de synchro qui désigne cette boîte noire n'a cet identifiant. | Listez-les avec `filarr-gate sources list`. |
| `sql_empty` | 400 | La requête SQL est vide. | Envoyez `{ "sql": "SELECT …" }`. |
| `sql_error` | 400 | La requête est du SQL valide mais ne peut pas s'exécuter (table ou colonne inconnue, mauvaise fonction…). `sqlCode` donne le code du moteur. | Corrigez la requête ; `GET /admin/api/sql/tables` (ou l'explorateur SQL) liste les tables et les colonnes. |
| `sql_read_only` | 400 | Seuls `SELECT` (et `WITH … SELECT`) passent par `/v1/sql`. | Écrivez par `POST`, `PATCH` et `DELETE` sur les points d'accès de la base. |
| `sql_syntax` | 400 | La requête ne se lit pas. `position` désigne le caractère où la lecture a échoué. | Corrigez la syntaxe (dialecte SQLite). |
| `sql_too_long` | 413 | La requête dépasse 64 Kio. | Raccourcissez-la, ou enregistrez-la comme requête et appelez `/v1/q/<slug>`. |
| `tls_missing` | 400 | Admin : le fichier de certificat ou de clé donné pour HTTPS n'existe pas sur cette machine. | Donnez des chemins qui existent et que l'utilisateur de la boîte noire peut lire. |
| `token_from_env` | 409 | Admin : le jeton vient de `FILARR_GATE_TOKEN` et ne se remplace pas dans l'interface. | Changez la variable (ou le secret du Worker) et redémarrez. |
| `token_refused` | 400 | Admin : Filarr a refusé le jeton saisi (inconnu, révoqué ou expiré) ; il n'a donc pas été gardé. | Recopiez le jeton `flr_live_…` en entier ; s'il a été remplacé ou révoqué, demandez-en un nouveau à Filarr. |
| `token_required` | 400 | Bibliothèque seulement : `openGate()` sans jeton. | Passez `openGate({ token: process.env.FILARR_GATE_TOKEN })`. |
| `too_many_attempts` | 429 | Admin : 5 mots de passe faux en une minute. | Attendez une minute. |
| `too_many_rows` | 413 | Plus de 500 lignes dans une même requête de création. | Envoyez 500 lignes au plus par requête. |
| `unknown_field` | 400 | Un nom de champ n'existe pas dans cette base (dans un filtre, `sort`, `fields`, ou un corps écrit). `field` le nomme. | Employez les noms de champs JSON que liste `GET /openapi.json` (ils suivent les noms des colonnes, sans accents). |
| `unknown_option` | 400 | Une valeur de sélection n'est pas l'une des options de la colonne. | Envoyez l'un des libellés d'option (le message les liste) ; ajoutez d'abord l'option dans Filarr. |
| `view_not_found` | 404 | Cette base n'a pas de vue de ce slug. | Vérifiez le slug de la vue dans `GET /openapi.json`. Une vue renommée dans Filarr garde son slug. |
| `weak_password` | 400 | Admin : le mot de passe de gestion doit compter 10 caractères au moins. | Choisissez-en un plus long. |
| `webhook_not_found` | 404 | Admin : aucun webhook n'a cet identifiant. | Listez les webhooks dans l'interface de gestion. |
| `write_disabled` | 403 | L'écriture vers Filarr est éteinte sur cette boîte noire (le réglage `write`, éteint d'office). | Réglez `FILARR_GATE_WRITE=true` (ou `write = true` dans `gate.toml`, ou l'écran **Réglages**), et donnez à la clé un droit d'écriture. |
| `write_failed` | 500 | Une écriture a échoué pour une raison inattendue (le message dit laquelle). | Recommencez ; voyez le journal de la boîte noire. |

## Codes transmis depuis Filarr

Quand Filarr refuse une écriture ou un dépôt de fichier, l'API locale rend tels quels le `code` et le statut de Filarr : `api_rate`, `api_quota_writes`, `api_tier_write`, `api_write_unavailable`, `vault_frozen`, `api_tier_files`, `files_not_switched`, `box_not_permanent`, `box_not_found`, `box_storage_full`, `api_quota_files`, `api_quota_file_bytes`. Ils sont expliqués [plus bas](#ce-que-filarr-répond-à-la-boîte-noire). Tout autre refus de Filarr devient un `502` qui porte le code de Filarr.

## Pourquoi une base n'est pas servie

Tant qu'une base n'est pas complète et vérifiée, ses routes répondent `503` avec l'un de ces codes. Une fois la base servie, un problème ultérieur ne l'arrête plus : la boîte noire continue de servir sa dernière copie complète et ajoute l'en-tête `X-Gate-Base-Status`.

| code | ce qui s'est passé | que faire |
|---|---|---|
| `base_loading` | La boîte noire fait encore sa première copie de cette base. | Patientez quelques secondes ; `GET /health` dit quand chaque base est `ready`. |
| `key_missing` | La boîte noire n'a pas la clé de certains blocs `(e, g)` : Filarr a changé les clés de la base, et le créateur ne les a pas encore rescellées pour cet accès. La boîte noire ne saute jamais un bloc en silence. | Le créateur de l'accès ouvre Filarr, déverrouillé : les clés sont rescellées et la boîte noire rattrape son retard toute seule. |
| `rollback` | Le serveur a répondu avec une version plus ancienne que celle déjà lue. La boîte noire refuse de revenir en arrière. | Signalez-le : cela ne devrait jamais arriver avec les serveurs de Filarr. Redémarrer ne le masque pas. |
| `head_missing` | Filarr n'a pas de tête pour une version qu'il a annoncée. | Attendez le prochain changement ; signalez-le si cela persiste. |
| `head_unverified` | La tête de la base n'a pas pu être ouverte ou vérifiée avec les clés que détient la boîte noire. | Voyez `filarr-gate doctor` ; si une clé vient de changer, le créateur la rescelle en ouvrant Filarr. |
| `slot_missing` | Un bloc nommé par la tête n'a pas pu être téléchargé. | La boîte noire réessaie seule ; si cela persiste, lancez `filarr-gate doctor`. |
| `slot_unreadable` | Un bloc n'a pas pu être déchiffré. | Signalez-le avec la ligne du journal ; la boîte noire continue de servir son dernier état complet. |
| `slot_substituted` | Un bloc ne correspondait pas à l'empreinte que la tête donne pour lui : quelqu'un ou quelque chose l'a changé. Il est refusé. | Signalez-le. La boîte noire ne sert jamais un bloc qui échoue à ce contrôle. |
| `unreachable` | Filarr n'a pas pu être joint pendant la lecture de cette base. | La boîte noire réessaie ; les lectures restent servies depuis la dernière copie complète. |

## La liaison avec Filarr

`GET /health` la rend dans `link` ; l'interface de gestion et `filarr-gate doctor` l'affichent ; la bibliothèque la rend dans `status().link`.

| état | ce que cela veut dire | que faire |
|---|---|---|
| `no_token` | Pas encore de jeton. | Donnez son jeton à la boîte noire (écran de mise en route, `filarr-gate init`, ou `FILARR_GATE_TOKEN`). |
| `connecting` | Démarrage, ou reconnexion après une pause. | Rien : cela passe tout seul. |
| `live` | Le flux des changements est ouvert : un changement fait dans Filarr arrive à la boîte noire en une seconde environ. | Rien. |
| `polling` | Pas de flux en direct (palier Free, variante Cloudflare, ou flux refusé) : la boîte noire relève Filarr au rythme de son palier, et à chaque réveil poussé. | Rien. Pour aller plus vite sans flux, donnez à Filarr une adresse de réveil (`/_filarr/notify`). |
| `offline` | Filarr ne répond pas. La boîte noire continue de servir sa dernière copie et réessaie, de plus en plus espacé. | Vérifiez le réseau et le DNS de la machine ; `filarr-gate doctor` teste Filarr. |
| `limited` | Filarr limite cet accès (un `429`) : la boîte noire attend `Retry-After` et continue de servir sa copie. | Voyez **Consommation et limites** (interface de gestion) et les limites du palier dans Filarr. |
| `paused` | L'accès est en pause dans Filarr. | Rouvrez-le dans Filarr, **Paramètres › Accès API**. |
| `not_switched` | Les accès API ne sont pas encore ouverts pour le compte Filarr qui a créé l'accès. | Rien à faire sur la boîte noire : elle démarre dès que Filarr les ouvre. |
| `ip_forbidden` | Filarr refuse l'adresse IP de cette machine pour cet accès (adresses autorisées). | Ajoutez l'adresse publique de la machine à l'accès dans Filarr, ou faites tourner la boîte noire depuis une adresse autorisée. |
| `revoked` | L'accès a été révoqué, ou son jeton remplacé : la boîte noire a effacé sa copie et ses clés. | Donnez un nouveau jeton à la boîte noire (jeton remplacé : le nouveau, montré par Filarr). |
| `expired` | L'accès a atteint son échéance : la boîte noire a effacé sa copie. | Créez un nouvel accès dans Filarr, ou repoussez l'échéance avant qu'elle n'arrive, la prochaine fois. |
| `unknown_access` | Filarr ne connaît pas ce jeton (mal recopié, ou venu d'un autre serveur Filarr). | Recopiez le jeton en entier ; vérifiez `FILARR_GATE_API_URL`. |
| `upgrade_required` | Cette version de Filarr Gate est trop ancienne pour l'API de Filarr. | Mettez Filarr Gate à jour. |
| `pending` | Le jeton est une identité neuve qui attend une migration : seuls l'accès et le paquet de réglages répondent. | Terminez la migration dans Filarr (« Effacer et changer les clés »), ou abandonnez-la. |
| `asleep` | Une boîte hébergée est en sommeil (paiement, palier ou politique). | Voyez **Paramètres › Accès API** dans Filarr. |
| `error` | Filarr a refusé quelque chose d'inattendu ; `detail` et le journal disent quoi. | Lancez `filarr-gate doctor`. |

## Ce que Filarr répond à la boîte noire

La boîte noire s'en charge seule ; vous les voyez dans son journal, dans `filarr-gate doctor`, et transmis pour les écritures et les dépôts. Les codes de la révision 3 portent un **remède** (le vocabulaire dont se servent les applis de Filarr pour proposer un geste : `upgrade`, `wait`, `reauthenticate`, `manageBilling`, `updatePayment`).

| code | statut | ce qui s'est passé | ce que fait la boîte noire | que faire |
|---|---|---|---|---|
| `api_access_unknown` | 401 | Filarr ne connaît pas ce jeton. | S'arrête, efface sa copie, liaison `unknown_access`. | Recopiez le jeton en entier ; vérifiez `FILARR_GATE_API_URL`. |
| `api_access_revoked` | 401 | L'accès a été révoqué, ou son jeton remplacé. | S'arrête, efface sa copie et ses clés, liaison `revoked`. | Donnez un nouveau jeton à la boîte noire. |
| `api_access_expired` | 401 | L'accès a expiré. | S'arrête, efface sa copie, liaison `expired`. | Créez un nouvel accès, ou changez l'échéance dans Filarr avant qu'elle n'arrive. |
| `api_access_paused` | 403 | L'accès est en pause dans Filarr. | Garde sa copie, la sert, réessaie ; liaison `paused`. | Rouvrez l'accès dans Filarr. |
| `api_ip_forbidden` | 403 | L'adresse IP de cette machine n'est pas autorisée pour cet accès. | Liaison `ip_forbidden`, continue de servir sa copie. | Autorisez l'adresse dans Filarr, ou appelez depuis une adresse autorisée. |
| `store_not_granted` | 403 | La base n'est pas (ou plus) ouverte à cet accès, ou seulement en lecture alors qu'une écriture a été tentée. | Relit ses droits ; une écriture devient `403 base_read_only`. | Ouvrez la base à l'accès dans Filarr (en lecture et écriture pour écrire). |
| `api_base_not_switched` | 403 | Les accès API ne sont pas encore ouverts pour le compte du créateur. | Liaison `not_switched`, réessaie. | Rien à faire sur la boîte noire. |
| `api_tier_stream` | 403 | Le palier n'a pas de flux en direct (Free). | Relève à la place, jamais plus vite que le palier ne le permet. | Rien ; ou un palier avec les changements en direct. |
| `api_tier_write` | 403 | Le palier ne comprend pas l'écriture par l'API. | Transmet le refus à l'application qui a écrit. | Un palier qui comprend l'écriture, ou la lecture seule. |
| `api_write_unavailable` | 403 | L'écriture par l'API n'est pas encore allumée du côté de Filarr. | Transmet le refus. | Rien à faire sur la boîte noire. |
| `api_rate` | 429 | L'accès envoie trop de requêtes par minute à Filarr. | Suspend tout échange avec Filarr jusqu'à `Retry-After` ; les lectures locales continuent. | Rien ; cela reprend. Moins de boîtes noires sur le même jeton aident. |
| `api_poll_interval` | 429 | Palier Free : une base a été relevée plus tôt que permis. | Retient cette base jusqu'à `Retry-After`. | Rien ; la boîte noire ne relève jamais plus vite que `poll_seconds` et le palier. |
| `api_quota_sync` | 429 | Le compte a épuisé ses requêtes de synchro du mois. | Ralentit cette base (tête et changements au plus toutes les 900 s) ; les lectures locales continuent. | Attendez le mois suivant (UTC), ou un palier supérieur. |
| `api_quota_bytes` | 429 | Le compte a épuisé son volume téléchargé du mois. | Cesse de télécharger des blocs jusqu'au 1er (UTC) ; continue de servir ce qu'elle a. | Attendez le mois suivant, ou un palier supérieur. |
| `api_quota_writes` | 429 | Le compte a épuisé ses écritures acceptées (validations) de la journée. | Refuse l'écriture avec `Retry-After` jusqu'à 00:00 UTC. | Groupez les lignes : une requête de 500 lignes ne fait qu'une validation. |
| `vault_frozen` | 409 | Le coffre de cette base est gelé (lecture seule). | Refuse l'écriture. | Voyez l'état du coffre dans Filarr. |
| `client_upgrade_required` | 426 | Filarr ne parle plus cette version du protocole. | Liaison `upgrade_required`. | Mettez Filarr Gate à jour. |
| `seq_conflict` | 409 | Quelqu'un a écrit dans la base au même moment. | Relit la tête, rescelle et rejoue (les registres fusionnent) : invisible pour vos logiciels. | Rien. |
| `stale_generation` | 409 | La base est passée à une nouvelle génération de clés pendant que la boîte noire écrivait. | Relit et rejoue sous la nouvelle clé, si elle la détient ; sinon `409 key_missing`. | Rien, ou laissez le créateur ouvrir Filarr. |
| `slot_version` | 409 | Un bloc a été réécrit entre-temps. | Relit et rejoue. | Rien. |
| `bad_cover` | 409 | La liste des blocs de l'écriture ne correspond plus à la tête. | Relit et rejoue. | Rien. |

Révision 3 (boîte hébergée, fichiers, synchros externes), lue dans les vecteurs :

| code | statut | remède | `Retry-After` | ce qui s'est passé | que faire |
|---|---|---|---|---|---|
| `reauth_required` | 401 | `reauthenticate` |  | Confier une base à la boîte hébergée demande une preuve d'identité fraîche. | Filarr la demande à l'écran (mot de passe, code de double authentification ou clé d'accès). |
| `reauth_failed` | 401 |  |  | La preuve d'identité est fausse. | Recommencez ; après 10 essais en une heure, patientez. |
| `api_tier_hosted` | 403 | `upgrade` |  | La boîte hébergée demande le palier Pro ou plus. | Un palier supérieur, ou une boîte noire chez vous. |
| `hosting_forbidden` | 403 |  |  | L'organisation interdit les boîtes hébergées. | Voyez avec un administrateur de l'organisation, ou installez la boîte noire chez vous. |
| `hosting_not_switched` | 409 |  |  | La boîte hébergée n'est pas encore ouverte pour ce compte. | Rien à faire : elle ouvre compte par compte. |
| `consent_outdated` | 409 |  |  | Le texte de l'accord a changé depuis que vous l'avez accepté. | Filarr remontre le nouveau texte ; acceptez-le pour garder la base confiée. |
| `host_key_unknown` | 409 |  |  | Votre appli Filarr ne connaît pas la clé actuelle du service hébergé. | Mettez l'appli Filarr à jour. |
| `hosting_billing_unavailable` | 409 | `manageBilling` |  | Aucun abonnement Stripe ne peut porter l'option pour ce payeur. | Gérez la facturation dans Filarr, ou facturez l'organisation. |
| `hosting_exists` | 409 |  |  | Cet accès est déjà hébergé. | Rien ; pour changer l'endroit où il tourne, passez par la migration. |
| `consent_required` | 409 |  |  | Ajouter une base à un accès hébergé demande d'abord un accord pour cette base. | Acceptez l'accord pour elle dans Filarr, puis ajoutez-la. |
| `hosting_not_found` | 404 |  |  | Cet accès n'est pas hébergé. | Rien. |
| `migration_pending` | 409 |  |  | Une migration de cet accès est déjà en cours. | Terminez-la ou abandonnez-la dans Filarr. |
| `migration_not_ready` | 409 |  |  | La nouvelle boîte noire n'a pas encore importé son paquet de réglages. | Démarrez la nouvelle boîte noire avec son nouveau jeton, attendez l'import, puis basculez. |
| `hosting_too_large` | 413 |  |  | Les bases à confier sont trop lourdes pour une boîte hébergée. | Confiez-en moins, ou installez la boîte noire chez vous. |
| `hosting_asleep` | 403 | billing : `updatePayment` ; tier : `upgrade` ; policy : aucun ; consent : aucun ; service : aucun |  | La boîte hébergée est en sommeil (paiement, palier ou politique). `remedy` dit ce qui la réveille. Boîte noire : liaison `asleep`. | Voyez **Paramètres › Accès API** dans Filarr. |
| `hosted_origin_required` | 401 |  |  | Le jeton d'une boîte hébergée a été présenté hors du service hébergé. Boîte noire : refusé : un jeton hébergé ne sert à rien ailleurs. | Rien : c'est ce qui protège ce jeton. |
| `api_access_pending` | 403 |  |  | Une identité neuve, en attente de migration, a appelé autre chose que `self` ou son import. Boîte noire : liaison `pending` ; lit son paquet de réglages et attend. | Terminez la migration dans Filarr. |
| `api_tier_files` | 403 | `upgrade` |  | Recevoir des fichiers par l'API demande le palier Pro ou plus. Boîte noire : transmet le refus (`403`). | Un palier supérieur. |
| `files_not_switched` | 409 |  |  | Les fichiers par l'API ne sont pas encore ouverts pour ce compte. Boîte noire : transmet le refus. | Rien : ils ouvrent compte par compte. |
| `files_not_linked` | 409 |  |  | Aucune boîte de dépôt n'est liée à l'accès. Boîte noire : refuse avant d'envoyer (`409`). | Liez une boîte de dépôt dans Filarr. |
| `box_not_permanent` | 409 |  |  | La boîte liée à l'accès n'est pas une boîte de dépôt permanente. Boîte noire : transmet le refus. | Liez une boîte permanente (Filarr en crée une pour vous). |
| `box_not_found` | 404 |  |  | La boîte de dépôt liée n'existe plus. Boîte noire : transmet le refus. | Liez-en une autre dans Filarr. |
| `deposit_not_found` | 404 |  |  | Filarr ne connaît pas ce dépôt. Boîte noire : état inconnu. | Vérifiez l'identifiant. |
| `box_full` | 409 |  |  | Trop de dépôts attendent d'être rangés dans la boîte. Boîte noire : refuse avant d'envoyer quand elle le sait déjà ; sinon, transmet le refus. | Ouvrez Filarr pour les ranger. |
| `box_storage_full` | 413 |  |  | Les dépôts en attente dans la boîte prennent trop de place. Boîte noire : transmet le refus (`413`). | Ouvrez Filarr pour les ranger. |
| `file_too_large` | 413 |  |  | Le fichier dépasse la taille que Filarr accepte (`limit`). Boîte noire : refuse avant d'envoyer quand elle connaît la limite. | Envoyez un fichier plus petit. |
| `api_quota_files` | 429 | `wait` | oui | Le compte a déposé ce mois-ci autant de fichiers que son palier le permet. Boîte noire : transmet le refus avec `Retry-After` (jusqu'au 1er, UTC). | Attendez le mois suivant. |
| `api_quota_file_bytes` | 429 | `wait` | oui | Le compte a déposé ce mois-ci autant d'octets de fichiers que son palier le permet. Boîte noire : transmet le refus avec `Retry-After`. | Attendez le mois suivant. |
| `ext_status_conflict` | 409 |  |  | Deux rédacteurs ont publié l'état d'une synchro en même temps. Boîte noire : relit la révision et republie. | Rien. |
| `ext_queue_conflict` | 409 |  |  | Deux rédacteurs ont publié la file des conflits d'une synchro en même temps. Boîte noire : relit la révision et republie. | Rien. |
| `ext_resolve_full` | 409 |  |  | Trop de décisions attendent l'exécutant de la synchro. | Vérifiez que la boîte noire qui exécute la synchro tourne : elle lit les décisions à son passage suivant. |
| `extdb_lease_held` | 409 | `wait` | oui | Un autre processus tient le bail de cette synchro (deux boîtes noires lancées avec le même jeton). Boîte noire : saute le passage, état `waiting` (`extdb_lease_held`), réessaie plus tard. | Une seule boîte noire par jeton : arrêtez l'autre instance. |
| `extdb_relay_off` | 409 |  |  | Web seulement : le relais de Filarr pour les bases externes est éteint. | Lancez la synchro depuis l'appli de bureau ou une boîte noire. |

## États d'une synchro externe

La boîte noire publie l'état de chaque synchro qu'elle exécute (scellé : Filarr ne peut pas le lire ; les membres de la base, si). Ces codes apparaissent dans cet état, sur l'écran **Sources** et dans `filarr-gate sources list` ; jamais comme statut HTTP. Les codes marqués « Web seulement » concernent les synchros exécutées par l'appli web de Filarr.

| code | ce qui s'est passé | que faire |
|---|---|---|
| `extdb_key_missing` | La clé de la base externe n'a pas été donnée à la boîte noire. | Donnez-la : écran **Sources**, `filarr-gate sources key <id> --stdin`, `FILARR_GATE_EXTDB_<ID>`, ou `gate.toml`. |
| `extdb_key_refused` | La base externe a refusé la clé (401 ou 403). Rien n'a été supprimé. | Créez une nouvelle clé avec les droits dont la synchro a besoin, et donnez-la à la boîte noire. |
| `extdb_unreachable` | La base externe n'a pas répondu (ou c'est un connecteur TCP sur une variante sans TCP). | Vérifiez l'hôte et le réseau depuis la machine de la boîte noire ; PostgreSQL et MySQL demandent la boîte noire Node ou Docker. |
| `extdb_timeout` | La base externe a mis trop longtemps. | Vérifiez sa charge ; ajoutez un index sur la clé et sur le repère. |
| `extdb_tls` | La connexion chiffrée a échoué (certificat). | Corrigez le certificat, ou choisissez `require` dans Filarr ; `off-local` seulement sur un réseau local. |
| `extdb_not_found` | La table, la feuille ou la base n'existe pas (ou une source `query` devait écrire). | Vérifiez les noms dans la définition de la synchro. |
| `extdb_upstream_limited` | Le service externe demande de ralentir (429). | Rien ; la boîte noire attend, et le passage suivant reprend. |
| `extdb_too_large` | Plus de 100 000 lignes lues pour une même définition. | Resserrez la source (une requête, une vue, un filtre). |
| `extdb_schema_changed` | Les colonnes de la source ont changé : un choix attend dans Filarr. | Ouvrez la base dans Filarr et choisissez. |
| `extdb_quota_writes` | Les écritures du jour dans Filarr sont épuisées ; les changements attendent 00:00 UTC. Rien n'est perdu. | Rien ; ou moins de passages. |
| `extdb_tier` | Le palier ne comprend pas la synchro planifiée (Solo et plus). | Un palier supérieur. |
| `extdb_unsigned` | La définition n'est pas signée par le créateur de l'accès (quelqu'un d'autre l'a changée), ou la clé du créateur n'est pas authentifiée. | Le créateur approuve le changement dans Filarr ; un accès sans étiquette du créateur doit voir son jeton remplacé. |
| `extdb_lease_held` | Une autre instance de cette boîte noire exécute cette synchro. | Une seule boîte noire par jeton. |
| `extdb_guard` | Garde-fou : trop de lignes seraient marquées ou supprimées d'un coup. Rien n'a été écrit. | Vérifiez la source ; pour continuer pour ce passage seulement, acceptez dans Filarr, ou lancez `filarr-gate sources run <id> --ack-guard <passage>`. |
| `extdb_conflict_burst` | Trop de nouveaux conflits en un passage. Rien n'a été écrit. | Vérifiez le sens et la clé de ligne ; sur un premier passage, tranchez avec `--initial source` ou `--initial filarr`. |
| `extdb_def_newer` | La définition a été écrite par une version plus récente de Filarr. | Mettez Filarr Gate à jour. |
| `extdb_conflicts_pending` | La synchro tourne ; des cellules attendent une décision dans la file « me demander ». | Tranchez-les dans Filarr ; le passage suivant applique les décisions. |
| `extdb_queue_full` | La file « me demander » est pleine ; les nouveaux conflits attendent une place, et leurs cellules ne se synchronisent pas. | Tranchez des conflits dans Filarr, ou choisissez une politique automatique. |
| `extdb_policy_missing` | Une définition dans les deux sens sans politique de conflit (écrite par un Filarr plus ancien). Rien ne tourne. | Choisissez les politiques dans Filarr ; il signe de nouveau la définition. |
| `extdb_def_invalid` | Boîte noire seulement : la définition échoue à la validation (le détail liste les codes, comme `host_mismatch`). | Corrigez la définition dans Filarr. |
| `extdb_not_runner` | Boîte noire seulement : un import ponctuel (`once`) n'est jamais exécuté par une boîte noire ; il tourne dans l'appli Filarr. | Lancez l'import depuis Filarr. |
| `extdb_relay_limited` | Web seulement : le débit du relais pour les bases externes est épuisé. | Attendez, ou lancez la synchro depuis l'appli de bureau ou une boîte noire. |
| `extdb_web_unsupported` | Web seulement : ce connecteur ne se joint pas depuis un navigateur (PostgreSQL, MySQL). | Lancez la synchro depuis l'appli de bureau ou une boîte noire. |
