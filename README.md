# Filarr Gate

**Serve a Filarr database as an API, without Filarr ever seeing your data.**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[Lire en français](README.fr.md)

> **0.2.0: first release** ([changes](CHANGELOG.md)), on npm (`@filarr/gate`, `filarr-gate`) and on GHCR
> (`ghcr.io/filarr-work/gate`). The gate implements the frozen contracts `api-base-1` (revisions 2 and 3), `db-store-1`
> (3.9), `gate-fichiers-1`, `source-externe-1` and the settings package of `gate-heberge-1`, and is tested end to end
> against a local Filarr server (reads, live changes, writes, revocation, an external PostgreSQL sync, a file deposit,
> the Cloudflare variant). In Filarr, API access opens account by account; the box hosted by Filarr is not open yet.

Filarr encrypts your notes and databases end to end: its servers store blocks they cannot read. Filarr Gate is a small
**gate you run yourself** (in your code, on a PC, in Docker, on your own Cloudflare account) that holds the key to the
databases you open to it, keeps a decrypted copy in memory, and serves your software. Filarr keeps seeing encrypted
blocks only.

```
 Filarr app ──(encrypted blocks)──▶ Filarr servers ──(encrypted blocks)──▶ Filarr Gate ──(plain JSON)──▶ your ERP, BI, site, AI agent
                                         sees nothing                     yours
```

In Filarr: "···" on a database › **Open to an API…** gives a token (`flr_live_…`), shown once.

## Try it in five minutes, without an account

```sh
git clone https://github.com/filarr-work/filarr-gate.git && cd filarr-gate
npm ci && npm run build
npm run mock-filarr      # an in-memory Filarr with three demo databases; prints a token. Keep it running.
```

In a second terminal:

```sh
export FILARR_GATE_API_URL=http://127.0.0.1:8790
node packages/cli/dist/cli.js init --token flr_live_… --admin-password 'ten-characters-or-more'
node packages/cli/dist/cli.js                                   # the API on 127.0.0.1:8443, the UI on http://127.0.0.1:8787/admin/
```

In a third:

```sh
node packages/cli/dist/cli.js keys create --name "First try" --sql     # an app key, printed once
curl -s -H "Authorization: Bearer gk_…" "http://127.0.0.1:8443/v1/clients?limit=2"
```

```json
{"rows":[{"id":"r_acme","nom":"Acme","ville":"Lyon","statut":"Client","ca":12500, …}, …],"next":"o2","total":4,"version":2}
```

## Four ways to run it

| | how | tutorial |
|---|---|---|
| **in your code** | `npm install @filarr/gate`, then `openGate({ token })`: rows, views, SQL, live changes, writes, file deposits | [library](docs/tutorials/library.md) |
| **on a machine** | `npx filarr-gate init --token …` then `npx filarr-gate` (from a clone: `node packages/cli/dist/cli.js`) | [your computer](docs/tutorials/install-local.md) |
| **in Docker** | `docker compose up -d` with [examples/docker](examples/docker): the gate behind Caddy, state in a volume | [a server](docs/tutorials/install-docker.md) |
| **on your Cloudflare account** | the Deploy button, or `npx wrangler deploy`; the token is a secret of YOUR Worker | [Cloudflare](docs/tutorials/install-cloudflare.md) |

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/filarr-work/filarr-gate)

```js
import { openGate } from '@filarr/gate';

const gate = await openGate({ token: process.env.FILARR_GATE_TOKEN });
const active = await gate.base('clients').view('clients-actifs').rows();
```

## What it does

- **Endpoints from views.** `GET /v1/<database>` and `GET /v1/<database>/<view>`, replayed by Filarr's own view
  engine; slugs are fixed when the database is opened, so renaming a view never breaks an integration. Filters,
  sort, fields, search, pages. Read-only SQL with Filarr's engine, saved queries, OpenAPI 3.1 of each gate at
  `/openapi.json` and `/docs`.
- **App keys.** Your software never gets the Filarr token: each program gets its own `gk_…` key (stored as a
  fingerprint), limited to databases, views, queries or the file slot, with a rate, allowed addresses and an expiry.
