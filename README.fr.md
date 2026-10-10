# Filarr Gate

**Servir une base Filarr comme une API, sans que Filarr voie jamais vos données.**

[Read in English](README.md)

> **État : v0.2, en avance sur le serveur.** La boîte noire suit les contrats gelés `api-base-1` (révisions 2 et 3),
> `db-store-1` (3.9), `gate-fichiers-1`, `source-externe-1` et le paquet de réglages de `gate-heberge-1`. Elle est
> éprouvée de bout en bout contre un serveur Filarr local (lecture, changements en direct, écriture, révocation, une
> synchro PostgreSQL externe, un dépôt de fichier, la variante Cloudflare). Le côté Filarr est fusionné mais éteint
> (`API_BASE_SWITCH`, `GATE_FILES_SWITCH`…) ; il s'ouvre compte par compte. Rien n'est encore publié (ni npm, ni image).

Filarr chiffre vos notes et vos bases de bout en bout : ses serveurs gardent des blocs qu'ils ne savent pas lire.
Filarr Gate est une petite **boîte noire que vous faites tourner vous-même** (dans votre code, sur un PC, dans Docker,
sur votre compte Cloudflare) : elle tient la clé des bases que vous lui ouvrez, en garde une copie déchiffrée en
mémoire, et sert vos logiciels.

```
 Appli Filarr ──(blocs chiffrés)──▶ serveurs Filarr ──(blocs chiffrés)──▶ Filarr Gate ──(JSON en clair)──▶ votre ERP, BI, site, agent IA
                                       ne voient rien                     chez vous
```

Dans Filarr : « ··· » sur une base › **Ouvrir à une API** donne un jeton (`flr_live_…`), montré une fois.

## Quatre façons de la faire tourner

### 1. Dans votre code : `@filarr/gate`

```js
import { openGate } from '@filarr/gate';

const gate = await openGate({ token: process.env.FILARR_GATE_TOKEN });
const actifs = await gate.base('clients').view('clients-actifs').rows();
```

Node 20+ (éprouvé) ; seulement des API web standard (WebCrypto, `fetch`, WebSocket) : Deno, Bun et Workers devraient
la faire tourner, sans essai là. Deux petites dépendances (`@noble/*`, `fflate`). `rows()`, `row(id)`,
`view(slug).rows()`, `sql()`, `insert()`/`update()`/`delete()` (avec `write: true`), `on('change')`,
`files.deposit()`, `status()`, `close()`. L'exemple complet, [examples/library-node](examples/library-node/index.mjs),
tourne dans les essais.

### 2. Sur une machine : `filarr-gate`

```sh
npx filarr-gate init --token flr_live_… --admin-password '<dix caractères au moins>'
npx filarr-gate                                  # API locale sur 127.0.0.1:8443, interface sur http://127.0.0.1:8787/admin/
npx filarr-gate keys create --name ERP --sql     # une clé d'application, montrée une fois
```

Depuis les sources : `npm ci && npm run build`, puis `node packages/cli/dist/cli.js` au lieu de `npx filarr-gate`.

### 3. Dans Docker

```sh
docker build -t filarr-gate .
docker run -d --name filarr-gate -e FILARR_GATE_TOKEN=flr_live_… -p 8443:8443 -v filarr-gate:/data filarr-gate
docker exec filarr-gate filarr-gate keys create --name ERP
```

L'image tourne sous un utilisateur non root, garde tout dans le volume `/data` et a une sonde de santé. (Sa
construction n'est pas encore jouée par les essais ; les mêmes étapes de construction et de lancement le sont.) Ajoutez
`-p 127.0.0.1:8787:8787 -e FILARR_GATE_ADMIN_PASSWORD=…` pour l'interface de gestion (qui y entre lit les données).

### 4. Sur votre compte Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/matbel91765/filarr-gate)

Ou à la main : `npm ci && npm run build && npx wrangler deploy`, puis `npx wrangler secret put FILARR_GATE_TOKEN` et
`npx wrangler secret put FILARR_GATE_ADMIN_PASSWORD`. Un Worker et un objet durable tiennent la copie ; l'API est
l'adresse du Worker, l'interface vit sous `/admin/`. Voir [docs/cloudflare.md](docs/cloudflare.md).

## Ce qu'elle fait

- **Des points d'accès tirés des vues.** `GET /v1/<base>` et `GET /v1/<base>/<vue>`, rejoués par le moteur de vues
  de Filarr ; les slugs sont fixés par l'appli : renommer une vue ne casse aucune intégration. `POST /v1/sql` (lecture
  seule, moteur SQL de Filarr), requêtes enregistrées, OpenAPI 3.1 (`/openapi.json`, `/docs`).
