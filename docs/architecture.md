# Architecture

[Lire en français](architecture.fr.md)

> Follows the frozen contracts of the Filarr apps: `api-base-1` (revisions 2 and 3), `db-store-1` (3.9),
> `gate-fichiers-1`, `source-externe-1`, and the settings package of `gate-heberge-1`. Where this document and the
> contracts disagree, the contracts win.

## Parts

| part | runs | role |
|---|---|---|
| Filarr apps (desktop, web, mobile) | user's devices | open a database to an API, create the access token, re-seal keys, publish the views manifest |
| Filarr API | Filarr servers | stores encrypted blocks, sealed grants and counters; authenticates accesses; enforces plan limits |
| **Filarr Gate** | customer's machine | replicates the opened databases, decrypts them, serves the local API, webhooks, MCP, UI |

## Databases as encrypted stores

A Filarr database lives in an encrypted **store**: rows are spread over blocks of about 32 KiB, each encrypted with
AES-256-GCM under a key derived from the database key `K_db`. Blocks are immutable (a change writes a new version),
so a replica only downloads what changed, and caches the rest forever.

`K_db` is derived one way (HKDF-SHA256) from the owner's root key, the store id, the vault epoch `e` and the store
**generation** `g`. Holding `K_db(e, g)` opens one database at one generation, and nothing else: not the root key,
not the next generation, not another database. Each block entry of the head names the `(e, g)` it is sealed under
(`g` absent means 0), and the head response says which key seals the head (`hk`, `null` for a pre-generation writer).

## The access token

```
flr_live_<accessId: 16 bytes, base64url>_<secret: 32 bytes, base64url>
```

Created and shown once by the Filarr app; never sent to Filarr. From `secret` (HKDF-SHA256, salt = `accessId`):

- `A_auth` (`filarr/api/v1|auth`): the proof the gate presents to Filarr
  (`Authorization: Filarr-Access <accessId>.<A_auth>`). Filarr stores only `SHA-256(A_auth)`.
- `A_enc` (`filarr/api/v1|enc`): the access's X25519 private key. Filarr stores only its public key.

The gate derives both at start-up and wipes the secret bytes. The creating app signs the access public key with the
user's identity key, and verifies that signature before every sealing, so a server cannot substitute its own key.

## Grants and manifests

For each opened database, the app seals `K_db(e, g)` to the access public key (X25519 sealed box, AES-256-GCM), one
entry per `(e, g)` in use. The sealed plaintext names the access, the store, `e` and `g`; **the gate refuses any grant
found in the wrong place** and lists the refusal in its log. Grants are re-read from `GET /api-access/self`; the rights
there are the *effective* ones (`rw` reads `r` when the plan or the server switch does not allow writing).

Views live inside the Filarr note, which the gate cannot read. The app publishes, per store, a sealed snapshot of the
views (filters, sorts, columns, query views and their SQL) with their slugs, and republishes it when one changes. The
gate parses views with Filarr's own reader (`parseDbData`) and replays them with Filarr's own view engine.

## Inside the gate

```
packages/core       Filarr's portable core, copied verbatim (store crypto, codec, registers, zones, view engine, SQL engine),
                    plus the gate's pure modules: engine/gate (creator tag, wake-ups, files, settings package) and
                    engine/extsrc (external sync: definitions, identity, conversions, mergeCell, planPass, seals)
packages/gate       the library: token, Filarr HTTP client, stream openers, block cache, store mirror, replicator, openGate
packages/server     the black box without an engine (Request/Response): local API, management API, keys, webhooks, MCP,
                    file slot, sync runner and connectors, migration, doctor
packages/cli        Node: configuration, state files (0600), HTTP adapter, command line, management UI (Preact), Docker
packages/cloudflare a Worker and a Durable Object hosting the same box
```

### Reading

For each store: `GET /dbstore/:id/head` → open the head under `hk` (when `hk` is null, a pre-generation head: the
generation-0 keys, newest epoch first) → for every block entry, check that its `K_db(e, g)` is held (otherwise the base
shows "missing key for (e, g)" and keeps serving its last complete state) → take changed blocks from the local cache or
`POST /dbstore/:id/slots:batchGet` (repeated while `more`) → verify each body against the head's MAC → decrypt → merge
the last-writer-wins registers → materialise rows in memory. A partial state is never served. A server that goes back in
sequence is refused.

The local cache holds encrypted bodies only, content-addressed (SHA-256) with a `p|ver` index per store, verified again
against the head before use. `FILARR_GATE_CACHE=memory` keeps nothing on disk.

### Staying current

`GET /api-access/self/stream` (WebSocket): `commit` triggers a re-read of that store, `grant` and `manifest` a re-read
of `self`, `quota` an alert (log, UI, `gate.quota` webhooks), `revoked` the wipe. The gate sends an application-level
`{"t":"ping"}` every 30 s (the relay closes on anything else) and reconnects with a growing, jittered delay. Close
codes: 4301 revoked or token rotated (wipe), 4302 paused, 4303 access changed (re-read `self`), 4304 expired (wipe),
4305 monthly sync quota spent (poll every 900 s until the next month), 4306 too many streams (back off).

Without the stream (Free: `access.stream` is false), the gate polls `GET /dbstore/:id/changes?since=` per store, never
faster than the plan's `pollIntervalS` nor `FILARR_GATE_POLL_SECONDS`, and reads the head only when a
store moved. `410 since_too_old` falls back to the head.

