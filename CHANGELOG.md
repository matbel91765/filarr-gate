# Changelog

[Lire en français](CHANGELOG.fr.md)

The notable changes of each version. Before 1.0, a minor version may change the API; the release notes say so.

## 0.3.0: the hosted service, built

Dated by the "published" entry of the public release journal (branch `release-journal`), written when the signed tag
is received.

For a gate you run yourself (library, command, Docker image, Cloudflare variant), nothing changes from 0.2.0: same
API, same settings, same contracts.

### The hosted service: built, not open yet

The service that will run the box hosted by Filarr is in this repository, `packages/host` (the Worker
`filarr-gate-host`, contract `gate-heberge-1`). It is not in service: Filarr's hosted offer opens later, after an
external security review. How it is mounted, what is no longer end-to-end encrypted in that mode and what protects it:
[the hosted service](docs/explain/hosted.md).

- One box per hosted access, a Durable Object created in the EU jurisdiction, running the same Filarr Gate core as at
  home through the Cloudflare adapter.
- Its state at rest encrypted with a key derived from the access's token (`K_box`, AES-256-GCM): once the sealed token
  is erased, what is stored can no longer be decrypted.
- Its life cycle: wake-ups signed by Filarr, sleep without losing the encrypted state (`503 gate_asleep`), the month's
  calls counted against the plan's ceiling (`429 hosted_quota_calls`), taking the box back home with the settings
  package, a `308` redirect for 30 days after a move.
- Erasure with a receipt signed by the service (reason and time of the request, databases and generation held, what was
  erased, version, `codeHash`), and a partial receipt for a database withdrawn alone, with its cause.
- A management channel `/_admin/…` and no web interface: each request signed by the creator's identity key (method,
  path with its query, time, body hash) and accepted once (`401 admin_replay`).
- A signed version announcement, `/.well-known/filarr-gate-host.json`, whose `codeHash` anyone can compare with the
  published release.
- No logs: the `observability` block is present and switches everything off, checked by a test.
- Tested in memory and under workerd, with the `gate-heberge-1` vectors of families 2, 3, 4, 5, 7 and 8 replayed by the
  code the service runs.

### Release chain

- The service's module, `host/filarr-gate-host-X.Y.Z.js`, is built twice and compared like the npm archives, listed in
  `SHA256SUMS` and attached to the GitHub release.
- `.github/workflows/deploy-host.yml` puts that very file into service (`wrangler deploy --no-bundle`), started by hand
  from a signed tag, at least **seven days** after its "published" entry, except an accepted security fix; it writes the
  "deployed" (or "security") entry of the public journal. Releases made before the module existed (0.2.0) cannot be
  deployed. The procedure: [docs/RELEASING.md](docs/RELEASING.md#the-hosted-service).
- `scripts/host-keys.mjs` draws the service's keys once (`HOST_ENC`, X25519; `HOST_SIG`, Ed25519) and hands the private
  halves to Cloudflare through standard input only; `--rotate` adds the next pair.
- The public keys `h1` (valid until 2028-10-09) in [`docs/hosted-keys.json`](docs/hosted-keys.json), built into the
  service and into Filarr's apps.

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
