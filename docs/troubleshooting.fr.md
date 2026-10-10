# Dépannage

[Read in English](troubleshooting.md)

Trois outils vous disent presque tout :

```sh
filarr-gate doctor          # une ligne par contrôle, sortie en 1 quand l'un échoue (ajoutez --json pour un programme)
curl -s http://127.0.0.1:8443/health
```

et l'écran **Journal** de l'interface de gestion (ou les fichiers `journal/<jour>.jsonl` du répertoire d'état), qui
note chaque requête servie, chaque échange avec Filarr et chaque geste, sans jeton, sans clé, sans contenu de ligne.

Chaque refus de l'API est `{ "error": "…", "code": "…" }` : cherchez le `code` dans [la référence des
codes](reference/errors.fr.md). Le message (`error`) est destiné aux humains, en français pour l'instant.

## La boîte noire ne démarre pas

| ce que vous voyez | pourquoi | que faire |
|---|---|---|
| `aucun jeton : lancez d'abord filarr-gate init --token flr_live_…` | pas encore de jeton | `filarr-gate init --token flr_live_…`, ou `FILARR_GATE_TOKEN`, ou ouvrez l'interface de gestion : l'écran de mise en route le demande |
| `EADDRINUSE` sur 8443 ou 8787 | un autre programme occupe le port | `FILARR_GATE_PORT=9443` (ou `--port` à `init`), `FILARR_GATE_ADMIN_PORT` pour l'interface |
| `une boîte noire tourne sur ce répertoire` à `init` | une boîte noire tourne déjà sur ce répertoire d'état | arrêtez-la d'abord, ou remplacez le jeton dans son interface (**Réglages**) |
| Docker : `EACCES` sur `/data` | l'image tourne sous l'utilisateur `node` ; un montage de dossier qui appartient à root n'est pas accessible en écriture | prenez un volume nommé (`-v filarr-gate:/data`), ou `chown 1000:1000` sur le dossier de l'hôte |
| `L'interface n'est pas construite : npm run build:ui` | une boîte noire lancée depuis les sources sans que l'interface soit construite | `npm run build` (il construit aussi l'interface) |
| `jeton refusé` au journal | Filarr a refusé le jeton au démarrage | voyez `doctor`, puis les états de la liaison ci-dessous |

## La liaison avec Filarr

`GET /health` rend `"link"` ; le tableau de bord et `doctor` l'affichent. Tant que la liaison est coupée, la boîte noire
continue de servir sa dernière copie complète : vos logiciels continuent de lire.

<!-- generated:link-states -->
| état | ce que cela veut dire | que faire |
|---|---|---|
| `no_token` | Pas encore de jeton. | Donnez son jeton à la boîte noire (écran de mise en route, `filarr-gate init`, ou `FILARR_GATE_TOKEN`). |
| `connecting` | Démarrage, ou reconnexion après une pause. | Rien : cela passe tout seul. |
| `live` | Le flux des changements est ouvert : un changement fait dans Filarr arrive à la boîte noire en une seconde environ. | Rien. |
| `polling` | Pas de flux en direct (palier Free, variante Cloudflare, ou flux refusé) : la boîte noire relève Filarr au rythme de son palier, et à chaque réveil poussé. | Rien. Pour aller plus vite sans flux, donnez à Filarr une adresse de réveil (`/_filarr/notify`). |
| `offline` | Filarr ne répond pas. La boîte noire continue de servir sa dernière copie et réessaie à intervalles de plus en plus espacés. | Vérifiez le réseau et le DNS de la machine ; `filarr-gate doctor` teste Filarr. |
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
<!-- /generated:link-states -->

## Une base manque, ou répond 503

- **Absente de la liste** (`base_not_found`, ou absente de `/openapi.json`) : l'accès ne l'ouvre pas. Vérifiez l'accès
  dans Filarr (**Paramètres › Accès API**). Une base qu'on vient d'ajouter à un accès apparaît une fois que Filarr a
  scellé sa clé et publié ses vues, ce qui se fait sur un appareil du créateur, déverrouillé.
