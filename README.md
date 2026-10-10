# Filarr Gate

**Serve a Filarr database as an API, without Filarr ever seeing your data.**

[Lire en français](README.fr.md)

> **Status: v0.2, ahead of the server.** The gate implements the frozen contracts `api-base-1` (revisions 2 and 3),
> `db-store-1` (3.9), `gate-fichiers-1`, `source-externe-1` and the settings package of `gate-heberge-1`. It is tested
> end to end against a local Filarr server (reads, live changes, writes, revocation, an external PostgreSQL sync, a
> file deposit, the Cloudflare variant). The Filarr side is merged but switched off (`API_BASE_SWITCH`,
> `GATE_FILES_SWITCH`…); it opens account by account. Nothing is published to npm or a registry yet.

Filarr encrypts your notes and databases end to end: its servers store blocks they cannot read. Filarr Gate is a small
**black box you run yourself** (in your code, on a PC, in Docker, on your own Cloudflare account) that holds the key to
the databases you open to it, keeps a decrypted copy in memory, and serves your software.

```
 Filarr app ──(encrypted blocks)──▶ Filarr servers ──(encrypted blocks)──▶ Filarr Gate ──(plain JSON)──▶ your ERP, BI, site, AI agent
                                         sees nothing                     yours
```

In Filarr: "···" on a database › **Open to an API** gives a token (`flr_live_…`), shown once.

## Four ways to run it

### 1. In your code: `@filarr/gate`

```js
import { openGate } from '@filarr/gate';

const gate = await openGate({ token: process.env.FILARR_GATE_TOKEN });
const actifs = await gate.base('clients').view('clients-actifs').rows();
```

Node 20+ (tested); it uses standard Web APIs only (WebCrypto, `fetch`, WebSocket), so Deno, Bun and Workers should
run it, untested there. Two small dependencies (`@noble/*`, `fflate`). `rows()`, `row(id)`,
`view(slug).rows()`, `sql()`, `insert()`/`update()`/`delete()` (with `write: true`), `on('change')`,
`files.deposit()`, `status()`, `close()`. The complete example, [examples/library-node](examples/library-node/index.mjs),
runs in the test suite.

### 2. On a machine: `filarr-gate`

```sh
npx filarr-gate init --token flr_live_… --admin-password '<ten characters or more>'
npx filarr-gate                                  # local API on 127.0.0.1:8443, UI on http://127.0.0.1:8787/admin/
npx filarr-gate keys create --name ERP --sql     # an app key, printed once
```

From source: `npm ci && npm run build`, then `node packages/cli/dist/cli.js` instead of `npx filarr-gate`.

### 3. In Docker

```sh
docker build -t filarr-gate .
docker run -d --name filarr-gate -e FILARR_GATE_TOKEN=flr_live_… -p 8443:8443 -v filarr-gate:/data filarr-gate
docker exec filarr-gate filarr-gate keys create --name ERP
```

The image runs as a non-root user, keeps everything in the `/data` volume, and has a health check. (Its build is not
yet exercised by the test suite; the same build and run steps are.) Add
`-p 127.0.0.1:8787:8787 -e FILARR_GATE_ADMIN_PASSWORD=…` for the management UI (whoever enters it reads the data).

### 4. On your Cloudflare account

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/matbel91765/filarr-gate)

Or by hand: `npm ci && npm run build && npx wrangler deploy`, then `npx wrangler secret put FILARR_GATE_TOKEN` and
`npx wrangler secret put FILARR_GATE_ADMIN_PASSWORD`. A Worker and a Durable Object hold the copy; the API is the
Worker's address, the UI is under `/admin/`. See [docs/cloudflare.md](docs/cloudflare.md).

## What it does

