# L'API locale

[Read in English](api.md)

Chaque boîte noire sert cette API depuis sa copie déchiffrée des bases ouvertes à son accès. Les routes communes à
toutes les boîtes noires sont décrites en OpenAPI 3.1 dans
[../openapi/filarr-gate.v1.json](../openapi/filarr-gate.v1.json) (description vérifiée route par route par la suite
d'essais, face à une boîte noire en marche) ; chaque boîte noire sert sa description EXACTE à `/openapi.json`, avec ses
bases, ses champs typés, ses vues et ses requêtes enregistrées, et une page lisible à `/docs`.

Tutoriel : [appeler l'API](../tutorials/first-calls.fr.md). Codes : [errors.fr.md](errors.fr.md).

## L'authentification

Chaque appel à `/v1/*` et à `/mcp` porte une **clé d'application** : `Authorization: Bearer gk_…` (ou `X-Gate-Key:
gk_…`). Les clés d'application se créent sur la boîte noire (interface de gestion, **Clés des applications**, ou
`filarr-gate keys create`), s'affichent une fois, et sont gardées en empreinte SHA-256. Chaque clé a :

| propriété | |
|---|---|
| points d'accès | toutes les bases et vues (lecture), ou des bases choisies (lecture, ajout, modification, suppression), des vues, des requêtes enregistrées, et la fente à fichiers |
| SQL, MCP | le droit d'appeler `/v1/sql` (sur les bases qu'elle lit), et `/mcp` |
| débit | des requêtes par minute (600 par défaut) : au-delà, `429 key_rate` avec `Retry-After` |
| adresses autorisées | des adresses IP ou des plages CIDR ; les autres reçoivent `403 ip_forbidden`. Derrière un mandataire inverse, réglez `trust_proxy` |
| échéance | passé ce jour, `403 key_expired` |
| pause | `403 key_paused` jusqu'à la reprise |

`/health` et `/metrics` ne demandent pas de clé ; `/openapi.json` et `/docs` non plus, tant que le réglage `docs` est
allumé (c'est le cas par défaut).

## Les routes

| méthode et chemin | |
|---|---|
| `GET /v1/<base>` | les lignes d'une base (aussi `GET /v1/<base>/rows`) |
| `GET /v1/<base>/<vue>` | une vue, rejouée par le moteur de vues de Filarr |
| `GET /v1/<base>/rows/<id>` | une ligne : `{ row, version, unresolved? }` |
| `POST /v1/<base>` | créer une ligne (objet) ou plusieurs (tableau, 500 au plus) |
| `PATCH /v1/<base>/rows/<id>` | changer des champs d'une ligne (aussi `PATCH /v1/<base>/<id>`) |
| `DELETE /v1/<base>/rows/<id>` | supprimer une ligne (aussi `DELETE /v1/<base>/<id>`) |
| `POST /v1/sql` | une requête SQL en lecture seule |
| `GET /v1/q/<requête>` | une requête enregistrée, les lignes en objets |
| `POST /v1/files`, `GET /v1/files/<id>` | déposer un fichier, son état ([fichiers](../tutorials/receive-files.fr.md)) |
| `POST /mcp` | le serveur MCP ([mcp.fr.md](mcp.fr.md)) |
| `GET /openapi.json`, `GET /docs` | la description de cette boîte noire |
| `GET /health` | `{ status: "ok" \| "degraded", link, version, bases: [{ slug, status, version }] }` |
| `GET /metrics` | métriques Prometheus (plus bas) |
| `POST /_filarr/notify` | les réveils poussés de Filarr (pas pour vos logiciels) |

`<base>` et `<vue>` sont des **slugs** : choisis dans Filarr à l'ouverture de la base, puis gardés même quand la base ou
la vue est renommée. Une vue créée plus tard reçoit son slug quand Filarr la publie.

## Les lignes en JSON

```json
{ "id": "r_acme", "nom": "Acme", "ville": "Lyon", "statut": "Client", "ca": 12500, "dernier_contact": "2026-10-03",
  "commandes": ["r_c1", "r_c3"], "total_commande": 1540.5, "created_at": "2026-09-01T08:00:00.000Z", "updated_at": "…" }
```

- **Les noms de champs** suivent les noms des colonnes : minuscules, sans accents, `_` entre les mots, 48 caractères au
  plus, un chiffre en tête préfixé de `c_` ; une deuxième colonne du même nom reçoit `_2`. `id`, `created_at` et
  `updated_at` sont réservés. La boîte noire en mode serveur **garde** un nom une fois donné : renommer une colonne dans
  Filarr ne le change pas. (La bibliothèque calcule les noms à chaque démarrage.)
- **Les valeurs**, selon le type de la colonne dans Filarr :

| type Filarr | JSON | s'écrit |
|---|---|---|
| texte, URL, e-mail, téléphone | chaîne ou `null` | une chaîne |
| nombre, note, progression | nombre ou `null` | un nombre |
| case à cocher | `true` / `false` | un booléen |
| sélection | le libellé de l'option, ou `null` | un libellé (ou un identifiant d'option) de la colonne |
| sélection multiple | tableau de libellés | un tableau de libellés |
| date | `"AAAA-MM-JJ"` (ou une date et heure) | `AAAA-MM-JJ`, ou une date et heure ISO |
| relation | tableau d'identifiants de lignes | un tableau d'identifiants de lignes (un au plus pour une relation simple) |
| personne | tableau de noms | un tableau de noms |
| fichier du coffre | `{ fileId, folderId, name }` | le même objet |
| formule, agrégat, date de création, date de modification, lien retour | calculé | lecture seule (`400 field_read_only`) |

- **Les relations vers une base non ouverte à l'accès** rendent les identifiants bruts ; un agrégat sur elle rend
  `null` ; le champ est listé dans `unresolved` de la page.

## La lecture

| paramètre | |
|---|---|
| `champ=valeur` | égal |
| `champ[op]=valeur` | `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains`, `in`, `empty` |
| `sort=a,-b` | clés de tri ; `-` pour l'ordre décroissant ; valeurs vides en dernier |
| `fields=a,b` | les champs rendus (`id` toujours) |
| `q=texte` | recherche rapide dans le texte, comme dans Filarr |
| `limit` | 100 par défaut, 1000 au plus |
| `cursor` | le `next` de la page précédente |
| `since=<version>` | seulement les lignes changées après cette version |

Comment comparent les filtres :

- les textes : sans tenir compte de la casse ni des accents (`ville=lyon` trouve « Lyon ») ; `contains` cherche à
  l'intérieur ;
- les nombres : comme des nombres (`ca[gte]=1000`) ; les booléens : `1`, `true`, `yes`, `oui` sont vrais ;
- les listes (sélection multiple, relations, personnes) : `eq` et `contains` trouvent un élément, `ne` aucun, `in`
  n'importe laquelle des valeurs ;
- `in` : valeurs séparées par des virgules ; `empty=true` trouve `null`, `""` et `[]`, `empty=false` le reste.

Une page est `{ rows, next, total, version, unresolved? }`. `next` est un décalage (`o200`) : des lignes ajoutées entre
deux pages peuvent le déplacer ; pour suivre les changements, employez `version` et `since`, ou les webhooks.

Une vue (`GET /v1/<base>/<vue>`) applique d'abord ses propres filtres, son tri et ses colonnes visibles, puis les
paramètres ci-dessus. Une vue Requête (SQL) rend son résultat en objets (`columns` aussi) et ne prend que `limit` et
`cursor`.

## Le SQL

`POST /v1/sql` avec `{ "sql": "SELECT …" }` (dialecte SQLite, moteur SQL de Filarr, `SELECT` et `WITH … SELECT`
seulement) rend `{ columns, rows, ms, scanned, truncated }`, les lignes en tableaux, 10 000 au plus. Les tables sont
celles de la vue Requête de Filarr : une par base, nommée d'après son titre (minuscules, sans accents, `_` entre les
mots), une colonne par colonne (colonnes calculées laissées de côté), une relation simple comme clé étrangère
`<relation>_id`, une multiple comme table de liaison ; une base non ouverte apparaît avec son seul `id`. La clé ne lit
que les bases qu'elle a le droit de lire.

**Les requêtes enregistrées** (interface de gestion, **Explorateur SQL › Enregistrer comme point d'accès**) se servent
à `GET /v1/q/<slug>`, les lignes en objets, avec `limit` et `cursor`, aux clés autorisées à les lire.

## L'écriture

Écrire demande : le réglage `write` de la boîte noire (éteint d'office), la base en lecture et écriture sur l'accès, un
palier qui comprend l'écriture par l'API, et une clé d'application qui a le droit d'ajouter, de modifier ou de
supprimer dans cette base.

- `POST /v1/<base>` : un objet crée une ligne ; un tableau en crée jusqu'à 500 en **une validation**. Les colonnes
  omises reçoivent leur valeur par défaut (l'option par défaut d'une sélection), comme le fait « Nouvelle ligne » dans
  Filarr ; un champ donné à `null` reste vide. Réponse `201` : `{ id, row, version, validated: true }` (ou
  `{ rows, version, validated: true }` pour un tableau).
- `PATCH /v1/<base>/rows/<id>` : change les champs donnés ; un champ mis à `null` est vidé. Réponse `{ id, row, version,
  validated }`.
- `DELETE /v1/<base>/rows/<id>` : `{ id, deleted: true, version, validated }`. Une suppression l'emporte sur une
  modification concurrente ; la ligne peut être restaurée dans Filarr.
- **`Idempotency-Key`** : la même clé, la même clé d'application, la même méthode et le même chemin dans les 24 heures
  rendent la première réponse (`Idempotency-Replayed: true`) et n'écrivent rien. Gardée en mémoire.
- Chaque écriture suit « le dernier rédacteur l'emporte », cellule par cellule, horodatée par l'horloge de la boîte
  noire, validée dans Filarr comme l'écriture de n'importe quel appareil. Sur une écriture concurrente, la boîte noire
  relit et rejoue, sans que cela se voie.
- Colonnes alimentées par une source externe : `409 field_managed` ; base en miroir : `409 rows_managed`.
- `validated: true` veut dire que Filarr a accepté la validation. `503 filarr_unreachable` veut dire que rien n'a été
  écrit.

Les restrictions à certaines colonnes ou à une vue sont appliquées par la boîte noire (les points d'accès de la clé
d'application), pas par le chiffrement : la clé de l'accès ouvre toute la base.

## Les en-têtes

| en-tête | |
|---|---|
| `X-Filarr-Version` | la version de la base servie (réponses de `/v1/<base>…`) |
| `X-Gate-Base-Status` | présent quand la base est servie depuis sa dernière copie complète alors que quelque chose ne va pas (`missing_key`…) |
| `Retry-After` | sur un `429` : les secondes à attendre |
| `Idempotency-Replayed: true` | une réponse rejouée |
| `Cache-Control: no-store` | sur chaque réponse |

## Le CORS

Fermé d'office : une requête qui porte un en-tête `Origin` est refusée (`403 origin_forbidden`) sauf si l'origine est
dans `cors_origins`. Les origines autorisées reçoivent `Access-Control-Allow-Origin`, les méthodes
`GET, POST, PATCH, DELETE, OPTIONS`, et les en-têtes `Authorization`, `Content-Type`, `Idempotency-Key`, `X-Gate-Key`,
`X-File-Name`, `Mcp-Session-Id`, `Mcp-Protocol-Version`. Une clé employée depuis une page web est visible de quiconque
ouvre la page : ne lui donnez que ce que la page doit faire (voyez [examples/public-form](../../examples/public-form)).

## Les métriques

`GET /metrics` (format texte Prometheus, le réglage `metrics`, allumé d'office) :

| métrique | |
|---|---|
| `filarr_gate_requests_total{route,code}` | requêtes servies par l'API locale |
| `filarr_gate_request_duration_seconds{route}` | leur durée (histogramme) |
| `filarr_gate_webhook_deliveries_total{result}` | livraisons de webhooks : `ok`, `retry`, `abandoned` |
| `filarr_gate_filarr_requests_total{code}` | requêtes envoyées à Filarr |
| `filarr_gate_commits_total`, `filarr_gate_commit_conflicts_total` | validations acceptées par Filarr, et conflits rejoués |
| `filarr_gate_rows_changed_total{base}` | lignes changées, par base |
| `filarr_gate_files_total{result}` | fichiers déposés, refusés avant l'envoi, refusés par Filarr |
| `filarr_gate_link_up` | 1 quand la liaison avec Filarr est en direct ou en relève |
| `filarr_gate_base_rows{base}`, `filarr_gate_base_version{base}`, `filarr_gate_base_ready{base}` | par base |
| `filarr_gate_quota_used{name}`, `filarr_gate_quota_max{name}` | les compteurs de Filarr (`sync`, `bytes`, `writes`) |

Les métriques ne contiennent jamais de ligne, de clé ni de jeton. `/metrics` n'a pas de clé : gardez l'API sur un réseau
de confiance, ou éteignez-les (`metrics = false`).

## Les limites de l'API locale

| | |
|---|---|
| corps JSON | 4 Mio |
| lignes par création | 500 |
| lignes par page | 1000 |
| SQL | 64 Kio de requête, 10 000 lignes rendues |
| fichier | la taille que permet Filarr, jamais au-dessus de 100 Mio, moins si `files_max_bytes` le dit |

Ce que compte Filarr, et comment la boîte noire réagit à chaque limite : [limits.fr.md](limits.fr.md).
