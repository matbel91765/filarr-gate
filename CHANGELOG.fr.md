# Journal des changements

[Read in English](CHANGELOG.md)

Les changements notables de chaque version. Avant la 1.0, une version mineure peut changer l'API ; les notes de version
le disent.

## 0.3.0 : le service hébergé, construit

Datée par l'entrée « published » du journal public des mises en service (branche `release-journal`), écrite à la
réception de l'étiquette signée.

Pour une boîte noire que vous faites tourner vous-même (bibliothèque, commande, image Docker, variante Cloudflare),
rien ne change depuis la 0.2.0 : même API, mêmes réglages, mêmes contrats.

### Le service hébergé : construit, pas encore ouvert

Le service qui fera tourner la boîte hébergée par Filarr est dans ce dépôt, `packages/host` (le Worker
`filarr-gate-host`, contrat `gate-heberge-1`). Il n'est pas en service : l'offre hébergée de Filarr ouvrira plus tard,
après une revue de sécurité externe. Comment il est monté, ce qui n'est plus chiffré de bout en bout dans ce mode et ce
qui le protège : [le service hébergé](docs/explain/hosted.fr.md).

- Une boîte par accès hébergé, un Durable Object créé dans la juridiction UE, qui fait tourner le même cœur de Filarr
  Gate qu'à la maison, par l'adaptateur Cloudflare.
- Son état au repos chiffré avec une clé tirée du jeton de l'accès (`K_box`, AES-256-GCM) : une fois le jeton scellé
  effacé, ce qui est stocké ne peut plus être déchiffré.
- Son cycle de vie : des réveils signés par Filarr, le sommeil sans perdre l'état chiffré (`503 gate_asleep`), les
  appels du mois comptés jusqu'au plafond de l'offre (`429 hosted_quota_calls`), le retour à la maison avec le paquet de
  réglages, une redirection `308` pendant 30 jours après un déménagement.
- L'effacement avec un reçu signé par le service (raison et heure de la demande, bases et génération tenues, ce qui a
  été effacé, version, `codeHash`), et un reçu partiel pour une base retirée seule, avec sa cause.
- Un canal de gestion `/_admin/…` et aucune interface web : chaque requête signée par la clé d'identité du créateur
  (méthode, chemin avec sa requête, heure, empreinte du corps) et acceptée une seule fois (`401 admin_replay`).
- Une annonce de version signée, `/.well-known/filarr-gate-host.json`, dont chacun peut comparer le `codeHash` à la
  version publiée.
- Aucun journal : le bloc `observability` est présent et éteint tout, vérifié par un essai.
- Éprouvé en mémoire et sous workerd, avec les vecteurs de `gate-heberge-1` des familles 2, 3, 4, 5, 7 et 8 rejoués par
  le code que le service exécute.

### Chaîne de publication

- Le module du service, `host/filarr-gate-host-X.Y.Z.js`, est construit deux fois et comparé comme les archives npm,
  compté dans `SHA256SUMS` et joint à la publication GitHub.
- `.github/workflows/deploy-host.yml` met ce fichier même en service (`wrangler deploy --no-bundle`), lancé à la main
  depuis une étiquette signée, au plus tôt **sept jours** après son entrée « published », sauf correctif de sécurité
  accepté ; il écrit l'entrée « deployed » (ou « security ») du journal public. Les versions publiées avant que le
  module existe (0.2.0) ne se mettent pas en service. La marche à suivre :
  [docs/RELEASING.fr.md](docs/RELEASING.fr.md#le-service-hébergé).
- `scripts/host-keys.mjs` tire une fois les clés du service (`HOST_ENC`, X25519 ; `HOST_SIG`, Ed25519) et ne remet les
  moitiés privées à Cloudflare que par l'entrée standard ; `--rotate` ajoute la paire suivante.
- Les clés publiques `h1` (valables jusqu'au 2028-10-09) dans [`docs/hosted-keys.json`](docs/hosted-keys.json),
  embarquées dans le service et dans les applis Filarr.

## 0.2.0 : première publication

Datée par l'entrée « published » du journal public des mises en service (branche `release-journal`), écrite à la
réception de l'étiquette signée.

### Publié

- `@filarr/gate` sur npm : la bibliothèque, pour lire et écrire les lignes d'une base Filarr depuis votre propre code.
- `filarr-gate` sur npm : la commande, le serveur et l'interface de gestion.
- `ghcr.io/filarr-work/gate` : l'image Docker (linux/amd64, linux/arm64), utilisateur non root, état dans `/data`.
- La variante Cloudflare, depuis la source étiquetée (`wrangler.jsonc`, bouton Deploy) : un Worker et un Durable
  Object sur votre propre compte.

### Ce que fait la boîte noire

- Des points d'accès tirés des vues (`GET /v1/<base>`, `GET /v1/<base>/<vue>`), rejouées par le moteur de vues de
  Filarr, avec filtres, tri, champs, recherche et pages ; du SQL en lecture seule avec le moteur de Filarr et des
  requêtes enregistrées ; une description OpenAPI 3.1 de chaque boîte noire.
- Des clés d'application (`gk_…`), une par logiciel, gardées en empreintes, limitées à des bases, des vues, des
  requêtes ou à la fente à fichiers, avec un débit, des adresses permises et une expiration.
- L'écriture, éteinte par défaut, idempotente avec `Idempotency-Key`.
- Des webhooks signés sur les changements de lignes (HMAC-SHA256 sur le corps brut, 8 essais sur environ 10 h 30).
- Une fente à fichiers (`POST /v1/files`) : des fichiers scellés pour la boîte de dépôt que le créateur a liée dans
  Filarr ; exécutables et fichiers trop gros refusés avant tout envoi.
- Des bases externes : les synchros que Filarr confie à la boîte noire (D1, PostgreSQL, MySQL, Supabase, Airtable,
  Google Sheets, Notion, CSV/JSON), avec vos clés, dans tous les sens, les deux sens compris, une règle de conflit par
  colonne, la file « me demander » et un garde-fou qui arrête un passage.
- Des réveils poussés pour les boîtes noires qui dorment, le déménagement des réglages vers la boîte suivante (paquet
  scellé `gate-settings-1`), MCP pour les assistants d'IA, des mesures Prometheus, un journal local, une interface de
  gestion en français et en anglais.

### Contrats

`api-base-1` (révisions 2 et 3), `db-store-1` (3.9), `gate-fichiers-1`, `source-externe-1`, et de `gate-heberge-1` le
paquet de réglages et les vecteurs des familles 2 (jeton scellé), 8 (`K_box` et l'enveloppe de l'état) et 9 (étiquette
de sécurité et journal public), dont ce dépôt est l'origine.

### Chaîne de publication

- Des constructions reproductibles (`SHA256SUMS`), la provenance npm, une image signée (cosign) avec sa provenance et
  son SBOM.
- Des publications seulement depuis une étiquette signée par une clé de `.github/release-signers` (signature SSH de
  git), et un journal public des mises en service ; voir [docs/RELEASING.fr.md](docs/RELEASING.fr.md).
- Workers Logs éteints par défaut dans `wrangler.jsonc` ; les licences tierces dans `THIRD_PARTY_NOTICES`.

### Prérequis

Node.js 20.19 ou plus récent (bibliothèque et commande). La bibliothèque n'emploie que des API web standard.
