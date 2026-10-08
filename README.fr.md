# Filarr Gate

**Servir une base Filarr comme une API, sans que Filarr voie jamais vos données.**

[Read in English](README.md)

> **État : v0.1, en avance sur le serveur.** La boîte noire suit le contrat gelé `api-base-1` (révision 2) et le
> protocole des magasins `db-store-1` (révision 3.9). Le côté Filarr est construit et a été éprouvé de bout en bout avec
> cette boîte noire contre un serveur Filarr local (lecture, changements en direct, écriture, révocation), mais il
> n'est pas encore en service (`API_BASE_SWITCH`, `API_BASE_WRITE` éteints) ; il s'ouvrira compte par compte. D'ici là,
> essayez la boîte noire contre le Filarr en mémoire fourni dans ce dépôt (voir [Essayer sur sa machine](#essayer-sur-sa-machine)).

Filarr chiffre vos notes et vos bases de bout en bout : ses serveurs gardent des blocs qu'ils ne savent pas lire.
Pas de « clé d'API chez l'éditeur », donc. Filarr Gate prend le chemin inverse : une petite **boîte noire que vous
faites tourner vous-même** (sur votre PC, dans Docker, sur votre serveur). Elle tient la clé des seules bases que vous
lui ouvrez, en garde une copie déchiffrée en mémoire, et sert vos logiciels sur place.

```
 Filarr ──(blocs chiffrés)──▶ serveurs Filarr ──(blocs chiffrés)──▶ Filarr Gate ──(JSON en clair)──▶ ERP, BI, site, agent IA
                                ne voient rien                       chez vous
```

## Ce qu'elle fait

- **Une vue, un point d'accès.** Chaque base devient `GET /v1/<base>`, et chacune de ses vues `GET /v1/<base>/<vue>`,
  rejouée par le moteur de vues de Filarr lui-même (filtres, tris, colonnes affichées). Les slugs sont posés par
  l'application à l'ouverture de la base : renommer une vue ne casse aucune intégration.
- **SQL en lecture.** `POST /v1/sql` exécute un `SELECT` avec le moteur SQL de Filarr (sémantique de SQLite,
  jointures, regroupements) sur les bases que la clé peut lire. Une requête enregistrée devient `GET /v1/q/<nom>`.
- **OpenAPI 3.1** tirée des types des colonnes (`/openapi.json`, lisible sur `/docs`).
- **Webhooks signés.** Une ligne est ajoutée, modifiée ou supprimée dans Filarr : la boîte noire la déchiffre et
  appelle votre adresse, signée en HMAC-SHA256 (`Filarr-Gate-Signature: t=…,v1=…`), 8 essais en 24 h avec un délai
  doublé. Un webhook peut suivre une vue, filtrer par une condition SQL, ne partir que quand la condition *devient*
  vraie, et résoudre les relations.
- **Clés des applications.** Vos logiciels n'ont jamais le jeton Filarr : chacun reçoit sa clé (`gk_…`, gardée en
  empreinte), limitée à des bases, des vues ou des requêtes, en lecture ou en ajout/modification/suppression, avec un
  débit maximal, des adresses autorisées et une échéance.
- **Écriture** (éteinte d'office) : `POST`, `PATCH`, `DELETE` sur `/v1/<base>[/rows/<id>]` deviennent des registres
  « dernier écrit gagne », scellés et validés chez Filarr en compare-and-swap, comme sur n'importe quel appareil.
- **Serveur MCP** pour les assistants IA (HTTP sur `/mcp`, et stdio avec `filarr-gate mcp`), en lecture seule.
- **Métriques Prometheus** sur `/metrics`, une sonde sur `/health`, un journal local (JSON Lines, 30 jours).
- **Une interface de gestion complète** (français et anglais) : premier lancement, tableau de bord, bases et points
  d'accès, explorateur SQL, clés des applications, webhooks, journal, consommation et limites, réglages.

## Installer

Node.js 20 ou plus récent.

```sh
# depuis npm (une fois le paquet publié)
npx filarr-gate

# depuis les sources
git clone <ce dépôt> filarr-gate && cd filarr-gate
npm ci && npm run build
node dist/cli.js
```

Ouvrez ensuite l'interface de gestion sur <http://127.0.0.1:8787/admin/> et suivez les trois étapes : collez le jeton
montré par Filarr (« ··· » › « Ouvrir à une API » sur une base), choisissez où l'API écoute, posez un mot de passe
d'administration.

Sans interface :

```sh
filarr-gate init --token flr_live_… --port 8443 --admin-password '…'
filarr-gate                       # démarrer
filarr-gate keys create --name ERP --sql   # une clé en lecture sur toutes les vues, montrée une fois
```

### Docker

```sh
docker build -t filarr-gate .
docker run -d --name filarr-gate \
  -e FILARR_GATE_TOKEN=flr_live_… \
  -e FILARR_GATE_ADMIN_PASSWORD='un long mot de passe' \
  -p 8443:8443 -p 127.0.0.1:8787:8787 \
  -v filarr-gate:/var/lib/filarr-gate \
  filarr-gate
```

L'image tourne sous l'utilisateur `node` (pas root), garde son état dans le volume `/var/lib/filarr-gate` et porte un
`HEALTHCHECK` sur `/health`. Publiez le port de gestion sur `127.0.0.1` seulement. Si vous passez par l'interface plutôt
que par l'environnement, la première mise en route demande le code affiché par `docker logs filarr-gate`.

### Cloudflare (plus tard)

Une variante « sur votre propre compte Cloudflare » (un Worker et un Durable Object qui tient la copie) est prévue.
Elle n'est pas encore construite.

## Réglages

Les variables d'environnement l'emportent sur `gate.toml` (dans le répertoire d'état, ou `FILARR_GATE_CONFIG`), qui
l'emporte sur ce qui est réglé dans l'interface. Un réglage fixé par l'environnement ou le fichier apparaît verrouillé
dans l'interface.

| variable | `gate.toml` | d'office | |
|---|---|---|---|
| `FILARR_GATE_TOKEN` | — | — | le jeton d'accès ; gardé en mémoire seulement, jamais écrit sur le disque |
| `FILARR_GATE_STATE_DIR` | — | `~/.filarr-gate` | l'état : jeton (0600), `state.json` (0600), cache des blocs chiffrés, journal |
| `FILARR_GATE_API_URL` | `api_url` | `https://api.filarr.com` | l'API Filarr (un worker local pour les essais) |
| `FILARR_GATE_HOST` / `_PORT` | `host` / `port` | `127.0.0.1` / `8443` | l'API locale |
| `FILARR_GATE_ADMIN_HOST` / `_PORT` | `admin_host` / `admin_port` | `127.0.0.1` / `8787` | l'interface de gestion |
| `FILARR_GATE_ADMIN_PASSWORD` | — | — | mot de passe d'administration sans interface |
| `FILARR_GATE_WRITE` | `write` | `false` | l'écriture vers Filarr (§ 7 du contrat) |
| `FILARR_GATE_TLS_CERT` / `_KEY` | `tls_cert` / `tls_key` | — | HTTPS de l'API locale (chemins PEM) |
| `FILARR_GATE_CORS_ORIGINS` | `cors_origins` | aucune | pages web autorisées ; les autres sont refusées |
| `FILARR_GATE_TRUST_PROXY` | `trust_proxy` | aucun | mandataires dont on croit `X-Forwarded-For` |
| `FILARR_GATE_METRICS` / `_MCP` / `_DOCS` | `metrics` / `mcp` / `docs` | oui / non / oui | `/metrics`, `/mcp`, `/docs` et `/openapi.json` publics |
| `FILARR_GATE_JOURNAL_DAYS` | `journal_days` | `30` | retenue du journal local |
| `FILARR_GATE_CACHE` | `cache` | `disk` | `memory` : rien sur le disque, pas même les blocs chiffrés |
| `FILARR_GATE_POLL_SECONDS` | `poll_seconds` | `300` | relève sans le flux en direct (jamais sous 300) |

## Essayer sur sa machine

Le dépôt fournit le Filarr en mémoire des essais : il sert les routes du contrat destinées à la boîte noire, avec trois
bases de démonstration, et fait un geste de l'application toutes les 20 secondes.

```sh
npm ci
npm run mock-filarr                     # affiche un jeton ; MOCK_TIER=free pour le palier Free
FILARR_GATE_API_URL=http://127.0.0.1:8790 FILARR_GATE_TOKEN=flr_live_… npm start
```

Pour éprouver le vrai worker : `wrangler dev` dans le worker de Filarr, `API_BASE_SWITCH` (et `API_BASE_WRITE`)
allumés pour le compte d'essai, un accès créé depuis l'application, et `FILARR_GATE_API_URL` vers le worker local.
`wrangler dev` écoute sur 8787 d'office : déplacez l'interface de gestion avec `FILARR_GATE_ADMIN_PORT`.

## L'API en bref

Chaque appel `/v1` porte une clé d'application : `Authorization: Bearer gk_…`.

| route | |
|---|---|
| `GET /v1/<base>` | les lignes : `limit` (≤ 1000), `cursor`, `fields=a,b`, `sort=a,-b`, `q=texte`, `since=<version>`, filtres `champ=valeur` ou `champ[op]=valeur` (`eq ne lt lte gt gte contains in empty`) |
| `GET /v1/<base>/<vue>` | la vue rejouée par le moteur de Filarr (une vue Requête rend son résultat SQL) |
| `GET /v1/<base>/rows/<id>` | une ligne |
| `POST /v1/<base>` | ajouter une ligne (objet) ou plusieurs (tableau, ≤ 500) ; `Idempotency-Key` respecté |
| `PATCH /v1/<base>/rows/<id>` | modifier des champs (`null` vide) |
| `DELETE /v1/<base>/rows/<id>` | supprimer (la suppression l'emporte sur une modification concurrente, comme dans Filarr) |
| `POST /v1/sql` | `{ "sql": "SELECT …" }`, en lecture seule (`400 sql_read_only` sinon) |
| `GET /v1/q/<requête>` | une requête enregistrée |
| `GET /openapi.json`, `GET /docs` | la description |
| `POST /mcp` | MCP (JSON-RPC) : `list_bases`, `query_view`, `get_row`, `run_sql` |
| `GET /health`, `GET /metrics` | sonde et Prometheus |

Une ligne vaut `{ "id", <champs>, "created_at", "updated_at" }`. Le nom d'un champ suit la colonne (`Dernier contact`
→ `dernier_contact`) et reste le même quand la colonne est renommée. Une sélection rend le libellé de l'option, une
relation les identifiants des lignes, un agrégat ou une formule la valeur calculée par le moteur de Filarr. Une
relation vers une base que le jeton n'ouvre pas rend les identifiants bruts, et ses agrégats valent `null`, cités dans
`unresolved` (contrat § 8). Une liste répond `{ rows, next, total, version }`.

Une livraison de webhook est un `POST` avec `Filarr-Gate-Event`, `Filarr-Gate-Delivery` et
`Filarr-Gate-Signature: t=<secondes>,v1=<hex>`, où `v1 = HMAC-SHA256(secret, t + "." + corps brut)`. Vérifiez sur le
corps brut, et refusez un horodatage de plus de 5 minutes.

## La sécurité, en bref

- Un jeton d'accès n'ouvre **que les bases choisies**, jamais le compte, les notes ni les fichiers. Le jeton ne
  quitte pas la boîte noire : elle en dérive sur place `A_auth` (la preuve que Filarr compare à une empreinte) et
  `A_enc` (la clé qui ouvre les clés des bases scellées), puis efface le secret de sa mémoire.
- Chaque clé de base scellée est vérifiée à sa place (accès, magasin, époque, génération) avant usage ; une clé
  trouvée ailleurs est refusée, jamais utilisée. Chaque bloc est vérifié contre l'empreinte de la tête avant d'être
  déchiffré.
- Les lignes déchiffrées vivent en mémoire seulement. Le disque garde les blocs chiffrés (tels que Filarr les garde),
  le jeton (0600), les empreintes des clés des applications et les secrets des webhooks. À la révocation, tout est
  effacé, cache compris.
- Révoquer un accès coupe tout de suite au serveur, et les clés des bases passent à une nouvelle génération : un jeton
  révoqué ne lit rien de ce qui s'écrit ensuite. Une clé absente s'affiche « clé manquante pour (e, g) » ; un bloc
  n'est jamais sauté.
- Une boîte noire lit les bases entières : une vue est un confort, pas une frontière cryptographique. La machine qui
  la fait tourner, et qui détient le mot de passe de gestion, détiennent les données.

Détails : [docs/architecture.md](docs/architecture.md).

## Paliers et limites

Filarr Gate fonctionne à tous les paliers Filarr, Free compris. Filarr ne compte que ce qui passe par ses serveurs
(requêtes de synchro, volume descendu, validations acceptées) ; les lectures servies par votre boîte noire ne sont
jamais comptées. Les limites sont publiées par Filarr sur `/public/api-limits` et montrées dans l'écran
« Consommation et limites » ; en Free, pas de flux en direct : la boîte noire relève toutes les 300 secondes. Une
limite atteinte, la boîte noire sert sa dernière copie et respecte `Retry-After`.

## Développement

```sh
npm test            # vitest : vecteurs dorés des deux contrats, réplique, API locale, traductions de l'interface
npm run typecheck
npm run build       # dist/cli.js (esbuild) et dist/ui (Vite + Preact)
```

`src/core` est une copie à l'identique du cœur portable de Filarr (chiffrement et codec du magasin, registres, moteur
de vues, moteur SQL), relicenciée Apache-2.0 par le titulaire des droits ; `src/core/PROVENANCE.json` cite chaque
fichier et son commit d'origine, et `scripts/copy-core.mjs` la renouvelle. Seuls les imports de plateforme de deux
fichiers pointent vers de petites cales.

## Licence

[Apache-2.0](LICENSE). Voir [NOTICE](NOTICE).

## Sécurité

Signalez une faille en privé : voir [SECURITY.md](SECURITY.md).