- **Listée comme « Base sans manifeste »** sur l'écran **Bases et points d'accès** : ses vues ne sont pas encore
  publiées pour cet accès. Elles seront publiées la prochaine fois que sa note sera ouverte dans Filarr.
- **`503` avec `key_missing`** : Filarr a changé les clés de la base (une nouvelle génération, par exemple après la
  révocation d'un autre accès) et le créateur ne les a pas rescellées pour cet accès. Le créateur ouvre Filarr (bureau,
  web ou mobile), déverrouillé : les clés sont rescellées et la boîte noire rattrape son retard en quelques secondes.
  D'ici là, la boîte noire refuse de servir une copie partielle ; une base qu'elle servait déjà reste servie, avec
  l'en-tête `X-Gate-Base-Status: missing_key`.
- **`503` avec `base_loading`** : la première copie est en cours. Les grosses bases prennent quelques secondes.
- **Des relations rendent des identifiants bruts, un agrégat vaut `null`, `unresolved` liste des champs** : ils
  pointent vers une base qui n'est pas ouverte à cet accès. La boîte noire ne lit jamais une base qu'on ne lui a pas
  donnée. Ouvrez aussi cette base à l'accès.

## Vos logiciels sont refusés

| statut | code | la cause habituelle |
|---|---|---|
| 401 | `key_missing` | pas d'en-tête `Authorization: Bearer gk_…` (certains clients HTTP le retirent sur une redirection : appelez l'adresse finale) |
| 401 | `key_unknown` | une faute de frappe, ou une clé révoquée |
| 403 | `forbidden` | la clé n'ouvre pas cette base, cette vue, cette requête, le SQL ou MCP |
| 403 | `ip_forbidden` | la clé n'accepte que certaines adresses. Derrière un mandataire inverse, chaque requête semble venir du mandataire : réglez `FILARR_GATE_TRUST_PROXY` sur son adresse |
| 403 | `origin_forbidden` | une page web appelle l'API et son origine n'est pas dans `FILARR_GATE_CORS_ORIGINS` (fermé d'office) |
| 403 | `key_paused`, `key_expired` | reprenez la clé, ou créez-en une nouvelle |
| 404 | `view_not_found` | les slugs sont fixés à l'ouverture de la base ; une vue créée plus tard reçoit son slug à la publication suivante. `GET /openapi.json` les liste |
| 429 | `key_rate` | la limite de débit propre à la clé ; attendez `Retry-After` secondes, ou montez la limite de la clé |
| 429 | `api_rate`, `api_quota_*` | une limite de Filarr (plus bas) ; les lectures dans la copie ne sont jamais limitées |

## L'écriture est refusée

Écrire demande quatre choses, contrôlées dans cet ordre ; la première qui manque donne son code :

1. le réglage `write` de la boîte noire (`FILARR_GATE_WRITE=true`) : sinon `403 write_disabled` ;
2. Filarr ouvre l'écriture à l'accès (un palier qui comprend l'écriture par l'API, écriture allumée) : sinon
   `403 filarr_write_unavailable` ;
3. l'accès a la base en **lecture et écriture** : sinon `403 base_read_only` ;
4. la clé d'application a le droit d'ajouter, de modifier ou de supprimer dans cette base : sinon `403 forbidden`.

Ensuite :

- `409 field_managed`, `409 rows_managed` : une synchro externe alimente cette colonne, ou les lignes de cette base (un
  miroir). Changez la source, ou faites de la colonne une colonne à vous dans Filarr.
- `409 key_missing` : la boîte noire ne détient pas la clé de la génération en cours de la base. Le créateur ouvre
  Filarr, déverrouillé ; l'écriture reprend. Une écriture n'est jamais scellée sous une clé plus ancienne.
- `429 api_quota_writes` : les validations du jour du compte sont épuisées, jusqu'à 00:00 UTC. Une requête de 500
  lignes ne fait qu'une validation : groupez vos écritures.
- `503 filarr_unreachable` : rien n'a été écrit ; recommencez.

## Les webhooks n'arrivent pas

- La boîte noire doit joindre l'adresse : depuis un conteneur Docker, `localhost` est le conteneur lui-même.
- Répondez **2xx en moins de 10 secondes**. Tout le reste (une redirection comprise : elles ne sont pas suivies) est un
  échec. La boîte noire essaie 8 fois : tout de suite, puis au bout de 5, 10, 20, 40, 80, 160 et 320 minutes (un
  `Retry-After` de votre récepteur est respecté quand il est plus long). Ensuite, elle abandonne et le note au journal.
- Les livraisons en attente ne vivent qu'en mémoire (leurs corps portent des lignes en clair) : un redémarrage les
  abandonne, et le journal dit combien.
- **Signature refusée par votre récepteur** : calculez-la sur le corps BRUT, avant toute lecture du JSON, et comparez
  `HMAC-SHA256(secret, t + "." + corps)` ; vérifiez votre horloge (5 minutes de tolérance). Voyez
  [le tutoriel des webhooks](tutorials/webhooks.fr.md).
- L'interface de gestion propose les événements `row.created`, `row.updated`, `row.deleted` et `gate.quota`. La boîte
  noire envoie aussi `file.filed`, `sync.done` et `sync.failed`, mais seulement aux webhooks qui portent déjà ces
  événements (importés avec un paquet de réglages) : l'interface ne permet pas encore de les choisir.

## Synchros externes

Commencez par `filarr-gate sources list` : pour chaque synchro que Filarr confie à cette boîte noire, elle dit ce qui
la bloque.

- `extdb_key_missing` : donnez la clé (`filarr-gate sources key <id> --stdin`, l'écran **Sources**, la variable
  `FILARR_GATE_EXTDB_<ID>` qu'elle nomme, ou `gate.toml`). Une clé donnée à la boîte noire est chiffrée sous une clé
  tirée du jeton : après un remplacement du jeton, donnez-la de nouveau.
- `extdb_unsigned` : la définition a été changée par quelqu'un d'autre que le créateur de l'accès, ou la clé du
  créateur n'est pas authentifiée (un accès créé avant l'étiquette du créateur : remplacez son jeton dans Filarr).
- `extdb_lease_held` : un autre processus lancé avec le même jeton exécute cette synchro (deux conteneurs, par
  exemple). Une seule boîte noire par jeton.
- `extdb_guard` : le garde-fou. Trop de lignes seraient marquées ou supprimées d'un coup ; **rien n'a été écrit**.
  Vérifiez la source ; pour continuer, pour ce passage seulement, `filarr-gate sources run <id> --ack-guard <passage>`
  (le passage est dans la question que montre `sources run`), ou donnez votre accord dans Filarr.
- `extdb_conflict_burst` : trop de nouveaux conflits d'un coup ; vérifiez le sens et la clé de ligne. Sur un premier
  passage, `--initial source` ou `--initial filarr` le tranche.
- **Une ligne supprimée dans la source est encore dans Filarr** : les disparitions ne se voient qu'à une relecture
  COMPLÈTE, qui a lieu toutes les 24 heures ou tous les 96 passages quand la synchro a un repère (à chaque passage sans
  repère).
- **PostgreSQL ou MySQL depuis la variante Cloudflare** : impossible (pas de TCP) ; prenez la boîte noire Node ou
  Docker.

Tous les codes des synchros : [reference/errors.fr.md](reference/errors.fr.md#états-dune-synchro-externe).

## Fichiers

- `files_not_linked` : liez une boîte de dépôt à l'accès dans Filarr (palier Pro et plus).
- `creator_unauthenticated` : l'accès n'a pas d'étiquette du créateur (créé avant la révision 3) ou la clé du créateur
  ne se vérifie pas. Dans Filarr, bureau ou web, remplacez le jeton de l'accès.
- `box_not_signed` : liez de nouveau la boîte depuis Filarr, qui la signe.
- `file_type_refused` : un exécutable ou un script, par son extension ou par ses premiers octets ; refusé avant que
  rien ne parte.
- `box_full` : des dépôts attendent d'être rangés ; **ouvrez Filarr** sur un appareil qui range la boîte. Attendre ne
  suffit pas.

## Les limites de Filarr

La boîte noire ne compte jamais ses propres lectures. Ce que compte Filarr (requêtes de synchro, volume téléchargé,
validations, fichiers) et les limites de chaque palier se lisent chez Filarr : l'écran **Consommation et limites** de
l'interface de gestion les montre (d'après `GET /public/api-limits` et l'en-tête `X-Filarr-Quota`), tout comme
**Paramètres › Accès API** dans Filarr. Quand une limite est atteinte, la boîte noire continue de servir sa copie ;
seuls les téléchargements, les écritures ou les dépôts attendent. Voyez
[reference/limits.fr.md](reference/limits.fr.md).

## Les refus de Filarr, avec leur remède

Les codes de la révision 3 (boîte hébergée, fichiers, synchros externes) et le remède que Filarr attache à chacun, lus
dans les vecteurs `boite-noire-v2-serveur` sur lesquels le serveur de Filarr est éprouvé :

<!-- generated:filarr-codes -->
| code | statut | remède | ce qui s'est passé | que faire |
|---|---|---|---|---|
| `reauth_required` | 401 | `reauthenticate` | Confier une base à la boîte hébergée demande une preuve d'identité fraîche. | Filarr la demande à l'écran (mot de passe, code de double authentification ou clé d'accès). |
| `reauth_failed` | 401 |  | La preuve d'identité est fausse. | Recommencez ; après 10 essais en une heure, patientez. |
| `api_tier_hosted` | 403 | `upgrade` | La boîte hébergée demande le palier Pro ou plus. | Un palier supérieur, ou une boîte noire chez vous. |
| `hosting_forbidden` | 403 |  | L'organisation interdit les boîtes hébergées. | Voyez avec un administrateur de l'organisation, ou installez la boîte noire chez vous. |
| `hosting_not_switched` | 409 |  | La boîte hébergée n'est pas encore ouverte pour ce compte. | Rien à faire : elle s'ouvre compte par compte. |
| `consent_outdated` | 409 |  | Le texte de l'accord a changé depuis que vous l'avez accepté. | Filarr réaffiche le nouveau texte ; acceptez-le pour garder la base confiée. |
| `host_key_unknown` | 409 |  | Votre appli Filarr ne connaît pas la clé actuelle du service hébergé. | Mettez l'appli Filarr à jour. |
| `hosting_billing_unavailable` | 409 | `manageBilling` | Aucun abonnement Stripe ne peut porter l'option pour ce payeur. | Gérez la facturation dans Filarr, ou facturez l'organisation. |
| `hosting_exists` | 409 |  | Cet accès est déjà hébergé. | Rien ; pour changer l'endroit où il tourne, passez par la migration. |
| `consent_required` | 409 |  | Ajouter une base à un accès hébergé demande d'abord un accord pour cette base. | Acceptez l'accord pour elle dans Filarr, puis ajoutez-la. |
| `hosting_not_found` | 404 |  | Cet accès n'est pas hébergé. | Rien. |
| `migration_pending` | 409 |  | Une migration de cet accès est déjà en cours. | Terminez-la ou abandonnez-la dans Filarr. |
| `migration_not_ready` | 409 |  | La nouvelle boîte noire n'a pas encore importé son paquet de réglages. | Démarrez la nouvelle boîte noire avec son nouveau jeton, attendez l'import, puis basculez. |
| `hosting_too_large` | 413 |  | Les bases à confier sont trop lourdes pour une boîte hébergée. | Confiez-en moins, ou installez la boîte noire chez vous. |
| `hosting_asleep` | 403 | billing : `updatePayment` ; tier : `upgrade` ; policy : aucun ; consent : aucun ; service : aucun | La boîte hébergée est en sommeil (paiement, palier ou politique). `remedy` dit ce qui la réveille. | Voyez **Paramètres › Accès API** dans Filarr. |
| `hosted_origin_required` | 401 |  | Le jeton d'une boîte hébergée a été présenté hors du service hébergé. | Rien : c'est ce qui protège ce jeton. |
| `api_access_pending` | 403 |  | Une identité neuve, en attente de migration, a appelé autre chose que `self` ou son import. | Terminez la migration dans Filarr. |
| `api_tier_files` | 403 | `upgrade` | Recevoir des fichiers par l'API demande le palier Pro ou plus. | Un palier supérieur. |
| `files_not_switched` | 409 |  | Les fichiers par l'API ne sont pas encore ouverts pour ce compte. | Rien : ils s'ouvrent compte par compte. |
| `files_not_linked` | 409 |  | Aucune boîte de dépôt n'est liée à l'accès. | Liez une boîte de dépôt dans Filarr. |
| `box_not_permanent` | 409 |  | La boîte liée à l'accès n'est pas une boîte de dépôt permanente. | Liez une boîte permanente (Filarr en crée une pour vous). |
| `box_not_found` | 404 |  | La boîte de dépôt liée n'existe plus. | Liez-en une autre dans Filarr. |
| `deposit_not_found` | 404 |  | Filarr ne connaît pas ce dépôt. | Vérifiez l'identifiant. |
| `box_full` | 409 |  | Trop de dépôts attendent dans la boîte d'être rangés. | Ouvrez Filarr pour les ranger. |
| `box_storage_full` | 413 |  | Les dépôts en attente dans la boîte prennent trop de place. | Ouvrez Filarr pour les ranger. |
| `file_too_large` | 413 |  | Le fichier dépasse la taille que Filarr accepte (`limit`). | Envoyez un fichier plus petit. |
| `api_quota_files` | 429 | `wait` (avec `Retry-After`) | Le compte a déposé ce mois-ci autant de fichiers que son palier le permet. | Attendez le mois suivant. |
| `api_quota_file_bytes` | 429 | `wait` (avec `Retry-After`) | Le compte a déposé ce mois-ci autant d'octets de fichiers que son palier le permet. | Attendez le mois suivant. |
| `ext_status_conflict` | 409 |  | Deux rédacteurs ont publié l'état d'une synchro en même temps. | Rien. |
| `ext_queue_conflict` | 409 |  | Deux rédacteurs ont publié la file des conflits d'une synchro en même temps. | Rien. |
| `ext_resolve_full` | 409 |  | Trop de décisions attendent l'exécutant de la synchro. | Vérifiez que la boîte noire qui exécute la synchro tourne : elle lit les décisions à son passage suivant. |
| `extdb_lease_held` | 409 | `wait` (avec `Retry-After`) | Un autre processus tient le bail de cette synchro (deux boîtes noires lancées avec le même jeton). | Une seule boîte noire par jeton : arrêtez l'autre instance. |
| `extdb_relay_off` | 409 |  | Web seulement : le relais de Filarr pour les bases externes est éteint. | Lancez la synchro depuis l'appli de bureau ou une boîte noire. |
<!-- /generated:filarr-codes -->

## Toujours bloqué

Ouvrez une issue avec la sortie de `filarr-gate doctor --json` et les lignes du journal autour du problème (ni l'une ni
les autres ne contiennent de jeton, de clé ni de ligne). Un problème de sécurité passe par
[SECURITY.md](../SECURITY.md), jamais par une issue publique.