### Limits

Every `429` is honoured. `api_rate` pauses every exchange with Filarr until `Retry-After`. `api_poll_interval`,
`api_quota_sync` (on a head or changes) and `api_quota_bytes` only hold back the store concerned. `api_quota_writes`
reaches the application that tried to write, with `Retry-After`. Local reads go on throughout. The `X-Filarr-Quota`
and `RateLimit-*` headers of each response feed the "Usage and limits" screen; the plan table comes from
`GET /public/api-limits`.

### Writing (§ 7, off by default)

A local `POST`/`PATCH`/`DELETE` becomes register operations stamped with the gate's hybrid logical clock (its site id
is drawn once per install). The touched blocks are rewritten (split above 32 KiB), sealed under `K_db(current e,
current g)`, the head is rebuilt (Merkle root, zone index) and sealed under the same key with `seq + 1` as AAD, and
`POST /dbstore/:id/commit` carries `baseSeq`, every slot's `g` and `hk`. On `409 seq_conflict`, `stale_generation`,
`slot_version` or `bad_cover` the gate re-reads the head, re-seals and replays (registers merge as a union). Without the
key of the current generation the write is refused; it is never sealed under an older one. Restrictions to columns or
views are applied by the gate (app key scopes), not by the encryption.

### Relations to databases that are not opened (§ 8)

The gate never reads a database it was not given. A relation cell returns the raw row ids; a rollup over such a
database returns `null` and the field is listed in `unresolved`. Relations between opened databases resolve through
the owner block id of each store (`head.dbId`). In SQL, a database that is not opened appears as a table holding only
`id`, as in Filarr's Query view.

## Revision 3

### The creator's key

`GET /api-access/self` returns `creator: { userId, signingPublicKey, tag }` and `access.bindSig`. The gate recomputes
`tag = HMAC(A_mac, "filarr/api/v1|creator|" + accessId + "|" + signingPublicKey)` with `A_mac` derived from the token,
and checks `bind_sig` (the creator's signature of the access public key). Only then is the key **authenticated**:
deposit boxes (`boxSig`), sync definitions and a migration target are accepted only when signed by it. A server cannot
forge the tag, nor substitute its own key.

### Push wake-ups

When the creator gives an address, Filarr posts `{ a, t, storeId?, seq?, state?, at }` to `/_filarr/notify`, signed
`Filarr-Notify: t=<s>,v1=HMAC-SHA256(A_notify, t + "." + body)`. The gate checks the signature on the raw body and a
300-second window, answers 202, then re-reads through its usual routes: a wake-up carries no content. Close code 4308
(hosted box asleep) is not an error.

### File slot

`POST /v1/files` → the filter (extension list, executable signatures MZ/ELF/Mach-O/`#!`, size) refuses before anything
leaves → a fresh `K_file`, chunks of 16 MiB (`IV ‖ AES-GCM`), the manifest encrypted under `K_file`, and `K_file` sealed
to the deposit box (`filarr.filerequest.seal.v1`) → `self/files/init`, `chunk`, `finalize`. The app opens and files
it; the gate only learns `filed` or `rejected` (and `file.filed` webhooks fire).

### External databases

The sync runner reads the definitions in `schema.extra.extSource` of the opened stores that name this access, checks
their signature, and runs a pass under a lease: mailbox decisions, source read, `planPass` (pure, the same code the
apps run), conditional writes to the source, one Filarr commit, then the encrypted shadow (`K_shadow`) and the published
status and queue (`K_xs`, readable by the database's members). See [external-databases.md](external-databases.md).

### Migration

The settings package (`gate-settings-1`: app key hashes, webhooks and secrets, saved queries, sync shadows, file filter,
CORS, write) is sealed to the next gate's public key after checking its `bind_sig`, online (`self/export`, then the
pending identity reads `self/import`) or as a file (`filarr-gate export` / `init --import`). It never carries the admin
password nor an external database key.

### Where it runs

The box is written against `Request`/`Response` and small storage interfaces (state, journal, block cache, blobs). Node
adds files, ports and the `ws` stream; the Cloudflare variant adds a Durable Object, alarms instead of timers, and no
stream (polling plus wake-ups). The library uses the replicator alone.

## Revocation

1. Filarr refuses the token immediately and tells the stream (`revoked`, close 4301).
2. The gate stops, wipes the derived keys, the database keys and the rows from memory, and deletes its block cache.
3. The app bumps the generation of each store the access could read and re-seals the new keys for the remaining
   accesses. Everything written afterwards is unreadable with the old keys, even if blocks leak.

## Limits per plan

Filarr only meters traffic that goes through Filarr: sync requests, downloaded bytes (blocks and heads), accepted
commits (a commit may carry several rows; Filarr cannot see rows). Local reads are never metered. When a limit is
reached, the gate keeps serving its last copy; writes and downloads wait for the next window.

## What each party sees

- **Filarr**: access id, access public key, hash of the proof, sealed grants, sealed manifest, counters, client IP
  and gate version. Never the token, `A_enc`, `K_db` or a row.
- **The gate**: every row and column of the opened databases. Views are a convenience, not a security boundary.
- **Your software**: what its app key allows, nothing of Filarr.
- **Webhook receivers**: the rows (and fields) their webhook selects, signed.
