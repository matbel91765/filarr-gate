# Filarr Gate

**Serve a Filarr database as an API, without Filarr ever seeing your data.**

[Lire en français](README.fr.md)

> **Status: design phase.** Nothing here runs yet. The protocol is being frozen with the Filarr apps first; code
> follows. Watch the repository to follow along.

Filarr encrypts your notes and databases end to end: the Filarr servers store blocks they cannot read. That rules out
the usual "API key on the vendor's server". Filarr Gate is the other way round: a small **black box you run yourself**
(on your PC, in Docker, in your own Cloudflare account, or as a library) that holds the key to the databases you
open to it, keeps a decrypted copy in memory, and serves your software locally.

```
 Filarr app ──(encrypted blocks)──▶ Filarr servers ──(encrypted blocks)──▶ Filarr Gate ──(plain JSON)──▶ your ERP, BI, site, AI agent
                                         sees nothing                     on your machine
```

## What it will do

- **Endpoints from views.** Each view of a database becomes a REST endpoint (filters, sort, columns), with an
  OpenAPI schema generated from the column types.
- **SQL, read-only.** Joins and aggregates over the databases you opened, with Filarr's own query engine.
- **Signed webhooks.** A row is added or changed in Filarr: the gate decrypts it and calls your URL, signed with
  HMAC-SHA256, with retries.
- **App keys.** Your software never gets the Filarr token: each app gets its own key, scoped per endpoint and right,
  with rate limits and IP allow-lists.
- **Writes** (right after v1): create and update rows from your software, validated by Filarr like any other device.
- **A full management UI**: dashboard, databases and endpoints, SQL explorer, keys, webhooks, logs, limits, settings.
- MCP server for AI assistants, Prometheus metrics, OpenTelemetry traces.

## Why it is fast

Reads never leave your network: the gate answers from its in-memory copy (sub-millisecond for typical views). Only
changes travel, as small immutable encrypted blocks (about 32 KiB each), which cache well.

## Security model, in short

- One access token opens **only the databases you choose**, never your account, notes or files.
- Filarr keeps a hash of the token's proof and the access's public key. It never sees the token, the database keys
  or a single row.
- Revoking an access is instant on the server, and the database keys move to a new generation, so a revoked token
  cannot read anything written afterwards.
- A gate reads whole databases: a view is a convenience, not a cryptographic boundary. Treat the machine running it
  like any machine that holds the data.

Details: [docs/architecture.md](docs/architecture.md).

## Plans and limits

Filarr Gate works on every Filarr plan, including Free. Filarr only counts what goes through its servers (sync
requests, downloaded volume, writes); reads served by your gate are never counted. The limits per plan will be
published by the Filarr API itself and shown in the app.

## License

Not chosen yet. Until a license file is added, all rights are reserved.

## Security

Please report vulnerabilities privately: see [SECURITY.md](SECURITY.md).
