# Changelog

[Lire en français](CHANGELOG.fr.md)

The notable changes of each version. Before 1.0, a minor version may change the API; the release notes say so.

## 0.2.0: first release

Dated by the "published" entry of the public release journal (branch `release-journal`), written when the signed tag
is received.

### Published

- `@filarr/gate` on npm: the library, to read and write the rows of a Filarr database from your own code.
- `filarr-gate` on npm: the command, the server and the management interface.
- `ghcr.io/filarr-work/gate`: the Docker image (linux/amd64, linux/arm64), non-root user, state in `/data`.
- The Cloudflare variant, from the tagged source (`wrangler.jsonc`, Deploy button): a Worker and a Durable Object on
  your own account.

### What the gate does

- Endpoints from views (`GET /v1/<database>`, `GET /v1/<database>/<view>`), replayed by Filarr's view engine, with
  filters, sort, fields, search and pages; read-only SQL with Filarr's engine and saved queries; an OpenAPI 3.1
  description of each gate.
- App keys (`gk_…`), one per program, stored as fingerprints, limited to databases, views, queries or the file slot,
  with a rate, allowed addresses and an expiry.
- Writes, off by default, idempotent with `Idempotency-Key`.
- Signed webhooks on row changes (HMAC-SHA256 on the raw body, 8 attempts over about 10.5 hours).
- A file slot (`POST /v1/files`): files sealed for the deposit box the creator linked in Filarr; executables and
  oversized files refused before anything is sent.
- External databases: the syncs Filarr assigns to the gate (D1, PostgreSQL, MySQL, Supabase, Airtable, Google Sheets,
  Notion, CSV/JSON), with your keys, in every direction, two ways included, a conflict policy per column, the "ask me"
  queue and a guard that stops a pass.
- Push wake-ups for gates that sleep, migration of the settings to the next gate (sealed `gate-settings-1` package),
  MCP for AI assistants, Prometheus metrics, a local log, a management interface in English and French.

### Contracts

`api-base-1` (revisions 2 and 3), `db-store-1` (3.9), `gate-fichiers-1`, `source-externe-1`, and from `gate-heberge-1`
the settings package and the vectors of families 2 (sealed token), 8 (`K_box` and the state's envelope) and 9 (security
tag and public release journal), which this repository originates.

### Release chain

- Reproducible builds (`SHA256SUMS`), npm provenance, a signed image (cosign) with its provenance and SBOM.
- Releases only from a tag signed by a key of `.github/release-signers` (SSH signature of git), and a public release
  journal; see [docs/RELEASING.md](docs/RELEASING.md).
- Workers Logs off by default in `wrangler.jsonc`; third-party licenses in `THIRD_PARTY_NOTICES`.

### Requirements

Node.js 20.19 or newer (library and command). The library uses standard Web APIs only.
