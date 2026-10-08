# Filarr Gate

**Serve a Filarr database as an API, without Filarr ever seeing your data.**

[Lire en français](README.fr.md)

> **Status: v0.1, ahead of the server.** The gate implements the frozen contract `api-base-1` (revision 2) and the
> store protocol `db-store-1` (revision 3.9). The Filarr side is built and was tested end to end with this gate against
> a local Filarr server (read, live changes, write, revocation), but it is not in service yet (`API_BASE_SWITCH`,
> `API_BASE_WRITE` off); it will open account by account. Until then, try the gate against the in-memory Filarr
> shipped in this repository (see [Try it locally](#try-it-locally)).

Filarr encrypts your notes and databases end to end: the Filarr servers store blocks they cannot read. That rules out
the usual "API key on the vendor's server". Filarr Gate is the other way round: a small **black box you run yourself**
(on your PC, in Docker, on your own server) that holds the key to the databases you open to it, keeps a decrypted copy
in memory, and serves your software locally.

```
 Filarr app ──(encrypted blocks)──▶ Filarr servers ──(encrypted blocks)──▶ Filarr Gate ──(plain JSON)──▶ your ERP, BI, site, AI agent
                                         sees nothing                     on your machine
```

## What it does

- **Endpoints from views.** Each database becomes `GET /v1/<database>`, and each of its views
  `GET /v1/<database>/<view>`, replayed by Filarr's own view engine (filters, sorts, visible columns). Slugs are fixed
  by the Filarr app when the database is opened: renaming a view never breaks an integration.
- **SQL, read-only.** `POST /v1/sql` runs a `SELECT` with Filarr's own SQL engine (SQLite semantics, joins,
  aggregates) over the databases the key may read. Saved queries become `GET /v1/q/<name>`.
- **OpenAPI 3.1** generated from the column types (`/openapi.json`, readable at `/docs`).
- **Signed webhooks.** A row is added, changed or deleted in Filarr: the gate decrypts it and calls your URL, signed
  with HMAC-SHA256 (`Filarr-Gate-Signature: t=…,v1=…`), 8 attempts over 24 h with a doubling delay. A webhook can
  follow a view, filter with a SQL condition, fire only when the condition *becomes* true, and resolve relations.
- **App keys.** Your software never gets the Filarr token: each app gets its own key (`gk_…`, stored hashed), scoped to
  databases, views or saved queries, read or create/update/delete, with a rate limit, an IP allow-list and an expiry.
- **Writes** (off by default): `POST`, `PATCH`, `DELETE` on `/v1/<database>[/rows/<id>]` become last-writer-wins
  registers, sealed and committed to Filarr with compare-and-swap, like any Filarr device.
- **MCP server** for AI assistants (streamable HTTP on `/mcp`, and stdio with `filarr-gate mcp`), read-only.
- **Prometheus metrics** on `/metrics`, a health probe on `/health`, a local log (JSON Lines, 30 days).
- **A full management UI** (French and English): first launch, dashboard, databases and endpoints, SQL explorer,
  app keys, webhooks, log, usage and limits, settings.

## Install

Node.js 20 or later.

```sh
# from npm (once the package is published)
npx filarr-gate

# from source
git clone <this repository> filarr-gate && cd filarr-gate
npm ci && npm run build
node dist/cli.js
```

Then open the management UI at <http://127.0.0.1:8787/admin/> and follow the three steps: paste the token shown by
Filarr ("···" › "Open to an API" on a database), choose where the API listens, set an admin password.

Without the UI:

```sh
filarr-gate init --token flr_live_… --port 8443 --admin-password '…'
filarr-gate                      # serve
filarr-gate keys create --name ERP --sql   # a read key on every view, printed once
```

### Docker

```sh
docker build -t filarr-gate .
docker run -d --name filarr-gate \
  -e FILARR_GATE_TOKEN=flr_live_… \
  -e FILARR_GATE_ADMIN_PASSWORD='a long password' \
  -p 8443:8443 -p 127.0.0.1:8787:8787 \
  -v filarr-gate:/var/lib/filarr-gate \
  filarr-gate
```

The image runs as the non-root `node` user, keeps its state in the `/var/lib/filarr-gate` volume and has a
`HEALTHCHECK` on `/health`. Publish the management port on `127.0.0.1` only. If you set up through the UI instead of
the environment, the first launch asks for the setup code printed by `docker logs filarr-gate`.

### Cloudflare (later)

A "deploy to your own Cloudflare account" variant (a Worker with a Durable Object holding the copy) is planned. It is
not built yet.

## Configuration

Environment variables win over `gate.toml` (in the state directory, or `FILARR_GATE_CONFIG`), which wins over what
you set in the UI. A setting fixed by the environment or the file is shown locked in the UI.

| variable | `gate.toml` | default | |
|---|---|---|---|
| `FILARR_GATE_TOKEN` | — | — | the access token; kept in memory only, never written to disk |
| `FILARR_GATE_STATE_DIR` | — | `~/.filarr-gate` | state: token (0600), `state.json` (0600), encrypted block cache, log |
| `FILARR_GATE_API_URL` | `api_url` | `https://api.filarr.com` | the Filarr API (point it at a local worker to test) |
| `FILARR_GATE_HOST` / `_PORT` | `host` / `port` | `127.0.0.1` / `8443` | the local API |
| `FILARR_GATE_ADMIN_HOST` / `_PORT` | `admin_host` / `admin_port` | `127.0.0.1` / `8787` | the management UI |
| `FILARR_GATE_ADMIN_PASSWORD` | — | — | headless admin password |
| `FILARR_GATE_WRITE` | `write` | `false` | writes to Filarr (§ 7 of the contract) |
| `FILARR_GATE_TLS_CERT` / `_KEY` | `tls_cert` / `tls_key` | — | HTTPS for the local API (PEM paths) |
| `FILARR_GATE_CORS_ORIGINS` | `cors_origins` | none | web pages allowed to call the API; others are refused |
| `FILARR_GATE_TRUST_PROXY` | `trust_proxy` | none | proxies whose `X-Forwarded-For` is trusted |
| `FILARR_GATE_METRICS` / `_MCP` / `_DOCS` | `metrics` / `mcp` / `docs` | on / off / on | `/metrics`, `/mcp`, public `/docs` and `/openapi.json` |
| `FILARR_GATE_JOURNAL_DAYS` | `journal_days` | `30` | local log retention |
| `FILARR_GATE_CACHE` | `cache` | `disk` | `memory`: keep nothing on disk, not even encrypted blocks |
| `FILARR_GATE_POLL_SECONDS` | `poll_seconds` | `300` | polling interval without the live stream (never below 300) |

```toml
# gate.toml
host = "0.0.0.0"
port = 8443
write = true
cors_origins = ["https://www.example.com"]
```

## Try it locally

The repository ships the in-memory Filarr used by the tests: it serves the gate-facing routes of the contract, with
three demo databases, and makes an app edit every 20 seconds.

```sh
npm ci
npm run mock-filarr                    # prints a token; MOCK_TIER=free for the Free plan
FILARR_GATE_API_URL=http://127.0.0.1:8790 FILARR_GATE_TOKEN=flr_live_… npm start
```

To test against the real worker instead, run `wrangler dev` in the Filarr worker, turn `API_BASE_SWITCH` (and
`API_BASE_WRITE`) on for the test account, create an access from the Filarr app, and set `FILARR_GATE_API_URL` to the
local worker. `wrangler dev` listens on 8787 by default: move the management UI with `FILARR_GATE_ADMIN_PORT`.

## API reference (summary)

Every `/v1` call carries an app key: `Authorization: Bearer gk_…`.

| route | |
|---|---|
| `GET /v1/<database>` | rows: `limit` (≤ 1000), `cursor`, `fields=a,b`, `sort=a,-b`, `q=text`, `since=<version>`, filters `field=value` or `field[op]=value` (`eq ne lt lte gt gte contains in empty`) |
| `GET /v1/<database>/<view>` | the view replayed by Filarr's engine (a Query view returns its SQL result) |
| `GET /v1/<database>/rows/<id>` | one row |
| `POST /v1/<database>` | create one row (object) or several (array, ≤ 500); `Idempotency-Key` honoured |
| `PATCH /v1/<database>/rows/<id>` | update fields (`null` clears) |
| `DELETE /v1/<database>/rows/<id>` | delete (deletion wins over concurrent edits, as in Filarr) |
| `POST /v1/sql` | `{ "sql": "SELECT …" }`, read-only (`400 sql_read_only` otherwise) |
| `GET /v1/q/<query>` | a saved query |
| `GET /openapi.json`, `GET /docs` | the description |
| `POST /mcp` | MCP (JSON-RPC): `list_bases`, `query_view`, `get_row`, `run_sql` |
| `GET /health`, `GET /metrics` | probe and Prometheus |

A row is `{ "id", <fields>, "created_at", "updated_at" }`. Field names follow the column names (`Dernier contact` →
`dernier_contact`) and are kept when a column is renamed. Select values are option labels, relations are row ids,
rollups and formulas are computed by Filarr's engine. A relation to a database the token does not open returns raw ids,
and its aggregates are `null`, listed in the page's `unresolved` (contract § 8). Lists answer
`{ rows, next, total, version }`.

Webhook deliveries are `POST` with `Filarr-Gate-Event`, `Filarr-Gate-Delivery` and
`Filarr-Gate-Signature: t=<seconds>,v1=<hex>`, where `v1 = HMAC-SHA256(secret, t + "." + raw body)`. Verify on the raw
body and reject a timestamp older than 5 minutes.

## Security model, in short

- One access token opens **only the databases you choose**, never your account, notes or files. The token never
  leaves the gate: it derives `A_auth` (the proof Filarr checks against a hash) and `A_enc` (the key that opens the
  sealed database keys) on the spot, and wipes the secret from memory.
- Each sealed database key is checked against its place (access, store, epoch, generation) before use; a key found in
  the wrong place is refused, never used. Every block is checked against the head's MAC before it is decrypted.
- Decrypted rows live in memory only. The disk holds encrypted blocks (as Filarr stores them), the token (0600), app
  key hashes and webhook secrets. On revocation everything is wiped, cache included.
- Revoking an access is instant on the server, and the database keys move to a new generation: a revoked token cannot
  read anything written afterwards. A missing key is shown as "missing key for (e, g)"; a block is never skipped.
- A gate reads whole databases: a view is a convenience, not a cryptographic boundary. Treat the machine running it,
  and anyone with the management password, as holding the data.

Details: [docs/architecture.md](docs/architecture.md).

## Plans and limits

Filarr Gate works on every Filarr plan, Free included. Filarr only counts what goes through its servers (sync
requests, downloaded bytes, accepted commits); reads served by your gate are never counted. The limits are published by
Filarr at `/public/api-limits` and shown in the "Usage and limits" screen; on Free there is no live stream and the gate
polls every 300 seconds. When a limit is reached, the gate keeps serving its last copy and honours `Retry-After`.

## Development

```sh
npm test            # vitest: golden vectors of both contracts, replica, local API, UI translations
npm run typecheck
npm run build       # dist/cli.js (esbuild) and dist/ui (Vite + Preact)
```

`src/core` is a verbatim copy of Filarr's portable core (store crypto, codec, registers, view engine, SQL engine),
relicensed under Apache-2.0 by its rights holder; `src/core/PROVENANCE.json` lists each file with its source commit,
and `scripts/copy-core.mjs` refreshes it. Only the platform imports of two files point to small shims.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).

## Security

Please report vulnerabilities privately: see [SECURITY.md](SECURITY.md).
