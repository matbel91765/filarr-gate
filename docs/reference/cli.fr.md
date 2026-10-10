<!-- Généré par `npm run docs` depuis `filarr-gate --help` (packages/cli/src/cli.ts) : ne pas modifier à la main. -->

# Ligne de commande : `filarr-gate`

[Read in English](cli.md)

```sh
npx filarr-gate <commande> [options]      # une fois publiée sur npm
node packages/cli/dist/cli.js <commande>  # depuis un clone, après npm ci && npm run build
docker exec <conteneur> filarr-gate <commande>
```

## Commandes

| commande | ce qu'elle fait |
|---|---|
| `filarr-gate [serve]` | Démarre l'API locale et l'interface de gestion (la commande par défaut). |
| `filarr-gate init --token flr_live_… [--host 127.0.0.1] [--port 8443]` | Range le jeton (fichier en mode 0600) et les réglages donnés, puis s'arrête. `--import FICHIER` applique un paquet de réglages (migration). Refusé tant qu'une boîte noire tourne sur le même répertoire d'état. |
| `filarr-gate health` | Interroge `/health` de l'API locale sur cette machine ; sort en 0 quand elle répond 200 (le contrôle de santé de Docker). |
| `filarr-gate doctor` | Diagnostique sans rien changer : horloge, Filarr, jeton, clé du créateur, bases et clés, quotas, fichiers, synchros. Sort en 1 quand un contrôle échoue. |
| `filarr-gate version` | Affiche la version. |
| `filarr-gate keys create --name NOM [--sql] [--mcp] [--files] [--rate 600] [--days 90]` | Crée une clé d'application qui lit toutes les vues (`--sql` : le SQL aussi ; `--mcp` : MCP ; `--files` : le dépôt de fichiers ; `--rate` : requêtes par minute ; `--days` : échéance). La clé ne s'affiche qu'une fois. Les clés plus étroites (une base, une vue, l'écriture) se créent dans l'interface de gestion. |
| `filarr-gate keys list` | Liste les clés d'application (préfixe, nom, pause, échéance). |
| `filarr-gate keys revoke ID\|PRÉFIXE` | Révoque une clé par son identifiant ou le début de son préfixe ; elle cesse de répondre tout de suite. |
| `filarr-gate sources list` | Liste les synchros externes que Filarr confie à cette boîte noire, ce qui bloque chacune, et d'où vient sa clé. |
| `filarr-gate sources key DEF_ID (--secret VALEUR \| --stdin \| --clear)` | Donne (ou efface) la clé d'une base externe ; `--stdin` la tient hors de l'historique du shell. Rangée chiffrée sous une clé tirée du jeton. |
| `filarr-gate sources run DEF_ID [--ack-guard PASSAGE] [--initial source\|filarr]` | Lance un passage de synchro tout de suite. `--ack-guard PASSAGE` accepte un passage arrêté (garde-fou), pour ce passage seulement ; `--initial source\|filarr` tranche un premier passage qui a rencontré trop de conflits. |
| `filarr-gate sources pause DEF_ID \| sources resume DEF_ID` | Met une synchro en pause sur cette boîte noire (`sources resume` la reprend). La définition reste dans Filarr. |
| `filarr-gate files test` | Dépose un petit fichier d'essai dans la boîte de dépôt liée. |
| `filarr-gate files status ID` | L'état d'un dépôt (`deposited`, `filed`, `rejected`, `expired`). |
| `filarr-gate export --for-token flr_live_… --out FICHIER` | Scelle les réglages de cette boîte noire (clés d'application, webhooks, requêtes enregistrées, état des synchros, filtre de fichiers) pour la boîte noire qui prend la suite, désignée par son nouveau jeton. |
| `filarr-gate import FICHIER` | Applique un paquet de réglages scellé pour le jeton de cette boîte noire. |
| `filarr-gate mcp [--gate http://127.0.0.1:8443] [--key gk_…]` | Un serveur MCP sur stdio, pour les assistants IA qui lancent une commande : il relaie vers `POST /mcp` d'une boîte noire en marche, avec une clé d'application qui a le droit MCP. |

## Options communes

| option | |
|---|---|
| `--json` | Affiche, pour chaque commande, un JSON qu'un programme peut lire. Les erreurs deviennent `{ "error", "code" }`. |
| `--remote URL` | Agit sur une boîte noire d'une AUTRE machine, par son interface de gestion, avec `--admin-password` (ou `FILARR_GATE_ADMIN_PASSWORD`). |
| `--help` | Affiche l'aide ci-dessous. |

## Où agit une commande

1. **Une boîte noire qui tourne sur ce répertoire d'état** (`docker exec` compris) : la commande passe par elle, sans mot de passe. Une boîte noire en marche écrit `cli.json` (mode 0600) dans son répertoire d'état, avec le secret de ce canal, qui ne répond que sur l'adresse de bouclage ; qui peut lire ce répertoire tient déjà le jeton.
2. **`--remote URL`** : par l'interface de gestion d'une boîte noire d'une autre machine, avec son mot de passe.
3. **Sinon** : la commande ouvre l'état de la boîte noire le temps du geste (aucun port, aucune synchro planifiée), puis s'arrête. Une clé créée ainsi n'atteint une boîte noire qui tourne ailleurs sur le même état qu'après son redémarrage ; préférez `--remote`.

Codes de sortie : `0` réussite, `1` échec (et `doctor` quand un contrôle échoue), `2` mauvais usage.

## L'aide, telle qu'elle s'affiche

```text
Filarr Gate <version> — une base Filarr servie comme une API, chez vous.

Démarrer
  filarr-gate [serve]              démarre l'API locale et l'interface de gestion
  filarr-gate init --token flr_live_… [--host 127.0.0.1] [--port 8443]
                   [--admin-host 127.0.0.1] [--admin-port 8787] [--api-url URL]
                   [--admin-password MOT_DE_PASSE] [--write] [--import FICHIER]
                                   range le jeton (0600) et les réglages, puis s'arrête ;
                                   --import applique un paquet de réglages (migration)
  filarr-gate health               sonde /health de l'API locale (HEALTHCHECK de Docker)
  filarr-gate doctor               diagnostic : horloge, Filarr, jeton, clé du créateur,
                                   clés manquantes, quotas, fichiers, synchros
  filarr-gate version

Clés des applications
  filarr-gate keys create --name NOM [--sql] [--mcp] [--files] [--rate 600] [--days 90]
                                   une clé en lecture de toutes les vues (--files : dépôt de fichiers)
  filarr-gate keys list
  filarr-gate keys revoke ID|PRÉFIXE

Synchros des bases externes
  filarr-gate sources list
  filarr-gate sources key DEF_ID (--secret VALEUR | --stdin | --clear)
  filarr-gate sources run DEF_ID [--ack-guard PASSAGE] [--initial source|filarr]
  filarr-gate sources pause DEF_ID | sources resume DEF_ID

Fichiers
  filarr-gate files test           dépose un petit fichier d'essai dans la boîte de dépôt liée
  filarr-gate files status ID

Migration (paquet de réglages gate-settings-1)
  filarr-gate export --for-token flr_live_… --out FICHIER
                                   scelle les réglages de cette boîte pour la boîte qui prend le relais
  filarr-gate import FICHIER       applique un paquet scellé pour le jeton de cette boîte

Assistants IA
  filarr-gate mcp [--gate http://127.0.0.1:8443] [--key gk_…]
                                   serveur MCP sur stdio, relayé vers une boîte noire en marche

Options communes
  --json                           sortie JSON
  --remote URL                     agir sur une boîte d'une AUTRE machine par son interface de gestion
                                   (avec --admin-password, ou FILARR_GATE_ADMIN_PASSWORD)

Sur la machine d'une boîte en marche (docker exec compris), les commandes passent par elle,
sans mot de passe : la boîte range dans son répertoire d'état (0600) le secret de ce canal.
Sinon, la commande ouvre la boîte le temps du geste, sans port ni synchro planifiée.

Répertoire d'état : FILARR_GATE_STATE_DIR (d'office ~/.filarr-gate).
Variables : FILARR_GATE_TOKEN, FILARR_GATE_ADMIN_PASSWORD, FILARR_GATE_API_URL, FILARR_GATE_HOST, FILARR_GATE_PORT, FILARR_GATE_ADMIN_HOST, FILARR_GATE_ADMIN_PORT, FILARR_GATE_WRITE, FILARR_GATE_TLS_CERT, FILARR_GATE_TLS_KEY, FILARR_GATE_CORS_ORIGINS, FILARR_GATE_TRUST_PROXY, FILARR_GATE_METRICS, FILARR_GATE_MCP, FILARR_GATE_DOCS, FILARR_GATE_JOURNAL_DAYS, FILARR_GATE_CACHE, FILARR_GATE_POLL_SECONDS, FILARR_GATE_FILES_MAX_BYTES, FILARR_GATE_FILES_DENY, FILARR_GATE_FILES_ALLOW, FILARR_GATE_NOTIFY,
FILARR_GATE_CONFIG (gate.toml), FILARR_GATE_EXTDB_<ID> (clé d'une base externe), FILARR_GATE_LOG_LEVEL.
```
