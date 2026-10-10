# Filarr Gate

**Servir une base Filarr sous forme d'API, sans que Filarr voie jamais vos données.**

[![Licence : Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[Read in English](README.md)

> **État : v0.2, en avance sur le serveur.** La boîte noire suit les contrats gelés `api-base-1` (révisions 2 et 3),
> `db-store-1` (3.9), `gate-fichiers-1`, `source-externe-1` et le paquet de réglages de `gate-heberge-1`. Elle est
> éprouvée de bout en bout face à un serveur Filarr local (lecture, changements en direct, écriture, révocation, une
> synchro PostgreSQL externe, un dépôt de fichier, la variante Cloudflare). Le côté Filarr est fusionné mais éteint
> (`API_BASE_SWITCH`, `GATE_FILES_SWITCH`…) ; il s'ouvre compte par compte. Rien n'est encore publié (ni sur npm, ni en
> image Docker) : elle se lance depuis un clone. La boîte hébergée par Filarr n'est pas ouverte.

Filarr chiffre vos notes et vos bases de bout en bout : ses serveurs gardent des blocs qu'ils ne savent pas lire.
Filarr Gate est une petite **boîte noire que vous faites tourner vous-même** (dans votre code, sur un PC, dans Docker,
sur votre compte Cloudflare) : elle tient la clé des bases que vous lui ouvrez, en garde une copie déchiffrée en
mémoire, et sert vos logiciels. Filarr continue de ne voir que des blocs chiffrés.

```
 Appli Filarr ──(blocs chiffrés)──▶ serveurs Filarr ──(blocs chiffrés)──▶ Filarr Gate ──(JSON en clair)──▶ votre ERP, BI, site, agent IA
                                       ne voient rien                     chez vous
```

Dans Filarr : « ··· » sur une base › **Ouvrir à une API…** donne un jeton (`flr_live_…`), montré une seule fois.

## L'essayer en cinq minutes, sans compte

```sh
git clone https://github.com/matbel91765/filarr-gate.git && cd filarr-gate
npm ci && npm run build
npm run mock-filarr      # un Filarr en mémoire avec trois bases de démonstration ; il affiche un jeton. Laissez-le tourner.
```

Dans un deuxième terminal :

```sh
export FILARR_GATE_API_URL=http://127.0.0.1:8790
node packages/cli/dist/cli.js init --token flr_live_… --admin-password 'dix-caracteres-au-moins'
node packages/cli/dist/cli.js                                   # l'API sur 127.0.0.1:8443, l'interface sur http://127.0.0.1:8787/admin/
```

Dans un troisième :

```sh
node packages/cli/dist/cli.js keys create --name "Premier essai" --sql     # une clé d'application, montrée une fois
curl -s -H "Authorization: Bearer gk_…" "http://127.0.0.1:8443/v1/clients?limit=2"
```

```json
{"rows":[{"id":"r_acme","nom":"Acme","ville":"Lyon","statut":"Client","ca":12500, …}, …],"next":"o2","total":4,"version":2}
```

## Quatre façons de la faire tourner

| | comment | tutoriel |
|---|---|---|
| **dans votre code** | `npm install @filarr/gate`, puis `openGate({ token })` : lignes, vues, SQL, changements en direct, écriture, dépôt de fichiers | [bibliothèque](docs/tutorials/library.fr.md) |
| **sur une machine** | `npx filarr-gate init --token …` puis `npx filarr-gate` (depuis un clone : `node packages/cli/dist/cli.js`) | [votre ordinateur](docs/tutorials/install-local.fr.md) |
| **dans Docker** | `docker compose up -d` avec [examples/docker](examples/docker) : la boîte derrière Caddy, l'état dans un volume | [un serveur](docs/tutorials/install-docker.fr.md) |
| **sur votre compte Cloudflare** | le bouton Deploy, ou `npx wrangler deploy` ; le jeton est un secret de VOTRE Worker | [Cloudflare](docs/tutorials/install-cloudflare.fr.md) |

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/matbel91765/filarr-gate)

```js
import { openGate } from '@filarr/gate';

const gate = await openGate({ token: process.env.FILARR_GATE_TOKEN });
const actifs = await gate.base('clients').view('clients-actifs').rows();
```

## Ce qu'elle fait

- **Des points d'accès tirés des vues.** `GET /v1/<base>` et `GET /v1/<base>/<vue>`, rejoués par le moteur de vues de
  Filarr ; les slugs sont fixés à l'ouverture de la base : renommer une vue ne casse jamais une intégration. Filtres,
  tri, champs, recherche, pages. SQL en lecture seule par le moteur de Filarr, requêtes enregistrées, OpenAPI 3.1 de
  chaque boîte sur `/openapi.json` et `/docs`.
- **Des clés d'application.** Vos logiciels n'ont jamais le jeton Filarr : chacun reçoit sa clé `gk_…` (conservée sous
  forme d'empreinte), limitée à des bases, des vues, des requêtes ou à la fente à fichiers, avec un débit, des adresses
  autorisées et une échéance.
- **L'écriture** (éteinte d'office) : `POST`, `PATCH`, `DELETE`, idempotents avec `Idempotency-Key`, validés par Filarr
  comme les écritures de n'importe quel appareil.
- **Des webhooks signés** à chaque changement de ligne (HMAC-SHA256 sur le corps brut, 8 essais sur environ
  10 h 30).
- **Une fente à fichiers** (`POST /v1/files`) : les fichiers sont scellés pour la boîte de dépôt que le créateur a liée
  et signée dans Filarr ; exécutables et fichiers trop lourds sont refusés avant que rien ne parte. L'appli Filarr les
  range ; ni Filarr ni la boîte ne savent où.
- **Des bases externes** : les synchros que Filarr confie à cette boîte (D1, PostgreSQL, MySQL, Supabase, Airtable,
  Google Sheets, Notion, CSV/JSON) tournent ici, avec vos clés, qui n'atteignent jamais Filarr ; dans un sens, dans
  l'autre ou dans les deux, avec la politique de conflit que vous choisissez colonne par colonne et une file « me
  demander ».
- **Des réveils poussés** pour les boîtes qui s'endorment (Cloudflare) ; la **migration** des réglages vers la boîte
  suivante, scellée ; le **MCP** pour les assistants IA ; des métriques **Prometheus** ; un journal local ; une
  interface de gestion en français et en anglais.

## Documentation

Toute la documentation existe en français et en anglais : chaque page renvoie à l'autre langue en tête.

- **Tutoriels** : [installer](docs/tutorials/install-local.fr.md) ([Docker](docs/tutorials/install-docker.fr.md),
  [Cloudflare](docs/tutorials/install-cloudflare.fr.md)) · [ouvrir une base à une
  API](docs/tutorials/open-a-database.fr.md) · [appeler l'API en curl, JavaScript,
  Python](docs/tutorials/first-calls.fr.md) · [la bibliothèque](docs/tutorials/library.fr.md) ·
  [webhooks](docs/tutorials/webhooks.fr.md) · [synchroniser D1](docs/tutorials/sync-d1.fr.md) et
  [PostgreSQL](docs/tutorials/sync-postgres.fr.md) · [recevoir des fichiers](docs/tutorials/receive-files.fr.md) ·
  [révoquer](docs/tutorials/revoke.fr.md) · [passer à la boîte hébergée, puis
  revenir](docs/tutorials/hosted-and-back.fr.md) (bientôt) · [dépannage](docs/troubleshooting.fr.md)
- **Cas d'usage**, complets et éprouvés : [examples/](examples) (décrits en anglais)
- **Référence** : [API](docs/reference/api.fr.md) · [OpenAPI](docs/openapi/filarr-gate.v1.json) ·
  [réglages](docs/reference/configuration.fr.md) · [ligne de commande](docs/reference/cli.fr.md) ·
  [codes](docs/reference/errors.fr.md) · [webhooks](docs/reference/webhooks.fr.md) · [MCP](docs/reference/mcp.fr.md) ·
  [bibliothèque](docs/reference/library.fr.md) · [connecteurs](docs/reference/sync-connectors.fr.md) ·
  [limites](docs/reference/limits.fr.md) · [contrats](docs/reference/contracts.fr.md)
- **Sécurité** : [qui voit quoi, dans chaque mode](docs/security-and-trust.fr.md) ·
  [architecture](docs/architecture.fr.md) · [signaler une faille](SECURITY.md) (en anglais)
- Tout : [docs/](docs/README.fr.md)

## La sécurité, en bref

- Un jeton n'ouvre **que les bases que vous choisissez**, jamais le compte. Il ne quitte jamais la boîte : les clés sont
  tirées sur place. Chaque clé scellée est confrontée à sa place, chaque bloc aux empreintes de la tête.
- Ce qui doit venir de vous (boîtes de dépôt, définitions de synchro, cible d'une migration) n'est accepté que signé
  par la clé du créateur de l'accès, que la boîte authentifie par une étiquette que seul le jeton permet de calculer.
- Les lignes déchiffrées vivent en mémoire seulement. La révocation efface la copie et change les clés des bases :
  l'ancien jeton ne peut pas lire ce qui s'écrit ensuite.
- Qui fait tourner la boîte, ou détient le mot de passe de gestion, lit les bases ouvertes. **Une vue est un confort,
  pas une frontière.**

## Développement

```sh
npm ci
npm test               # essais unitaires et d'intégration face à un Filarr en mémoire, les exemples, et docs:check
npm run test:examples  # seulement les exemples de la documentation (ceux en Python et en bash sautés s'ils manquent)
npm run docs           # régénère, en français et en anglais, les pages générées et les blocs de code recopiés d'examples/
npm run typecheck
npm run build
npm run mock-filarr    # un Filarr en mémoire avec des bases de démonstration, pour essayer la boîte à la main
```

De bout en bout face au vrai worker de Filarr, lancé en local par le banc de Filarr : voir l'en-tête de
[test/worker.e2e.test.ts](test/worker.e2e.test.ts) (`npm run test:e2e`).

Organisation : `packages/core` (le cœur portable de Filarr, recopié tel quel et relicencié sous Apache-2.0, plus les
modules purs de la boîte), `packages/gate` (la bibliothèque), `packages/server` (la boîte sans moteur), `packages/cli`
(Node, l'interface, Docker), `packages/cloudflare` (le Worker). Plan de publication :
[docs/release.fr.md](docs/release.fr.md).

## Licence

[Apache-2.0](LICENSE). Voir [NOTICE](NOTICE). Signalez les failles en privé : [SECURITY.md](SECURITY.md).
