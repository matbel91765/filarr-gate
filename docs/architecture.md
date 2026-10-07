# Architecture

> Design phase. This document follows the protocol being frozen with the Filarr apps; field names may still change.

## Parts

| part | runs | role |
|---|---|---|
| Filarr apps (desktop, web, mobile) | user's devices | open a database to an API, create the access token, re-seal keys, publish the views manifest |
| Filarr API | Filarr servers | stores encrypted blocks, sealed grants and counters; authenticates accesses; enforces plan limits |
| **Filarr Gate** | customer's machine | replicates the opened databases, decrypts them, serves the local API, webhooks, UI |

## Databases as encrypted stores

A Filarr database lives in an encrypted **store**: rows are spread over blocks of about 32 KiB, each encrypted with
AES-256-GCM under a key derived from the database key `K_db`. Blocks are immutable (a change writes a new version),
so a replica only downloads what changed, and caches the rest forever.

`K_db` is derived one way (HKDF-SHA256) from the owner's root key, the store id, the vault epoch `e` and the store
**generation** `g`. Holding `K_db(e, g)` opens one database at one generation, and nothing else: not the root key,
not the next generation, not another database.

## The access token

```
flr_live_<accessId: 16 bytes, base64url>_<secret: 32 bytes, base64url>
```

Created and shown once by the Filarr app; never sent to Filarr. From `secret` (HKDF-SHA256, salt = `accessId`):

- `A_auth` (`filarr/api/v1|auth`): the proof the gate presents to Filarr. Filarr stores only `SHA-256(A_auth)`.
- `A_enc` (`filarr/api/v1|enc`): the access's X25519 private key. Filarr stores only its public key.

The creating app signs the access public key with the user's identity key, and verifies that signature before every
sealing, so a server cannot substitute its own key.

## Grants

For each opened database, the app seals `K_db(e, g)` to the access public key (X25519 sealed box, AES-256-GCM), one
entry per `(e, g)` in use. The sealed plaintext names the access, the store, `e` and `g`; the gate rejects any grant
found in the wrong place.

## The views manifest

Views live inside the Filarr note, which the gate cannot read. The app publishes a sealed snapshot of the opened
views (filters, sorts, columns, query views and their SQL), and republishes it when one changes. Endpoint slugs are
fixed at creation so renaming a view never breaks an integration.

## Revocation

1. Filarr refuses the token immediately.
2. The app bumps the generation of each store the access could read, and re-seals the new keys for the remaining
   accesses. Everything written afterwards is unreadable with the old keys, even if blocks leak.

## Limits

Filarr only meters traffic that goes through Filarr: sync requests, downloaded bytes, accepted writes (a write
batch may carry several rows; Filarr cannot see rows). Local reads are never metered. When a limit is reached, the
gate keeps serving its last copy; writes and downloads wait for the next window. Each response carries
`RateLimit-*` headers and an `X-Filarr-Quota` summary; the plan limits are published by a public Filarr endpoint.

## What each party sees

- **Filarr**: access id, access public key, hash of the proof, sealed grants, sealed manifest, counters, client IP
  and gate version. Never the token, `A_enc`, `K_db` or a row.
- **The gate**: every row and column of the opened databases. Views are a convenience, not a security boundary.
- **Your software**: what its app key allows, nothing of Filarr.
