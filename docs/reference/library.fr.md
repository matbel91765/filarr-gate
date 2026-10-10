# La bibliothèque `@filarr/gate`

[Read in English](library.md)

Tutoriel : [lire une base Filarr dans votre programme Node](../tutorials/library.fr.md). Les types publics sont dans
`packages/gate/src/types.ts` ; ce sont les seuls qu'un programme voit.

## `openGate(options): Promise<Gate>`

| option | par défaut | |
|---|---|---|
| `token` | obligatoire | le jeton de l'accès `flr_live_…` |
| `apiUrl` | `https://api.filarr.com` | l'API de Filarr (une autre pour les essais) |
| `cache` | `'memory'` | `{ dir }` : garder les blocs CHIFFRÉS sur le disque d'un lancement à l'autre (Node) |
| `write` | `false` | permettre `insert`, `update`, `delete` |
| `live` | `true` | tenir la copie à jour (flux en direct à partir de Solo, relève sinon) ; `false` : une copie, puis `refresh()` |
| `pollSeconds` | `300` | intervalle de relève sans flux (300 au moins) |
| `files` | le filtre du contrat | `{ maxBytes, deny, allow }` pour `files.deposit()` |
| `fetch` | le `fetch` global | un `fetch` à employer (mandataire, essais) |
| `streamOpener` | WebSocket | avancé ; `null` : jamais de flux |
| `onLog` | aucun | reçoit le journal de la réplique : `{ what, code, note? }` |
| `signal` | aucun | un `AbortSignal` qui annule l'ouverture |

Rend la main une fois la première copie prête. Lève une `GateError` : `token_required`, `api_access_unknown`,
`api_access_revoked`, `api_access_expired` (401), `aborted` (499).

## `Gate`

| membre | |
|---|---|
| `bases(): BaseSummary[]` | les bases ouvertes : `slug`, `title`, `rights` (`r` ou `rw`), `status`, `version`, `rows`, `fields`, `views` |
| `base(slug): Base` | une base ; lève `base_not_found`, ou `503` tant qu'elle n'est pas chargée |
| `sql(query, { bases? }): Promise<SqlResult>` | une requête en lecture seule ; `bases` limite les tables à certains slugs |
| `on('change', fn)`, `on('status', fn)` | écouter ; rend une fonction qui annule l'abonnement |
| `status(): GateStatus` | `link`, `detail`, `accessId`, `accessName`, `tier`, `filarrWrite`, `creator`, `files`, `bases`, `lastChangeAt`, `quota` |
| `files.deposit(data, { name, mimeType?, path?, tags?, source? })` | déposer un fichier dans la boîte de dépôt liée : `{ depositId, seq, status, depositedAt, sizeBytes, sha256 }` |
| `files.status(depositId)` | `{ status, depositedAt, filedAt }` |
| `refresh()` | tout relire depuis Filarr |
| `wake(rawBody, signatureHeader)` | un réveil poussé reçu par VOTRE serveur : vérifie la signature `Filarr-Notify` et la fenêtre de temps, puis relit ; `false` s'il est refusé |
| `close()` | arrêter, et effacer de la mémoire les clés et les lignes |
| `accessId`, `accessName` | l'accès, tel que Filarr le connaît |

## `Base`

| membre | |
|---|---|
| `slug`, `title`, `rights`, `version`, `fields`, `views` | relus à chaque lecture (ils suivent la copie) |
| `rows(options?): Promise<RowList>` | `where`, `sort`, `limit`, `cursor`, `fields`, `q`, `since` ; un tableau avec `next`, `total`, `version`, `unresolved?` |
| `row(id): Promise<Row \| null>` | une ligne |
| `view(slug): View` | `view.rows({ limit, cursor })` ; lève `view_not_found` |
| `insert(row)`, `insert(rows[])` | une validation ; la ou les nouvelles lignes |
| `update(id, patch)` | la ligne après le changement |
| `delete(id)` | |

`where` prend, par champ, une valeur (égal) ou `{ eq, ne, lt, lte, gt, gte, contains, in: [...], empty: boolean }`,
tout combiné par ET.

## `ChangeEvent`

`{ base, version, origin: 'filarr' | 'gate', added: Row[], changed: Array<{ before, after }>, removed: Row[] }`.

## `GateError`

Une `Error` avec `status` (le statut HTTP que rendrait l'API locale), `code` (les mêmes codes que l'API locale :
[errors.fr.md](errors.fr.md)) et `extra` (`retryAfter`, `field`, `keys`, `limit`…).

## Où elle tourne

Node 20 ou plus récent : éprouvé. Elle n'emploie que des API web standard (WebCrypto, `fetch`, WebSocket) : Deno, Bun et
Cloudflare Workers devraient donc la faire tourner ; ils ne sont pas éprouvés. Ses dépendances : `@noble/curves`,
`@noble/hashes` et `fflate`. La version qu'elle déclare à Filarr est `lib-<version>`.
