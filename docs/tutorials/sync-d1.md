# Sync a Cloudflare D1 database, in every direction

> **Coming soon, on Filarr's side.** The gate runs these syncs today, and every step of this tutorial that happens in
> the gate or in D1 is run by the test suite (`test/examples-sync.test.ts`) against a D1 simulated on SQLite, D1's
> own engine. The Filarr screens that create a sync ("···" on a database › "Feed from an external database…") come
> with a coming version of the app, and the feature opens account by account. The Filarr-side steps below follow the
> frozen contract `source-externe-1`; they will be checked on screen when the app ships them.

**At the end** you will have a Filarr database fed by a D1 table (inbound mirror), a Filarr database published to D1
(outbound), and a database synced **both ways** with a conflict policy chosen column by column, including "ask me",
whose conflicts wait for your decision. The D1 key stays in your gate: Filarr never sees it, nor the rows.

**Plan:** a sync scheduled and run by a gate needs Solo or above. (A one-off import from the desktop app is on every
plan.)

## How it works, in five words

- **The definition** lives in the Filarr database, encrypted like its rows: which connector, which table, which
  columns go where, which **direction**, what to do on a conflict, who runs it. It never holds a secret. Filarr's app
  **signs** it with your identity key: the gate refuses a definition that someone else changed.
- **The runner** is this gate: it reads the definitions that name its access, takes a lease (one runner at a time),
  reads D1 and its own copy of Filarr, decides, writes to D1 and to Filarr.
- **The row key** (`id`) matches a D1 row with a Filarr row. A row created from D1 gets a Filarr id computed from
  the source and the key (`ext-…`): importing the same table twice never duplicates.
- **The change marker** (`maj_le`) lets each pass read only the rows changed since the last one; a full read every
  24 hours (or every 96 passes) catches the rest.
