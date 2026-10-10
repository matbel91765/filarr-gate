# Documentation de Filarr Gate

[Read in English](README.md)

Filarr Gate, la boîte noire de Filarr, sert sous forme d'API les bases Filarr que vous choisissez, depuis une copie
qu'elle déchiffre elle-même, chez vous, sans que Filarr voie jamais vos données. Commencez par le
[README](../README.fr.md) pour l'idée en deux minutes.

Chaque bloc de code des tutoriels est recopié d'[examples/](../examples), et chaque exemple tourne dans la suite
d'essais face à une boîte noire avant chaque version (`npm run test:examples`) : les extraits gardent donc leurs
commentaires en anglais, tels qu'ils sont dans les exemples, et le texte autour les explique. Les tables des réglages,
des commandes et des codes sont tirées du code, en français comme en anglais (`npm run docs:check` échoue quand elles ne
correspondent plus au code).

**Pas de compte Filarr ?** `npm run mock-filarr` lance un Filarr en mémoire avec trois bases de démonstration et
affiche un jeton : de quoi suivre chaque tutoriel.

## Tutoriels

| | | |
|---|---|---|
| Installer | [sur votre ordinateur](tutorials/install-local.fr.md) · [sur un serveur avec Docker](tutorials/install-docker.fr.md) · [sur votre compte Cloudflare](tutorials/install-cloudflare.fr.md) | |
| Commencer | [ouvrir une base à une API](tutorials/open-a-database.fr.md) (dans Filarr) | |
| Utiliser | [appeler l'API : curl, JavaScript, Python](tutorials/first-calls.fr.md) · [la bibliothèque dans votre programme Node](tutorials/library.fr.md) · [recevoir les changements par webhook](tutorials/webhooks.fr.md) | |
| Synchroniser | [une base Cloudflare D1, dans un sens, dans l'autre ou dans les deux](tutorials/sync-d1.fr.md) · [un PostgreSQL de votre réseau](tutorials/sync-postgres.fr.md) | côté Filarr bientôt |
| Fichiers | [recevoir des fichiers dans un dossier Filarr](tutorials/receive-files.fr.md) | côté Filarr bientôt |
| Hébergée | [passer à la boîte hébergée, puis revenir chez vous](tutorials/hosted-and-back.fr.md) | bientôt |
| Sécurité | [révoquer un accès, réagir à une fuite](tutorials/revoke.fr.md) · [sécurité et confiance : qui voit quoi](security-and-trust.fr.md) | |
| Aide | [dépannage](troubleshooting.fr.md) | |

## Cas d'usage, complets et éprouvés

| exemple | le cas |
|---|---|
| [first-calls](../examples/first-calls) | l'API en curl, JavaScript et Python, avec la pagination, les écritures idempotentes et le `429` |
| [library-node](../examples/library-node) | `@filarr/gate` dans un service : lire, écouter, écrire, s'arrêter proprement |
| [webhook-receiver](../examples/webhook-receiver) | un webhook signé, vérifié puis traité, en Node et en Python |
| [static-site](../examples/static-site) | une page de catalogue construite depuis une vue, reconstruite à chaque changement |
| [erp-orders-invoices](../examples/erp-orders-invoices) | un ERP qui écrit ses commandes une seule fois (lot idempotent) et dépose ses factures dans un dossier |
| [receive-files](../examples/receive-files) | déposer des fichiers avec curl et Python, et suivre leur état |
| [python-nightly-export](../examples/python-nightly-export) | un export CSV nocturne par SQL |
| [mcp-assistant](../examples/mcp-assistant) | un assistant IA qui lit vos bases par MCP (stdio et HTTP) |
| [public-form](../examples/public-form) | un formulaire public qui ne peut qu'ajouter des lignes, depuis une seule page web |
| [sync-d1](../examples/sync-d1) | une table D1 synchronisée dans un sens, dans l'autre ou dans les deux, avec les quatre politiques de conflit |
| [sync-postgres](../examples/sync-postgres) | un PostgreSQL du réseau local, avec un rôle limité |
| [docker](../examples/docker) | Docker Compose derrière Caddy |

Les exemples sont décrits en anglais dans leur dossier.

## Référence

[L'API locale](reference/api.fr.md) · [OpenAPI](openapi/filarr-gate.v1.json) ·
[configuration](reference/configuration.fr.md) · [ligne de commande](reference/cli.fr.md) · [codes d'erreur et
états](reference/errors.fr.md) · [webhooks](reference/webhooks.fr.md) · [MCP](reference/mcp.fr.md) · [la
bibliothèque](reference/library.fr.md) · [connecteurs de bases externes](reference/sync-connectors.fr.md) ·
[limites](reference/limits.fr.md) · [contrats](reference/contracts.fr.md)

## Explications

[Architecture](architecture.fr.md) · [comment la boîte noire exécute les synchros externes](external-databases.fr.md) ·
[la synchro dans les deux sens](explain/two-way-sync.fr.md) · [déménager une boîte noire](explain/migration.fr.md) ·
[le service hébergé](explain/hosted.fr.md) · [la boîte noire sur Cloudflare](cloudflare.fr.md) ·
[plan de publication](release.fr.md) · [publier, pas à pas](RELEASING.fr.md)

## Vocabulaire

Les mots de cette documentation sont ceux de l'appli Filarr et de son aide : une **base** (une base de données de
Filarr), un **accès** (ce que crée « Ouvrir à une API… »), son **jeton** (`flr_live_…`), une **clé d'application**
(`gk_…`, une par logiciel), la **fente** à fichiers, la **file « me demander »** des conflits, le **garde-fou** qui
arrête un passage de synchro. Le vocabulaire complet est dans l'aide de Filarr :
[Vocabulaire de la boîte noire](https://filarr.com/docs/gate-glossary).
