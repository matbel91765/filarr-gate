<!-- Généré par `npm run docs` depuis packages/server/src/settings.ts : ne pas modifier à la main. -->

# Configuration

[Read in English](configuration.md)

Un réglage vient, dans cet ordre (le premier trouvé l'emporte) :

1. d'une **variable d'environnement** (sur Cloudflare : une variable ou un secret du Worker) ;
2. du fichier **`gate.toml`** : `$FILARR_GATE_STATE_DIR/gate.toml`, ou le fichier que nomme `FILARR_GATE_CONFIG` ;
3. de l'**interface de gestion** (écran Réglages), enregistrée dans le répertoire d'état ;
4. de la valeur par défaut.

Un réglage fixé par l'environnement ou par `gate.toml` apparaît **verrouillé** dans l'interface.

## Les réglages

| variable d'environnement | `gate.toml` | par défaut | ce qu'il fait |
|---|---|---|---|
| `FILARR_GATE_API_URL` | `api_url` | `https://api.filarr.com` | L'API de Filarr. À ne changer que pour un Filarr local (essais, banc de Filarr). |
| `FILARR_GATE_HOST` | `host` | `127.0.0.1` | Adresse où écoute l'API locale. `0.0.0.0` pour accepter les autres machines (l'image Docker la règle ainsi). |
| `FILARR_GATE_PORT` | `port` | `8443` | Port de l'API locale. |
| `FILARR_GATE_ADMIN_HOST` | `admin_host` | `127.0.0.1` | Adresse de l'interface de gestion. Gardez `127.0.0.1`, sauf derrière un mandataire protégé : qui entre dans l'interface lit les données. |
| `FILARR_GATE_ADMIN_PORT` | `admin_port` | `8787` | Port de l'interface de gestion. |
| `FILARR_GATE_WRITE` | `write` | `false` | L'écriture vers Filarr par `POST`, `PATCH`, `DELETE`. Éteinte d'office ; Filarr doit aussi donner à l'accès un droit `rw`, et le palier permettre l'écriture. |
| `FILARR_GATE_TLS_CERT` | `tls_cert` | aucune | HTTPS pour l'API locale : chemin du certificat (PEM). `tls_cert` et `tls_key` ensemble, ou aucun des deux. |
| `FILARR_GATE_TLS_KEY` | `tls_key` | aucune | HTTPS pour l'API locale : chemin de la clé privée (PEM). |
| `FILARR_GATE_CORS_ORIGINS` | `cors_origins` | aucune | Pages web autorisées à appeler l'API depuis un navigateur (`https://shop.example.com`), séparées par des virgules. Vide : toute requête qui porte un `Origin` est refusée. `*` autorise toutes les pages (à éviter). |
| `FILARR_GATE_TRUST_PROXY` | `trust_proxy` | aucune | Adresses ou plages des mandataires inverses dont on croit le `X-Forwarded-For` (pour les adresses autorisées et le journal). |
| `FILARR_GATE_METRICS` | `metrics` | `true` | Métriques Prometheus sur `/metrics` (sans clé). |
| `FILARR_GATE_MCP` | `mcp` | `false` | Le serveur MCP sur `/mcp`, pour les assistants IA (lecture seule, clés qui ont le droit MCP). |
| `FILARR_GATE_DOCS` | `docs` | `true` | `/openapi.json` et `/docs` sans clé. Éteint : il faut une clé pour les lire. |
| `FILARR_GATE_JOURNAL_DAYS` | `journal_days` | `30` | Jours de conservation du journal local (de 1 à 3650). |
| `FILARR_GATE_CACHE` | `cache` | `disk` | `disk` : les blocs chiffrés restent dans le répertoire d'état d'un démarrage à l'autre. `memory` : rien sur le disque, pas même les blocs chiffrés (la copie se retélécharge à chaque démarrage). |
| `FILARR_GATE_POLL_SECONDS` | `poll_seconds` | `300` | Intervalle de relève sans flux en direct, en secondes. Jamais sous 300, et jamais plus vite que le palier ne le permet. |
| `FILARR_GATE_FILES_MAX_BYTES` | `files_max_bytes` | `104857600` (100 Mio) | Fente à fichiers : plus gros fichier accepté, en octets. Plus bas que la limite de Filarr si vous voulez, jamais plus haut (104857600 au plus). |
| `FILARR_GATE_FILES_DENY` | `files_deny` | la liste du contrat (plus bas) | Fente à fichiers : extensions refusées, séparées par des virgules. Remplacer la liste d'office en retire les entrées : gardez-les. |
| `FILARR_GATE_FILES_ALLOW` | `files_allow` | aucune | Fente à fichiers : si elle est donnée, SEULES ces extensions passent (les signatures d'exécutables sont refusées quoi qu'il arrive). |
| `FILARR_GATE_NOTIFY` | `notify` | `true` | Accepter les réveils poussés de Filarr sur `/_filarr/notify` (signés d'une clé tirée du jeton). |

Les booléens acceptent `true`, `false`, `1`, `0`, `yes`, `no`, `on`, `off`. Les listes se séparent par des virgules dans une variable, et s'écrivent en tableau dans `gate.toml`.

La liste d'office des extensions refusées (`files_deny`) : `.exe`, `.msi`, `.bat`, `.cmd`, `.ps1`, `.sh`, `.js`, `.app`, `.com`, `.scr`, `.vbs`, `.jar`, `.dll`, `.apk`, `.dmg`, `.pkg`, `.deb`, `.rpm`, `.lnk`, `.reg`, `.hta`.

## Autres variables

| variable | ce qu'elle fait |
|---|---|
| `FILARR_GATE_TOKEN` | Le jeton de l'accès (`flr_live_…`). Donné ainsi, il n'est jamais écrit sur le disque. Sinon, `filarr-gate init` ou l'écran de mise en route le range dans le répertoire d'état (fichier `token`, mode 0600). |
| `FILARR_GATE_ADMIN_PASSWORD` | Le mot de passe de gestion, à la place de celui choisi à l'écran de mise en route (10 caractères au moins). |
| `FILARR_GATE_STATE_DIR` | Le répertoire d'état : `~/.filarr-gate` par défaut, `/data` dans l'image Docker. |
| `FILARR_GATE_CONFIG` | Le chemin d'un `gate.toml` rangé ailleurs que dans le répertoire d'état. |
| `FILARR_GATE_EXTDB_<ID>` | La clé d'une base externe que nomme une définition de synchro : `<ID>` est fait des 8 premiers caractères après `xs_` de l'identifiant de la définition, en majuscules. Le nom exact s'affiche sur l'écran **Sources** et dans `filarr-gate sources list`. |
| `FILARR_GATE_LOG_LEVEL` | `debug`, `info` (par défaut), `warn`, `error`. |
| `FILARR_GATE_PUBLIC_URL` | Variante Cloudflare : l'adresse à afficher et à donner, quand ce n'est pas celle où arrivent les requêtes. |
| `FILARR_GATE_ADMIN_URL` | Ligne de commande : l'interface de gestion d'une boîte noire d'une autre machine (comme `--remote`). |
| `FILARR_GATE_URL`, `FILARR_GATE_KEY` | `filarr-gate mcp` : l'API locale vers laquelle relayer, et la clé d'application à employer (comme `--gate` et `--key`). |
| `FILARR_GATE_NEW_TOKEN` | `filarr-gate export` : le jeton de la boîte noire qui prend la suite (comme `--for-token`). |

## `gate.toml`

```toml
# $FILARR_GATE_STATE_DIR/gate.toml
port = 8443
write = true
cors_origins = ["https://shop.example.com"]
trust_proxy = ["127.0.0.1"]
files_allow = [".pdf", ".csv", ".xlsx"]

# La clé d'une base externe, par identifiant de définition de synchro (jamais envoyée à Filarr)
[extdb."xs_AbCdEfGhIjKlMnOpQrStUv"]
secret = "…"
```

Seule une partie de TOML est lue : `clé = valeur` (chaîne, nombre, booléen, tableau de chaînes), les en-têtes `[section]` et les commentaires `#`.
