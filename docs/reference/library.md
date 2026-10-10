# The library `@filarr/gate`

Tutorial: [read a Filarr database in your Node program](../tutorials/library.md). The public types are in
`packages/gate/src/types.ts` and are the only ones a program sees.

## `openGate(options): Promise<Gate>`

| option | default | |
|---|---|---|
| `token` | required | the access token `flr_live_…` |
| `apiUrl` | `https://api.filarr.com` | Filarr's API (another one for tests) |
| `cache` | `'memory'` | `{ dir }`: keep the ENCRYPTED blocks on disk between runs (Node) |
| `write` | `false` | allow `insert`, `update`, `delete` |
| `live` | `true` | keep the copy current (live stream on Solo and above, polling otherwise); `false`: one copy, then `refresh()` |
| `pollSeconds` | `300` | polling interval without a stream (300 at least) |
| `files` | the contract's filter | `{ maxBytes, deny, allow }` for `files.deposit()` |
| `fetch` | global `fetch` | a `fetch` to use (proxy, tests) |
| `streamOpener` | WebSocket | advanced; `null`: never a stream |
| `onLog` | none | receives the replica's log: `{ what, code, note? }` |
| `signal` | none | an `AbortSignal` that cancels the opening |

Returns once the first copy is ready. Throws a `GateError`: `token_required`, `api_access_unknown`,
`api_access_revoked`, `api_access_expired` (401), `aborted` (499).

## `Gate`

| member | |
|---|---|
| `bases(): BaseSummary[]` | the databases opened: `slug`, `title`, `rights` (`r` or `rw`), `status`, `version`, `rows`, `fields`, `views` |
| `base(slug): Base` | one database; throws `base_not_found`, or `503` while it is not loaded |
| `sql(query, { bases? }): Promise<SqlResult>` | a read-only query; `bases` limits the tables to some slugs |
| `on('change', fn)`, `on('status', fn)` | listen; returns a function that unsubscribes |
| `status(): GateStatus` | `link`, `detail`, `accessId`, `accessName`, `tier`, `filarrWrite`, `creator`, `files`, `bases`, `lastChangeAt`, `quota` |
| `files.deposit(data, { name, mimeType?, path?, tags?, source? })` | deposit a file into the linked deposit box: `{ depositId, seq, status, depositedAt, sizeBytes, sha256 }` |
| `files.status(depositId)` | `{ status, depositedAt, filedAt }` |
| `refresh()` | read everything again from Filarr |
| `wake(rawBody, signatureHeader)` | a push wake-up received by YOUR server: checks the `Filarr-Notify` signature and the time window, then re-reads; `false` if refused |
| `close()` | stop, and wipe the keys and the rows from memory |
| `accessId`, `accessName` | the access, as Filarr knows it |

## `Base`

| member | |
|---|---|
| `slug`, `title`, `rights`, `version`, `fields`, `views` | read at each access (they follow the copy) |
| `rows(options?): Promise<RowList>` | `where`, `sort`, `limit`, `cursor`, `fields`, `q`, `since`; an array with `next`, `total`, `version`, `unresolved?` |
| `row(id): Promise<Row \| null>` | one row |
| `view(slug): View` | `view.rows({ limit, cursor })`; throws `view_not_found` |
| `insert(row)`, `insert(rows[])` | one commit; the new row(s) |
| `update(id, patch)` | the row after the change |
| `delete(id)` | |

`where` takes, per field, a value (equals) or `{ eq, ne, lt, lte, gt, gte, contains, in: [...], empty: boolean }`, all
combined with AND.

## `ChangeEvent`

`{ base, version, origin: 'filarr' | 'gate', added: Row[], changed: Array<{ before, after }>, removed: Row[] }`.

## `GateError`

An `Error` with `status` (the HTTP status the local API would return), `code` (the same codes as the local API:
[errors.md](errors.md)) and `extra` (`retryAfter`, `field`, `keys`, `limit`…).

## Where it runs

Node 20 and newer, tested. It uses standard Web APIs only (WebCrypto, `fetch`, WebSocket), so Deno, Bun and Cloudflare
Workers should run it; they are not tested. Its dependencies: `@noble/curves`, `@noble/hashes` and `fflate`.
The version it reports to Filarr is `lib-<version>`.