- **Endpoints from views.** `GET /v1/<database>` and `GET /v1/<database>/<view>`, replayed by Filarr's own view
  engine; slugs are fixed by the app, so renaming a view never breaks an integration. `POST /v1/sql` (read-only,
  Filarr's SQL engine), saved queries, OpenAPI 3.1 (`/openapi.json`, `/docs`).
- **App keys.** Your software never gets the Filarr token: each app gets a `gk_…` key (stored hashed) scoped to
  databases, views, queries or the file slot, with a rate limit, an IP allow-list and an expiry.
- **Writes** (off by default): `POST`, `PATCH`, `DELETE` become last-writer-wins registers committed to Filarr.
- **Signed webhooks** on row changes, file filings and syncs (HMAC-SHA256, retried for 24 h).
- **File slot** (`POST /v1/files`): files are sealed for the deposit box the creator linked and signed in Filarr;
  executables and oversized files are refused before anything leaves. The Filarr app files them; neither Filarr nor the
  gate knows where.
- **External databases**: the syncs Filarr assigns to this gate (D1, PostgreSQL, MySQL, Supabase, Airtable, Google
  Sheets, Notion, CSV/JSON) run here, with your keys, which never reach Filarr. See
  [docs/external-databases.md](docs/external-databases.md).
- **Push wake-ups** (`/_filarr/notify`, HMAC-signed by Filarr) for gates that sleep or poll.
- **Migration**: the settings package (keys, webhooks, queries, sync state) moves sealed to the next gate.
- **MCP** for AI assistants, **Prometheus** metrics, a local log, and a management UI in French and English.

## Command line

| command | |
|---|---|
| `filarr-gate [serve]` | start the local API and the management UI |
| `filarr-gate init --token … [--port] [--admin-port] [--admin-password] [--write] [--import FILE]` | store the token (0600) and settings |
| `filarr-gate keys create --name N [--sql] [--mcp] [--files]` · `keys list` · `keys revoke ID` | app keys |
| `filarr-gate sources list` · `sources key ID --stdin` · `sources run ID` · `sources pause/resume ID` | external syncs |
| `filarr-gate files test` · `files status ID` | the file slot |
| `filarr-gate export --for-token … --out FILE` · `filarr-gate import FILE` | migration package |
| `filarr-gate doctor` | clock, Filarr, token, creator key, databases, quotas, files, syncs (exit 1 on failure) |
| `filarr-gate health` · `filarr-gate mcp` · `filarr-gate version` | probe, MCP over stdio, version |

`--json` everywhere. On the machine of a running gate (`docker exec` included), commands go through it without a
password; `--remote URL --admin-password …` reaches one on another machine.

## Configuration

Environment variables win over `gate.toml` (in the state directory, or `FILARR_GATE_CONFIG`), which wins over the UI.
A setting fixed by the environment or the file is shown locked.

| variable | `gate.toml` | default | |
|---|---|---|---|
| `FILARR_GATE_TOKEN` | — | — | the access token; never written to disk when given here |
| `FILARR_GATE_STATE_DIR` | — | `~/.filarr-gate` (`/data` in Docker) | state, encrypted block cache, log, encrypted sync state |
| `FILARR_GATE_API_URL` | `api_url` | `https://api.filarr.com` | the Filarr API |
| `FILARR_GATE_HOST` / `_PORT` | `host` / `port` | `127.0.0.1` / `8443` | the local API |
| `FILARR_GATE_ADMIN_HOST` / `_PORT` | `admin_host` / `admin_port` | `127.0.0.1` / `8787` | the management UI |
| `FILARR_GATE_ADMIN_PASSWORD` | — | — | admin password without the setup screen |
| `FILARR_GATE_WRITE` | `write` | `false` | writes to Filarr |
| `FILARR_GATE_TLS_CERT` / `_KEY` | `tls_cert` / `tls_key` | — | HTTPS for the local API |
| `FILARR_GATE_CORS_ORIGINS` | `cors_origins` | none | web pages allowed to call the API |
| `FILARR_GATE_TRUST_PROXY` | `trust_proxy` | none | proxies whose `X-Forwarded-For` is trusted |
| `FILARR_GATE_METRICS` / `_MCP` / `_DOCS` | `metrics` / `mcp` / `docs` | on / off / on | `/metrics`, `/mcp`, `/docs` |
| `FILARR_GATE_NOTIFY` | `notify` | on | accept Filarr's push wake-ups |
| `FILARR_GATE_FILES_DENY` / `_ALLOW` / `_MAX_BYTES` | `files_deny` / `files_allow` / `files_max_bytes` | contract list / none / 100 MiB | the file filter |
| `FILARR_GATE_JOURNAL_DAYS` | `journal_days` | `30` | local log retention |
| `FILARR_GATE_CACHE` | `cache` | `disk` | `memory`: nothing on disk, not even encrypted blocks |
| `FILARR_GATE_POLL_SECONDS` | `poll_seconds` | `300` | polling without the live stream (never below 300) |
| `FILARR_GATE_EXTDB_<ID>` | `[extdb."xs_…"] secret` | — | the key of an external database (see its screen) |
| `FILARR_GATE_LOG_LEVEL` | — | `info` | `debug`, `info`, `warn`, `error` |

## API (summary)

Every call carries an app key: `Authorization: Bearer gk_…`.

| route | |
|---|---|
| `GET /v1/<database>` | rows: `limit` (≤ 1000), `cursor`, `fields`, `sort`, `q`, `since`, filters `field=value` or `field[op]=value` |
| `GET /v1/<database>/<view>` · `GET /v1/<database>/rows/<id>` | a view, one row |
| `POST /v1/<database>` · `PATCH`/`DELETE /v1/<database>/rows/<id>` | writes (`409 field_managed` on a column fed by an external source) |
| `POST /v1/sql` · `GET /v1/q/<query>` | read-only SQL, saved queries |
| `POST /v1/files` · `GET /v1/files/<id>` | deposit a file (multipart or raw body), its status |
| `POST /mcp` · `GET /openapi.json` · `GET /health` · `GET /metrics` | MCP, description, probe, metrics |

Webhooks are `POST` with `Filarr-Gate-Event`, `Filarr-Gate-Delivery` and `Filarr-Gate-Signature: t=…,v1=…`, where
`v1 = HMAC-SHA256(secret, t + "." + raw body)`.

## Security, in short

- A token opens **only the databases you choose**, never the account. It never leaves the gate: the keys are derived on
  the spot and the secret is wiped from memory. Every sealed key is checked against its place before use; every block
  against the head's MAC before decryption.
- The creator's identity key is authenticated by a tag only the token can compute; deposit boxes, sync definitions and
  a migration's target are accepted only when signed by that key. A server cannot substitute its own.
- Decrypted rows live in memory only. The disk holds encrypted blocks, app key hashes, webhook secrets, external
  database keys encrypted under a key derived from the token, and encrypted sync state. Revocation wipes it all.
- Whoever runs the gate, or holds the management password, holds the data. Views are a convenience, not a boundary.

Details: [docs/architecture.md](docs/architecture.md), [SECURITY.md](SECURITY.md).

## Development

```sh
npm ci
npm test            # unit and integration tests, against an in-memory Filarr (plus wrangler dev and PostgreSQL when present)
npm run typecheck
npm run build
npm run mock-filarr # an in-memory Filarr with demo databases, for trying the gate by hand
```

End to end against the real Filarr worker, run locally by the Filarr bench: see the header of
[test/worker.e2e.test.ts](test/worker.e2e.test.ts) (`npm run test:e2e`).

Layout: `packages/core` (Filarr's portable core, copied verbatim and relicensed Apache-2.0, plus the gate's pure
modules), `packages/gate` (the library), `packages/server` (the engine-agnostic black box), `packages/cli` (Node, the
UI, Docker), `packages/cloudflare` (the Worker). Release plan: [docs/release.md](docs/release.md).

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE). Report vulnerabilities privately: [SECURITY.md](SECURITY.md).
