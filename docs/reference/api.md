# The local API

[Lire en français](api.fr.md)

Every gate serves this API from its decrypted copy of the databases opened to its access. The routes common to every
gate are described in OpenAPI 3.1 in [../openapi/filarr-gate.v1.json](../openapi/filarr-gate.v1.json) (checked route by
route against a running gate by the test suite); each gate serves its EXACT description at `/openapi.json`, with its
databases, typed fields, views and saved queries, and a readable page at `/docs`.

Tutorial: [call the API](../tutorials/first-calls.md). Codes: [errors.md](errors.md).

## Authentication

Every call to `/v1/*` and `/mcp` carries an **app key**: `Authorization: Bearer gk_…` (or `X-Gate-Key: gk_…`). App keys
are created on the gate (management UI, **App keys**, or `filarr-gate keys create`), shown once, stored as a SHA-256
fingerprint. Each key has:

| property | |
|---|---|
| endpoints | all databases and views (read), or chosen databases (read, create, update, delete), views, saved queries, and the file slot |
| SQL, MCP | the right to call `/v1/sql` (on the databases it reads), and `/mcp` |
| rate | requests per minute (600 by default): above it, `429 key_rate` with `Retry-After` |
| allowed addresses | IP addresses or CIDR ranges; others get `403 ip_forbidden`. Behind a reverse proxy, set `trust_proxy` |
| expiry | after it, `403 key_expired` |
| pause | `403 key_paused` until resumed |

`/health` and `/metrics` need no key; `/openapi.json` and `/docs` need none while the `docs` setting is on (default).

## Routes

| method and path | |
|---|---|
| `GET /v1/<base>` | the rows of a database (also `GET /v1/<base>/rows`) |
| `GET /v1/<base>/<view>` | a view, replayed by Filarr's view engine |
| `GET /v1/<base>/rows/<id>` | one row: `{ row, version, unresolved? }` |
| `POST /v1/<base>` | create one row (object) or several (array, 500 at most) |
| `PATCH /v1/<base>/rows/<id>` | change fields of a row (also `PATCH /v1/<base>/<id>`) |
| `DELETE /v1/<base>/rows/<id>` | delete a row (also `DELETE /v1/<base>/<id>`) |
| `POST /v1/sql` | a read-only SQL query |
| `GET /v1/q/<query>` | a saved query, rows as objects |
| `POST /v1/files`, `GET /v1/files/<id>` | deposit a file, its status ([files](../tutorials/receive-files.md)) |
| `POST /mcp` | the MCP server ([mcp.md](mcp.md)) |
| `GET /openapi.json`, `GET /docs` | this gate's description |
| `GET /health` | `{ status: "ok" \| "degraded", link, version, bases: [{ slug, status, version }] }` |
| `GET /metrics` | Prometheus metrics (below) |
| `POST /_filarr/notify` | Filarr's push wake-ups (not for your software) |

`<base>` and `<view>` are **slugs**: chosen in Filarr when the database is opened, then kept even when the database or
the view is renamed. A view created later gets its slug when Filarr publishes it.

## Rows as JSON

```json
{ "id": "r_acme", "nom": "Acme", "ville": "Lyon", "statut": "Client", "ca": 12500, "dernier_contact": "2026-10-03",
  "commandes": ["r_c1", "r_c3"], "total_commande": 1540.5, "created_at": "2026-09-01T08:00:00.000Z", "updated_at": "…" }
```

- **Field names** follow the column names: lower case, no accents, `_` between words, 48 characters at most, a
  leading digit prefixed `c_`; a second column with the same name gets `_2`. `id`, `created_at` and `updated_at` are
  reserved. The server gate **keeps** a name once given: renaming a column in Filarr does not change it. (The library
  computes names at each start.)
- **Values**, by Filarr column type:

| Filarr type | JSON | written as |
|---|---|---|
| text, URL, e-mail, phone | string or `null` | a string |
| number, rating, progress | number or `null` | a number |
| checkbox | `true` / `false` | a boolean |
| select | the option's label, or `null` | a label (or an option id) of the column |
| multi-select | array of labels | an array of labels |
| date | `"YYYY-MM-DD"` (or a date-time) | `YYYY-MM-DD`, or an ISO date-time |
| relation | array of row ids | an array of row ids (one at most for a single relation) |
| person | array of names | an array of names |
| file of a vault | `{ fileId, folderId, name }` | the same object |
| formula, rollup, created time, updated time, back-link | computed | read only (`400 field_read_only`) |

- **Relations to a database not opened to the access** give the raw ids; a rollup over it gives `null`; the field is
  listed in `unresolved` of the page.

## Reading

| parameter | |
|---|---|
| `field=value` | equals |
| `field[op]=value` | `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains`, `in`, `empty` |
| `sort=a,-b` | sort keys; `-` for descending; empty values last |
| `fields=a,b` | the fields returned (`id` always) |
| `q=text` | quick search in the text, as in Filarr |
| `limit` | 100 by default, 1000 at most |
| `cursor` | the `next` of the previous page |
| `since=<version>` | only the rows changed after that version |

How filters compare:

- texts: without case or accents (`ville=lyon` matches "Lyon"); `contains` looks inside;
- numbers: as numbers (`ca[gte]=1000`); booleans: `1`, `true`, `yes`, `oui` are true;
- lists (multi-select, relations, persons): `eq` and `contains` match one element, `ne` none, `in` any of the values;
- `in`: values separated by commas; `empty=true` matches `null`, `""` and `[]`, `empty=false` the others.

