# @filarr/gate

Read and write the rows of a Filarr database opened to an API, from your own code, without Filarr ever seeing your
data. The library replicates the encrypted blocks, opens them with the keys sealed to your access token, and keeps the
rows in memory. No HTTP server: for that, see [`filarr-gate`](https://github.com/matbel91765/filarr-gate).

```js
import { openGate } from '@filarr/gate';

const gate = await openGate({ token: process.env.FILARR_GATE_TOKEN });

const actifs = await gate.base('clients').view('clients-actifs').rows();
const page = await gate.base('clients').rows({ where: { ca: { gte: 1000 } }, sort: '-ca', limit: 50 });
const { rows } = await gate.sql('SELECT ville, count(*) AS n FROM clients GROUP BY ville');

gate.on('change', (event) => console.log(event.base, event.added, event.changed, event.removed));
await gate.close();
```

The token comes from Filarr ("···" on a database › **Open to an API**). Node 20+ (tested); standard Web APIs only
(WebCrypto, `fetch`, WebSocket).

## `openGate(options)`

| option | default | |
|---|---|---|
| `token` | — | the access token (`flr_live_…`) |
| `apiUrl` | `https://api.filarr.com` | the Filarr API |
| `write` | `false` | allow `insert`, `update`, `delete` (Filarr must allow writing for the access too) |
| `live` | `true` | the live stream (or polling) after the first copy; `false`: call `refresh()` yourself |
| `pollSeconds` | `300` | polling without the stream (never below 300) |
| `cache` | `'memory'` | `{ dir }`: keep the encrypted blocks on disk between runs (Node) |
| `fetch`, `streamOpener` | the platform's | transport overrides |
| `onLog`, `signal` | — | log lines; cancel the opening |

It resolves when the first copy is ready, and rejects with a `GateError` (`code`, `status`) when the token is unknown,
revoked or expired.

## The `Gate`

- `bases()` — the opened databases, their fields and views.
- `base(slug).rows(options)` — `where` (`{ field: value }` or `{ field: { gte, lt, contains, in, empty… } }`), `sort`,
  `limit`, `cursor`, `fields`, `q`, `since`. A page is an array with `next`, `total`, `version` (and `unresolved` for
  relations to databases the token does not open).
- `base(slug).row(id)`, `base(slug).view(slug).rows()` — one row; a view replayed by Filarr's view engine.
- `base(slug).insert(rows)`, `.update(id, fields)`, `.delete(id)` — with `write: true`.
- `sql(query)` — read-only SQL with Filarr's engine: `{ columns, rows, ms, scanned, truncated }`.
- `files.deposit(bytes, { name, mimeType, path, tags, source })`, `files.status(id)` — when the creator linked a
  deposit box to the access; executables and files over 100 MiB are refused before anything is sent.
- `on('change' | 'status', listener)` (returns an unsubscribe function), `status()`, `refresh()`.
- `wake(rawBody, header)` — hand over a Filarr push wake-up received by your own HTTP server; checked, then re-read.
- `close()` — stops and wipes the keys and rows from memory.

Rows are `{ id, <fields>, created_at, updated_at }`; field names follow the column names (`Dernier contact` →
`dernier_contact`) and are kept when a column is renamed.

## License

Apache-2.0.
