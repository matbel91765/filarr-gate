# Journal des changements

[Read in English](CHANGELOG.md)

Les changements notables de chaque version. Avant la 1.0, une version mineure peut changer l'API ; les notes de version
le disent.

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