- **Des clés d'application.** Vos logiciels n'ont jamais le jeton Filarr : chacun reçoit sa clé `gk_…` (gardée en
  empreinte), limitée à des bases, des vues, des requêtes ou à la fente à fichiers, avec débit, adresses et expiration.
- **L'écriture** (éteinte d'office) : `POST`, `PATCH`, `DELETE` deviennent des registres validés chez Filarr.
- **Des webhooks signés** sur les lignes, les fichiers rangés et les synchros (HMAC-SHA256, essais pendant 24 h).
- **La fente à fichiers** (`POST /v1/files`) : chaque fichier est scellé pour la boîte de dépôt que le créateur a liée
  et signée dans Filarr ; exécutables et fichiers trop lourds sont refusés avant que rien ne parte. L'appli Filarr les
  range ; ni Filarr ni la boîte noire ne savent où.
- **Les bases externes** : les synchros que Filarr confie à cette boîte (D1, PostgreSQL, MySQL, Supabase, Airtable,
  Google Sheets, Notion, CSV/JSON) tournent ici, avec vos clés, qui ne vont jamais chez Filarr. Voir
  [docs/external-databases.md](docs/external-databases.md).
- **Les réveils poussés** (`/_filarr/notify`, signés HMAC par Filarr) pour une boîte qui dort ou relève.
- **La migration** : le paquet de réglages (clés, webhooks, requêtes, état des synchros) part scellé vers la suivante.
- **MCP** pour les assistants IA, métriques **Prometheus**, journal local, interface de gestion en français et anglais.

## Ligne de commande

| commande | |
|---|---|
| `filarr-gate [serve]` | démarre l'API locale et l'interface de gestion |
| `filarr-gate init --token … [--port] [--admin-port] [--admin-password] [--write] [--import FICHIER]` | range le jeton (0600) et les réglages |
| `filarr-gate keys create --name N [--sql] [--mcp] [--files]` · `keys list` · `keys revoke ID` | clés d'application |
| `filarr-gate sources list` · `sources key ID --stdin` · `sources run ID` · `sources pause/resume ID` | synchros externes |
| `filarr-gate files test` · `files status ID` | la fente à fichiers |
| `filarr-gate export --for-token … --out FICHIER` · `filarr-gate import FICHIER` | paquet de migration |
| `filarr-gate doctor` | horloge, Filarr, jeton, clé du créateur, bases, quotas, fichiers, synchros (code 1 en cas d'échec) |
| `filarr-gate health` · `filarr-gate mcp` · `filarr-gate version` | sonde, MCP sur stdio, version |

`--json` partout. Sur la machine d'une boîte en marche (`docker exec` compris), les commandes passent par elle sans mot
de passe ; `--remote URL --admin-password …` en atteint une sur une autre machine.

## Réglages

Les variables d'environnement passent avant `gate.toml` (dans le répertoire d'état, ou `FILARR_GATE_CONFIG`), qui
passe avant l'interface. Un réglage fixé par l'environnement ou le fichier est montré verrouillé.

| variable | `gate.toml` | d'office | |
|---|---|---|---|
| `FILARR_GATE_TOKEN` | — | — | le jeton ; jamais écrit sur le disque quand il est donné ici |
| `FILARR_GATE_STATE_DIR` | — | `~/.filarr-gate` (`/data` dans Docker) | état, cache chiffré des blocs, journal, état chiffré des synchros |
| `FILARR_GATE_API_URL` | `api_url` | `https://api.filarr.com` | l'API de Filarr |
| `FILARR_GATE_HOST` / `_PORT` | `host` / `port` | `127.0.0.1` / `8443` | l'API locale |
| `FILARR_GATE_ADMIN_HOST` / `_PORT` | `admin_host` / `admin_port` | `127.0.0.1` / `8787` | l'interface de gestion |
| `FILARR_GATE_ADMIN_PASSWORD` | — | — | mot de passe d'administration sans l'écran de mise en route |
| `FILARR_GATE_WRITE` | `write` | `false` | l'écriture vers Filarr |
| `FILARR_GATE_TLS_CERT` / `_KEY` | `tls_cert` / `tls_key` | — | HTTPS pour l'API locale |
| `FILARR_GATE_CORS_ORIGINS` | `cors_origins` | aucune | pages web admises à appeler l'API |
| `FILARR_GATE_TRUST_PROXY` | `trust_proxy` | aucun | mandataires dont on croit `X-Forwarded-For` |
| `FILARR_GATE_METRICS` / `_MCP` / `_DOCS` | `metrics` / `mcp` / `docs` | oui / non / oui | `/metrics`, `/mcp`, `/docs` |
| `FILARR_GATE_NOTIFY` | `notify` | oui | accepter les réveils poussés de Filarr |
| `FILARR_GATE_FILES_DENY` / `_ALLOW` / `_MAX_BYTES` | `files_deny` / `files_allow` / `files_max_bytes` | liste du contrat / aucune / 100 Mio | le filtre des fichiers |
| `FILARR_GATE_JOURNAL_DAYS` | `journal_days` | `30` | durée du journal local |
| `FILARR_GATE_CACHE` | `cache` | `disk` | `memory` : rien sur le disque, pas même les blocs chiffrés |
| `FILARR_GATE_POLL_SECONDS` | `poll_seconds` | `300` | relève sans flux (jamais moins de 300) |
| `FILARR_GATE_EXTDB_<ID>` | `[extdb."xs_…"] secret` | — | la clé d'une base externe (voir son écran) |
| `FILARR_GATE_LOG_LEVEL` | — | `info` | `debug`, `info`, `warn`, `error` |