- **Writes** (off by default): `POST`, `PATCH`, `DELETE`, idempotent with `Idempotency-Key`, committed to Filarr like
  any device's writes.
- **Signed webhooks** on row changes (HMAC-SHA256 on the raw body, 8 attempts over about 10.5 hours).
- **A file slot** (`POST /v1/files`): files sealed for the deposit box the creator linked and signed in Filarr;
  executables and oversized files refused before anything leaves. The Filarr app files them; neither Filarr nor the
  gate knows where.
- **External databases**: the syncs Filarr assigns to this gate (D1, PostgreSQL, MySQL, Supabase, Airtable, Google
  Sheets, Notion, CSV/JSON) run here, with your keys, which never reach Filarr; in every direction, two ways included,
  with the conflict policy you choose per column and an "ask me" queue.
- **Push wake-ups** for gates that sleep (Cloudflare); **migration** of the settings to the next gate, sealed; **MCP**
  for AI assistants; **Prometheus** metrics; a local log; a management UI in French and English.

## Documentation

Every page also exists in French, linked at the top of the page.

- **Tutorials**: [install](docs/tutorials/install-local.md) ([Docker](docs/tutorials/install-docker.md),
  [Cloudflare](docs/tutorials/install-cloudflare.md)) · [open a database to an API](docs/tutorials/open-a-database.md) ·
  [call the API in curl, JavaScript, Python](docs/tutorials/first-calls.md) · [webhooks](docs/tutorials/webhooks.md) ·
  [sync D1](docs/tutorials/sync-d1.md) and [PostgreSQL](docs/tutorials/sync-postgres.md) ·
  [receive files](docs/tutorials/receive-files.md) · [revoke](docs/tutorials/revoke.md) ·
  [hosted box and back](docs/tutorials/hosted-and-back.md) (coming soon) · [troubleshooting](docs/troubleshooting.md)
- **Use cases**, complete and tested: [examples/](examples)
- **Reference**: [API](docs/reference/api.md) · [OpenAPI](docs/openapi/filarr-gate.v1.json) ·
  [configuration](docs/reference/configuration.md) · [command line](docs/reference/cli.md) ·
  [codes](docs/reference/errors.md) · [webhooks](docs/reference/webhooks.md) · [MCP](docs/reference/mcp.md) ·
  [library](docs/reference/library.md) · [connectors](docs/reference/sync-connectors.md) ·
  [limits](docs/reference/limits.md)
- **Security**: [who sees what, in each mode](docs/security-and-trust.md) · [architecture](docs/architecture.md) ·
  [report a vulnerability](SECURITY.md)
- Everything: [docs/](docs/README.md)

## Security, in short

- A token opens **only the databases you choose**, never the account. It never leaves the gate: the keys are derived on
  the spot. Every sealed key is checked against its place, every block against the head's fingerprints.
- Objects that must come from you (deposit boxes, sync definitions, a migration's target) are accepted only when signed
  by the access creator's key, which the gate authenticates with a tag only the token can compute.
- Decrypted rows live in memory only. Revocation wipes the copy, and changes the keys of the databases so that the old
  token cannot read what is written afterwards.
- Whoever runs the gate, or holds the management password, reads the opened databases. **A view is a convenience, not
  a boundary.**

## Development

```sh
npm ci
npm test               # unit and integration tests against an in-memory Filarr, the examples, and docs:check
npm run test:examples  # only the examples of the documentation (Python and bash ones skip when absent)
npm run docs           # regenerate the generated pages (English and French) and the code blocks copied from examples/
npm run typecheck
npm run build
npm run mock-filarr    # an in-memory Filarr with demo databases, for trying the gate by hand
```

End to end against the real Filarr worker, run locally by the Filarr bench: see the header of
[test/worker.e2e.test.ts](test/worker.e2e.test.ts) (`npm run test:e2e`).

Layout: `packages/core` (Filarr's portable core, copied verbatim and relicensed Apache-2.0, plus the gate's pure
modules), `packages/gate` (the library), `packages/server` (the engine-agnostic gate), `packages/cli` (Node, the UI,
Docker), `packages/cloudflare` (the Worker). Release plan: [docs/release.md](docs/release.md).

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE). Report vulnerabilities privately: [SECURITY.md](SECURITY.md).
