# External databases

[Lire en français](external-databases.fr.md)

A Filarr database can be fed from, or published to, another database (contract `source-externe-1`). The sync is
**defined in Filarr** ("···" on a database › "Feed from an external database…") and **run by the runner it names**:
a device, or this gate. A gate runs the definitions that name its access, with the keys you give it here; those keys
never reach Filarr.

## What the gate checks before running

- The definition is signed by the access's creator (Ed25519, the identity key authenticated by the creator tag); an
  unsigned or foreign definition is shown "waiting for the creator's signature" and never runs.
- It is valid (connector, host matching the connection, `SELECT`-only queries, key columns mapped, a conflict policy for
  two-way columns…), the plan allows scheduled syncs (Solo and above), and the key is present.
- It holds the **lease** of the definition on Filarr: two processes started with the same token never pass together.
  Each process draws its own instance id at startup and sends it with the lease; the second one waits, and its journal
  says "another instance of this black box is already running this sync". A process stopped cleanly gives its lease
  back. The Cloudflare variant keeps a single instance id in its Durable Object, which stays the same runner across
  evictions.
- A source column that is a relation (a Notion relation, Airtable linked records) is refused (`unsupported_column`):
  incoming relations are not supported yet, and they are never imported as text.

## Giving the key

| connector | key |
|---|---|
| Cloudflare D1 | an API token with D1 access |
| PostgreSQL, MySQL | the database user's password (TCP: Node and Docker only) |
| Supabase | the service-role key |
| Airtable | a personal access token |
| Google Sheets | the service account's JSON |
| Notion | the integration token |
| CSV/JSON by URL | optional bearer token |

In the UI (**Sources**: stored encrypted under a key derived from the token), with
`filarr-gate sources key <id> --stdin`, as `FILARR_GATE_EXTDB_<ID>` (the exact name is shown on the source), or in
`gate.toml`:

```toml
[extdb."xs_…"]
secret = "…"
```

A local database (`127.0.0.1`, a `.lan` host…) may be reached without TLS when the definition says `tls: off-local`;
anything else is HTTPS or TLS.

## A pass

1. Lease taken; decisions from Filarr's mailbox read (conflicts settled by a member).
2. The source read (whole, or since the change marker), the Filarr rows read from the local copy.
3. Each cell merged against the **shadow** (the last value both sides agreed on): source changed, Filarr changed,
   both, or neither. Two-way columns follow their policy: `source`, `filarr`, `latest` (by the row's time marker),
   or `ask` — the cell is queued, written nowhere, and settled in Filarr; the rest of the row syncs.
4. **Guards** stop a pass before any write: too many rows gone from the source (`guard.pct`, at least `guard.min`), or
   a burst of conflicts on a first pass. Agree in Filarr (or `filarr-gate sources run <id> --ack-guard <pass>`) to go
   on for that pass only. A stopped pass journals the stop and the planned number, never the rows it would have
   touched; its counts stay at zero.
5. Writes to the source under the condition of the value read (a value changed meanwhile is not overwritten), then one
   commit to Filarr. The shadow and the published status (encrypted under a key of the database, readable by its
   members, never by Filarr) are saved; `sync.done` or `sync.failed` webhooks fire.

Rows deleted at the source are marked "gone" (`onGone: mark`), deleted, or kept, as the definition says. Columns fed by
the source cannot be written through the local API (`409 field_managed`), and a mirrored database refuses new and
deleted rows (`409 rows_managed`).

## Schedules

`15m`, `1h`, `1d` (at a time, in a time zone), `manual`, and "on change" for publishing. **Run now** in the UI or
`filarr-gate sources run <id>`; **Pause** keeps the definition and stops the passes.