- **The shadow** remembers, for each cell, the last value both sides agreed on (a fingerprint, encrypted on the
  gate's disk): that is how the gate knows which side changed.

## 1. Prepare the D1 table

[examples/sync-d1/schema.sql](../../examples/sync-d1/schema.sql):

<!-- snippet: examples/sync-d1/schema.sql#table -->
```sql
-- `id` is the row key the sync matches rows on: stable, never reused.
-- `maj_le` is the change marker: the sync reads only the rows changed since its last pass,
-- and "the most recent wins" compares it with Filarr's clock. ISO 8601, UTC, with milliseconds.
CREATE TABLE IF NOT EXISTS clients (
  id     INTEGER PRIMARY KEY,
  nom    TEXT NOT NULL,
  ville  TEXT,
  statut TEXT NOT NULL DEFAULT 'Prospect',
  note   TEXT,
  maj_le TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

A trigger keeps the marker right, whoever writes (your application, a script, or the sync):

<!-- snippet: examples/sync-d1/schema.sql#trigger -->
```sql
-- Keep `maj_le` right whoever writes: your application, a script, or the sync itself.
-- (An UPDATE that sets maj_le itself keeps its value: the WHEN clause.)
CREATE TRIGGER IF NOT EXISTS clients_maj_le
AFTER UPDATE OF nom, ville, statut, note ON clients
FOR EACH ROW WHEN NEW.maj_le = OLD.maj_le
BEGIN
  UPDATE clients SET maj_le = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
```

<!-- snippet: examples/sync-d1/schema.sql#index -->
```sql
-- The incremental read is `WHERE maj_le >= ? ORDER BY id`: an index on the marker keeps it fast.
CREATE INDEX IF NOT EXISTS clients_maj_le_idx ON clients (maj_le);
```

```sh
npx wrangler d1 execute boutique --remote --file examples/sync-d1/schema.sql
```

A row key must be stable and never reused; a marker must change at each change of the row. Without a marker the sync
still works, but reads the whole table at every pass.

## 2. A limited Cloudflare token

In Cloudflare's dashboard, **My Profile › API Tokens › Create Token › Custom token**:

- **Permissions**: Account › **D1** › **Read** for an inbound mirror; **Edit** to publish or sync both ways (Cloudflare's
  API documentation calls them "D1 Read" and "D1 Write"). Nothing else.
- **Account resources**: your account only.

The gate calls D1's query endpoint (`POST /accounts/<account>/d1/database/<database>/query`) with parameterized SQL,
and sends the token to `api.cloudflare.com` only. Note the account id and the database id (Workers & Pages › D1 ›
your database).

## 3. In Filarr: the definition (coming soon)

On the Filarr database that will receive the rows, "···" › "Feed from an external database…":

1. **Connector and key**: Cloudflare D1, your account id and database id. On the desktop or the web, the key would go
   to your keychain; for a sync run by a gate, you give it to the gate (next step) and Filarr never sees it.
2. **Columns**: the table, each column mapped to a Filarr column, the **row key** (`id`), the **change marker**
   (`maj_le`). Columns you do not map are never read. Filarr columns you do not map are **yours**: never overwritten,
   never sent.
3. **Direction, runner, schedule**: the direction (below), **this gate** as runner (its access name), every 15 minutes,
   every hour, every day at a time, or on demand; what to do with rows that disappear; and, for both ways, the
   **conflict policies**: Filarr preselects none and does not let you go on until you choose.

Filarr writes the definition into the database and signs it. What the gate reads, for the two-way example
([examples/sync-d1/definition.both.json](../../examples/sync-d1/definition.both.json); the ids are those of the
example):

<!-- snippet: examples/sync-d1/definition.both.json -->
```json
{
  "v": 1,
  "id": "xs_DemoClientsBoutique002",
  "rev": 1,
  "name": "Clients de la boutique",
  "connector": "d1",
  "conn": { "account": "0123456789abcdef0123456789abcdef", "database": "7c1e2b0a-0000-4000-8000-000000000002" },
  "host": "api.cloudflare.com",
  "from": { "table": "clients" },
  "key": { "cols": ["id"], "gen": "source" },
  "marker": { "col": "maj_le", "kind": "iso" },
  "mode": "both",
  "map": [
    { "col": "id", "prop": "p_id", "dir": "in", "type": "number" },
    { "col": "nom", "prop": "p_nom", "dir": "both", "type": "text" },
    { "col": "ville", "prop": "p_ville", "dir": "both", "type": "text", "conflict": "source" },
    { "col": "statut", "prop": "p_statut", "dir": "both", "type": "select", "conflict": "ask" },
    { "col": "note", "prop": "p_note", "dir": "both", "type": "text", "conflict": "filarr" }
  ],
  "conflict": "latest",
  "rowConflict": "keep",
  "onGone": "mark",
  "onFilarrDelete": "delete",
  "guard": { "pct": 20, "min": 10 },
  "runner": { "kind": "gate", "accessId": "<the access id>", "name": "ERP Atelier" },
  "schedule": { "every": "15m", "tz": "Europe/Paris" },
  "signer": "<the user id of the access creator>",
  "sig": "<signature by the creator's identity key>"
}
```

## 4. Give the key to the gate

```sh
filarr-gate sources list
```

```text
xs_DemoClientsBoutique002  Clients de la boutique
    d1 · api.cloudflare.com · both · 15m · base clients-de-la-boutique
    bloquée : extdb_key_missing (clé manquante pour api.cloudflare.com)
    clé : manquante (FILARR_GATE_EXTDB_DEMOCLIE)
```

Give the key, by the standard input so it stays out of your shell history:

```sh
printf '%s' "$CLOUDFLARE_D1_TOKEN" | filarr-gate sources key xs_DemoClientsBoutique002 --stdin
```

```text
Clé enregistrée (chiffrée sur cette machine).
```

or on the **Sources** screen of the management UI, or as the variable `FILARR_GATE_EXTDB_DEMOCLIE` (the name the list
shows), or in `gate.toml` (`[extdb."xs_DemoClientsBoutique002"] secret = "…"`). The gate stores a key given by the
command or the UI encrypted under a key derived from its token; it never sends it to Filarr, never logs it, and a
settings package never carries it.

## 5. The first pass

```sh
filarr-gate sources run xs_DemoClientsBoutique002
```

```text
Passage : ok
```

The rows of D1 are in Filarr, with ids `ext-…`. The gate publishes the state of the sync, encrypted so that the
members of the database can read it and Filarr cannot: when it last ran, what it changed, the next pass, the
conflicts waiting. The **Sources** screen shows the same.

## Inbound mirror: D1 is the authority

`mode: "mirror"`, every mapped column `in` ([definition.mirror.json](../../examples/sync-d1/definition.mirror.json)).

- Each pass brings D1's changes into Filarr.
- The mapped columns are **locked** in Filarr: a padlock, not editable, "comes from D1". The gate's local API refuses
  to write them (`409 field_managed`) and refuses to create or delete rows (`409 rows_managed`).
- A Filarr column you did not map stays yours: editable in Filarr and through the API, never sent to D1.
- A value changed in Filarr by an old app that ignores the lock is replaced at the next pass, and the journal keeps
  the old value.

## Outbound publishing: Filarr is the authority

`mode: "publish"`, the mapped columns `out` except the key ([definition.publish.json](../../examples/sync-d1/definition.publish.json)).

- The rows of Filarr are inserted into D1; the id D1 gives them (`RETURNING`) comes back into Filarr's key column.
- A change in Filarr reaches D1 at the next pass, or 10 seconds after the change when the schedule says "on every
  change".
- A value changed in D1 outside Filarr is replaced by Filarr's, and the journal keeps D1's.
- The token needs D1 Edit.

## Both ways

`mode: "both"`. For each cell, at each pass, the gate compares both sides with the shadow:

| D1 changed? | Filarr changed? | what happens |
|---|---|---|
| no | no | nothing |
| yes | no | Filarr gets D1's value |
| no | yes | D1 gets Filarr's value |
| yes, to the same value | yes | nothing; the shadow moves on |
| yes | yes, to different values | **a conflict**: the column's policy decides |

"Filarr changed" means the cell's own clock in Filarr changed, not "the row was touched": a device coming back
online with an old change is never lost in silence.

### The four policies

You choose one per column, or one for the whole definition (`conflict`) that the columns without their own follow.
None is chosen for you. The example uses all four on one row; here is what the test suite sees when Filarr changes
Acme first, then D1 changes the same four cells:

| column | policy | result |
|---|---|---|
| `nom` | **The most recent wins** (`latest`) | D1's value: its marker is later than Filarr's clock |
| `ville` | **The source wins** (`source`) | D1's value |
| `note` | **Filarr wins** (`filarr`) | Filarr's value, written to D1 |
| `statut` | **Ask me** (`ask`) | nothing written on either side: the cell waits in the queue |

Every value that loses goes to the sync's journal, with "Restore". `latest` needs a marker that is a time, and dates
the ROW, not the cell: a later change of another column in D1 makes D1 win this one too. It also compares two clocks
of two machines.

### "Ask me": the queue

A conflict on an "ask me" column enters a **queue**: Filarr keeps its value, D1 keeps its own, the shadow does not
move, and the rest of the row and of the table keeps syncing. The state says "1 conflict to settle", and the cell
carries a "conflict" mark in Filarr.

In Filarr, the queue lists each conflict (row, column, D1's value and its date, Filarr's value) with **keep
Filarr's value** or **take the source's**, one by one or all at once. The decision goes, encrypted, to the runner's
mailbox and triggers a pass: the gate applies it, the losing value goes to the journal with "Restore", and the entry
leaves the queue. In the test suite: the decision "take the source's" turns Filarr's `statut` to D1's value within a
second.

What the queue guarantees:

- **A decision applies to the values it was taken on.** If either side changed since, the decision is stale: the
  conflict is evaluated again, and a new entry replaces the old one.
- **Two people settling the same conflict**: the first decision received wins; the second is set aside, and the
  journal says who settled it.
- **A full queue** (500 entries): new conflicts wait for room, their cells do not sync meanwhile, and the state says
  how many wait.
- **Changing a column from "ask me" to an automatic policy** while it has conflicts waiting asks you, explicitly,
  whether to settle them with the new rule or keep them to settle by hand.

### "Restore"

On an entry of the journal (a conflict, a replaced value, a decision), **Restore** writes the lost value back in
Filarr as an ordinary change. At the next pass, Filarr alone has changed: the value goes to D1 if the column goes out.
In the test suite, restoring the `ville` that lost to D1 puts it back in D1 at the next `sources run`.

### Rows deleted on one side, changed on the other

`rowConflict`, also chosen without default: **the deletion wins** (`delete`), **the row is kept** (`keep`: restored in
Filarr with D1's values, or re-created in D1 with Filarr's), or **ask me** (`ask`): the row waits in the queue, with
"delete on both sides" or "keep the row".

## Rows that disappear, and the safety stop

- A row gone from D1 is, depending on `onGone`, **marked** in Filarr ("Gone from D1", struck through, your columns kept,
  no longer synced), deleted, or left alone.
- Disappearances are only seen at a **full read**: every 24 hours or every 96 passes with a marker, at every pass
  without one.
- **The safety stop**: if a pass would mark or delete more rows than `guard` allows (20 % of the known rows by
  default, and at least 10), or if D1 suddenly returns no row at all, the pass stops **before writing anything**, on
  either side:

```sh
filarr-gate sources run xs_DemoClientsBoutique002 --json
```

```json
{ "state": "question", "code": "extdb_guard", "question": { "kind": "guard", "pass": "p_3fa9c1d2e0", "gone": 2, "total": 3 } }
```

Check D1 first (a truncated table, a wrong filter). If the disappearances are real, agree for this pass only:

```sh
filarr-gate sources run xs_DemoClientsBoutique002 --ack-guard p_3fa9c1d2e0
```

(or agree in Filarr). The agreement is valid for that pass, that number of rows; the next stop asks again.

- **Too many conflicts at once** (`extdb_conflict_burst`) stops a pass the same way; on a first pass,
  `--initial source` or `--initial filarr` settles it one way, once.

## Schedule, pause, run now

- `15m`, `1h` (with ± 10 % of jitter), `1d` at a time in a time zone, or on demand; publishing and both ways can also
  run 10 seconds after a change in Filarr (at most once every 30 seconds).
- After a failure, the gate tries again after 1, 2, 4… minutes, up to every hour.
- `filarr-gate sources pause <id>` / `resume <id>` pause it on this gate; the definition stays in Filarr.
- Two processes started with the same token never run a sync together: the second sees `extdb_lease_held`.

## What each party sees

| | sees |
|---|---|
| Filarr | encrypted blocks, one commit per pass with changes, a sealed state; never the D1 key, never a row |
| D1 | the gate's IP address and the token's account |
| the members of the database | the definition (without key), the state and the journal, replaced values included |
| the gate | everything it syncs, and the key |

## If it does not work

- `extdb_unsigned`: the definition was changed by someone else; the access creator approves it in Filarr. An access
  created before the creator tag existed must have its token replaced.
- `extdb_key_refused`: D1 refused the token (401 or 403): permissions, account, expiry.
- `extdb_tier`: scheduled syncs need Solo or above.
- Every code: [reference/errors.md](../reference/errors.md#states-of-an-external-sync). The rule in depth:
  [explain/two-way-sync.md](../explain/two-way-sync.md).
- In Filarr's help: [feeding a database from an external database](https://filarr.com/en/docs/external-databases),
  [syncing both ways](https://filarr.com/en/docs/two-way-sync) and [creating a limited key per connector](https://filarr.com/en/docs/external-databases-connectors).