## API (résumé)

Chaque appel porte une clé d'application : `Authorization: Bearer gk_…`.

| route | |
|---|---|
| `GET /v1/<base>` | lignes : `limit` (≤ 1000), `cursor`, `fields`, `sort`, `q`, `since`, filtres `champ=valeur` ou `champ[op]=valeur` |
| `GET /v1/<base>/<vue>` · `GET /v1/<base>/rows/<id>` | une vue, une ligne |
| `POST /v1/<base>` · `PATCH`/`DELETE /v1/<base>/rows/<id>` | écriture (`409 field_managed` sur une colonne alimentée par une source externe) |
| `POST /v1/sql` · `GET /v1/q/<requête>` | SQL en lecture, requêtes enregistrées |
| `POST /v1/files` · `GET /v1/files/<id>` | déposer un fichier (multipart ou corps brut), son statut |
| `POST /mcp` · `GET /openapi.json` · `GET /health` · `GET /metrics` | MCP, description, sonde, métriques |

Les webhooks sont des `POST` avec `Filarr-Gate-Event`, `Filarr-Gate-Delivery` et `Filarr-Gate-Signature: t=…,v1=…`,
où `v1 = HMAC-SHA256(secret, t + "." + corps brut)`.

## Sécurité, en bref

- Un jeton n'ouvre **que les bases choisies**, jamais le compte. Il ne quitte jamais la boîte : les clés sont tirées
  sur place et le secret effacé de la mémoire. Chaque clé scellée est vérifiée à sa place avant usage ; chaque bloc
  contre l'empreinte de la tête avant d'être déchiffré.
- La clé d'identité du créateur est authentifiée par une étiquette que seul le jeton sait calculer ; boîtes de dépôt,
  définitions de synchro et cible d'une migration ne sont acceptées que signées par cette clé. Un serveur ne peut pas y
  substituer la sienne.
- Les lignes déchiffrées ne vivent qu'en mémoire. Le disque garde des blocs chiffrés, les empreintes des clés, les
  secrets des webhooks, les clés des bases externes chiffrées sous une clé tirée du jeton, et l'état chiffré des
  synchros. Une révocation efface tout.
- Qui fait tourner la boîte, ou tient le mot de passe de gestion, tient les données. Les vues sont une commodité, pas
  une frontière.

Détails : [docs/architecture.md](docs/architecture.md), [SECURITY.md](SECURITY.md).

## Développement

```sh
npm ci
npm test            # essais unitaires et d'intégration, contre un Filarr en mémoire (plus wrangler dev et PostgreSQL s'ils sont là)
npm run typecheck
npm run build
npm run mock-filarr # un Filarr en mémoire avec des bases de démonstration, pour essayer à la main
```

De bout en bout contre le vrai worker de Filarr, lancé en local par le banc de Filarr : voir l'en-tête de
[test/worker.e2e.test.ts](test/worker.e2e.test.ts) (`npm run test:e2e`).

Arborescence : `packages/core` (le cœur portable de Filarr, recopié tel quel et relicencié Apache-2.0, et les modules
purs de la boîte), `packages/gate` (la bibliothèque), `packages/server` (la boîte noire sans moteur),
`packages/cli` (Node, l'interface, Docker), `packages/cloudflare` (le Worker). Plan de publication :
[docs/release.md](docs/release.md).

## Licence

[Apache-2.0](LICENSE). Voir [NOTICE](NOTICE). Signaler une faille en privé : [SECURITY.md](SECURITY.md).
