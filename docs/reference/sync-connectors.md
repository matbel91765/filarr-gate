# External database connectors

[Lire en français](sync-connectors.fr.md)

A sync is **defined in Filarr** ("···" on a database › "Feed from an external database…", coming with a coming
version of the app) and **run by the runner it names**. This page lists what the gate needs for each connector when it
is the runner. Tutorials: [D1](../tutorials/sync-d1.md), [PostgreSQL](../tutorials/sync-postgres.md). The rule of the
two-way sync: [explain/two-way-sync.md](../explain/two-way-sync.md).

**Plan:** a sync scheduled and run by a gate needs Solo or above.

## What the gate checks before a pass

1. The definition names this gate's access (`runner.accessId`) and is valid (connector, host matching the connection,
   `SELECT`-only queries, key columns mapped, a conflict policy for two-way columns…); otherwise `extdb_def_invalid`
   with the codes, or `extdb_policy_missing`.
2. It is **signed by the access creator**, whose key the gate authenticated with the creator tag; otherwise
   `extdb_unsigned`.
3. The plan allows scheduled syncs (`extdb_tier`), the connector can run here (no TCP on Cloudflare), the **key** is
   present (`extdb_key_missing`), the sync is not paused on this gate.
4. The gate holds the **lease** of the definition at Filarr: two processes started with the same token never pass
   together (`extdb_lease_held`).

## Giving the key

The key never goes through Filarr. In order of precedence:

1. the variable `FILARR_GATE_EXTDB_<ID>`: `<ID>` is the first 8 characters after `xs_` of the definition id, upper
   case (`xs_DemoClientsBoutique002` → `FILARR_GATE_EXTDB_DEMOCLIE`); `filarr-gate sources list` shows the exact name;
2. `gate.toml`:

   ```toml
   [extdb."xs_DemoClientsBoutique002"]
   secret = "…"
   ```

3. the **Sources** screen of the management UI, or `filarr-gate sources key <id> --stdin` (or `--secret`, `--clear`):
   stored in the state, encrypted under a key derived from the token. After a token change, give it again.

The gate puts a key only on requests to the connector's own hosts.

## Connectors

| connector | key to give the gate | `conn` in the definition | where it runs | writes "only if unchanged" |
|---|---|---|---|---|
| Cloudflare D1 | an API token with Account › D1 › Read (mirror) or Edit (publish, both ways) | `account`, `database` | everywhere | yes: `WHERE key = ? AND col IS ?` |
| PostgreSQL | the role's password | `host`, `port` (5432), `db`, `user`, `schema` (`public`), `tls` | Node, Docker | yes: `IS NOT DISTINCT FROM`, one transaction per pass |
| MySQL, MariaDB | the user's password | `host`, `port` (3306), `db`, `user`, `tls` | Node, Docker | yes: `<=>`, one transaction per pass |
| Supabase | a project key (the service key bypasses row level security; a narrower key is better) | `url`, `schema` | everywhere | yes: a filter on the old value, `Prefer: return=representation` |
| Airtable | a personal access token with read (and write) access to that base | `base` (`app…`), `table`, `view` | everywhere | **no**: re-read just before writing |
| Google Sheets | the JSON of a service account; share the sheet with its address | `spreadsheet`, `tab`, `headerRow` | everywhere | **no**: re-read just before writing |
| Notion | an integration token; invite the integration on the database | `database` | everywhere | **no**: re-read just before writing |
| CSV or JSON by URL | an optional bearer token | `url` (https), `format` | everywhere | read only (`once`, `mirror`) |

Details per connector:

- **D1**: `POST https://api.cloudflare.com/client/v4/accounts/<account>/d1/database/<database>/query`, parameterized
  statements, pages of 1000 ordered by the key, marker `>=` (equal timestamps are never lost), insertion with
  `RETURNING`; statement by statement (D1 has no transaction over HTTP).
- **PostgreSQL**: the `pg` driver, loaded on demand. `tls`: `verify-full` (default, certificate checked against the
  host name), `require` (encrypted, certificate not checked), `off-local` (no TLS, local network only: private ranges,
  `.lan`, `.local`, `.internal`, `.home.arpa`). Pages by key (keyset) when the key is one column. Dates stay
  `YYYY-MM-DD`; a `numeric` is read as a number. A `query` source runs in a read-only transaction.
- **MySQL**: the `mysql2` driver, loaded on demand, the same TLS rules; `LAST_INSERT_ID()` for the new key.
- **Supabase**: the project's PostgREST (`/rest/v1/<table>`), the key as `apikey` and `Authorization: Bearer`, sent to
  the project's host only.
- **Airtable**: `api.airtable.com/v0`, pages of 100, 10 records per write, at most 5 requests per second per base. The
  column `id` is the record id (`rec…`). The marker is a date field such as "Last modified time". A linked-records
  field cannot be mapped (`unsupported_column`; met while reading, it stops the pass before any write).
- **Google Sheets**: `sheets.googleapis.com`; the gate signs the service account's JWT itself and sends only the
  assertion to `oauth2.googleapis.com`, never the private key. The whole tab is read at each pass (no marker); the row
  key is drawn by the runner (a text column of 64 characters at least) and a row is found by its key when written or
  erased, never by a row number kept from before.
- **Notion**: `api.notion.com`, `Notion-Version: 2022-06-28` fixed by the connector, pages of 100, at most 3 requests
  per second. The column `id` is the page id; the marker `last_edited_time`; titles and rich texts as plain text,
  selects by name, dates by their start. Deleting means moving to the trash. A relation property cannot be mapped
  (`unsupported_column`).
- **CSV or JSON**: `GET` over https; CSV per RFC 4180 (separator and header row configurable), JSON from a simple path
  (`$.items`, `$.data.rows`).

**Without "only if unchanged"** (Airtable, Google Sheets, Notion), a window of less than a second remains between the
re-read and the write: a change made in the source at that instant can be overwritten (the overwritten value is kept in
the journal).

## Limits of a pass

- 100,000 rows per definition (`extdb_too_large`); a full read without marker of a large table is slow: add a marker.
- At most two passes at the same time per gate; the upstream rates above are respected; a `429` from the source waits
  for its `Retry-After`.
- One commit to Filarr per pass with changes (it counts as one write in the plan's limits).
- After a failure: 1, 2, 4… minutes, up to every hour.

## Schedules

`15m`, `1h` (± 10 % jitter), `1d` at a time in a time zone, `manual`; for publishing and both ways, also 10 seconds
after a change in Filarr (at most once every 30 seconds). A member can ask for a pass from Filarr; **Run now** on the
**Sources** screen, or `filarr-gate sources run <id>`.

## State codes

[errors.md, states of an external sync](errors.md#states-of-an-external-sync).