A page is `{ rows, next, total, version, unresolved? }`. `next` is an offset (`o200`): rows added between two pages can
shift it; to follow changes, use `version` and `since`, or webhooks.

A view (`GET /v1/<base>/<view>`) applies its own filters, sort and visible columns first, then the parameters above.
A Query view (SQL) returns its result as objects (`columns` too) and takes `limit` and `cursor` only.

## SQL

`POST /v1/sql` with `{ "sql": "SELECT …" }` (SQLite dialect, Filarr's SQL engine, `SELECT` and `WITH … SELECT` only)
returns `{ columns, rows, ms, scanned, truncated }`, rows as arrays, 10,000 at most. The tables are those of Filarr's
Query view: one per database, named after its title (lower case, no accents, `_` between words), one column per
column (computed columns left out), a single relation as a foreign key `<relation>_id`, a multiple one as a junction
table; a database that is not opened appears with its `id` only. The key reads only the databases it may read.

**Saved queries** (management UI, **SQL explorer › Save as an endpoint**) are served at `GET /v1/q/<slug>`, rows as
objects, with `limit` and `cursor`, to keys allowed to read them.

## Writing

Writing needs: the gate's `write` setting (off by default), the database in read and write on the access, a plan with
API writes, and an app key with the create, update or delete right on that database.

- `POST /v1/<base>`: an object creates one row; an array creates up to 500 in **one commit**. The columns left out get
  their default value (the default option of a select), as "New row" does in Filarr; a field given as `null` stays
  empty. Answer `201`: `{ id, row, version, validated: true }` (or `{ rows, version, validated: true }` for an array).
- `PATCH /v1/<base>/rows/<id>`: changes the fields given, `null` empties one. Answer `{ id, row, version, validated }`.
- `DELETE /v1/<base>/rows/<id>`: `{ id, deleted: true, version, validated }`. A deletion wins over a concurrent change;
  the row can be restored in Filarr.
- **`Idempotency-Key`**: the same key, app key, method and path within 24 hours returns the first answer
  (`Idempotency-Replayed: true`) and writes nothing. Kept in memory.
- Each write is "last writer wins" per cell, stamped with the gate's clock, committed to Filarr like any device's
  write. On a concurrent write the gate re-reads and replays, invisibly.
- Columns fed by an external source: `409 field_managed`; a mirrored database: `409 rows_managed`.
- `validated: true` means Filarr accepted the commit. `503 filarr_unreachable` means nothing was written.

Restrictions to some columns or to a view are applied by the gate (the app key's endpoints), not by the encryption: the
access's key opens the whole database.

## Headers

| header | |
|---|---|
| `X-Filarr-Version` | the version of the database served (answers of `/v1/<base>…`) |
| `X-Gate-Base-Status` | present when the database is served from its last complete copy while something is wrong (`missing_key`…) |
| `Retry-After` | on a `429`: seconds to wait |
| `Idempotency-Replayed: true` | a replayed answer |
| `Cache-Control: no-store` | on every answer |

## CORS

Closed by default: a request that carries an `Origin` header is refused (`403 origin_forbidden`) unless the origin is
in `cors_origins`. Allowed origins get `Access-Control-Allow-Origin`, the methods `GET, POST, PATCH, DELETE, OPTIONS`,
and the headers `Authorization`, `Content-Type`, `Idempotency-Key`, `X-Gate-Key`, `X-File-Name`, `Mcp-Session-Id`,
`Mcp-Protocol-Version`. A key used from a web page is visible to anyone who opens the page: give it only what the page
must do (see [examples/public-form](../../examples/public-form)).

## Metrics

`GET /metrics` (Prometheus text format, the `metrics` setting, on by default):

| metric | |
|---|---|
| `filarr_gate_requests_total{route,code}` | requests served by the local API |
| `filarr_gate_request_duration_seconds{route}` | their duration (histogram) |
| `filarr_gate_webhook_deliveries_total{result}` | webhook deliveries: `ok`, `retry`, `abandoned` |
| `filarr_gate_filarr_requests_total{code}` | requests sent to Filarr |
| `filarr_gate_commits_total`, `filarr_gate_commit_conflicts_total` | commits accepted by Filarr, and conflicts replayed |
| `filarr_gate_rows_changed_total{base}` | rows changed, per database |
| `filarr_gate_files_total{result}` | files deposited, refused before sending, refused by Filarr |
| `filarr_gate_link_up` | 1 when the link with Filarr is live or polling |
| `filarr_gate_base_rows{base}`, `filarr_gate_base_version{base}`, `filarr_gate_base_ready{base}` | per database |
| `filarr_gate_quota_used{name}`, `filarr_gate_quota_max{name}` | Filarr's counters (`sync`, `bytes`, `writes`) |

Metrics never carry a row, a key or a token. `/metrics` has no key: keep the API on a network you trust, or switch it
off (`metrics = false`).

## Limits of the local API

| | |
|---|---|
| JSON body | 4 MiB |
| rows per create | 500 |
| rows per page | 1000 |
| SQL | 64 KiB of query, 10,000 rows returned |
| file | the size Filarr allows, never above 100 MiB, lower if `files_max_bytes` says so |

What Filarr counts, and how the gate reacts to each limit: [limits.md](limits.md).
