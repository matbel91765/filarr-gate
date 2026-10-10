# Mirror a PostgreSQL of your local network, then sync it both ways

> **Coming soon, on Filarr's side**, as for [D1](sync-d1.md): the gate runs this today, and the test suite runs every
> gate-side and PostgreSQL step of this tutorial against a real, throwaway PostgreSQL, with the exact SQL of the
> example and the limited role it creates. The Filarr screens that create the sync come with a coming version of the
> app.

**At the end** a PostgreSQL that only your network can reach (the ERP's database on `db.lan`) feeds a Filarr
database, through a gate on the same network, with a role that can read one table and nothing else; then the same
sync goes both ways, with "ask me" on every column. Filarr can never reach your PostgreSQL: the gate does, from
inside.

**Plan:** Solo and above. PostgreSQL needs the Node or Docker gate (TCP); not the Cloudflare variant, not the hosted
box.

## 1. The table and its marker

[examples/sync-postgres/schema.sql](../../examples/sync-postgres/schema.sql), as an administrator of the database:

<!-- snippet: examples/sync-postgres/schema.sql#table -->
```sql
-- `id` is the row key the sync matches rows on. `updated_at` is the change marker.
CREATE TABLE IF NOT EXISTS commandes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero     text NOT NULL UNIQUE,
  client     text NOT NULL,
  montant    numeric(12, 2) NOT NULL DEFAULT 0,
  statut     text NOT NULL DEFAULT 'Reçue',
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

<!-- snippet: examples/sync-postgres/schema.sql#trigger -->
```sql
-- Keep `updated_at` right whoever writes (your ERP, a script, or the sync itself).
CREATE OR REPLACE FUNCTION commandes_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS commandes_touch ON commandes;
CREATE TRIGGER commandes_touch BEFORE UPDATE ON commandes
FOR EACH ROW EXECUTE FUNCTION commandes_touch();
CREATE INDEX IF NOT EXISTS commandes_updated_at_idx ON commandes (updated_at);
```

`updated_at` is the change marker; the trigger keeps it right whoever writes, and leaves alone an `UPDATE` that sets
it on purpose. `numeric(12, 2)` is fine: the gate reads `1240.50` as the number 1240.5, and when PostgreSQL rounds a
value it writes back, the gate reads the rounded value back in the same pass (and stops sending a column that keeps
changing under its feet).

## 2. A role that can do only that

[examples/sync-postgres/role.sql](../../examples/sync-postgres/role.sql). For a mirror (PostgreSQL → Filarr), reading
is enough:

<!-- snippet: examples/sync-postgres/role.sql#readonly -->
```sql
-- Inbound mirror (PostgreSQL → Filarr): reading is enough
CREATE ROLE filarr_gate LOGIN PASSWORD 'choose-a-long-password';
GRANT CONNECT ON DATABASE atelier TO filarr_gate;
GRANT USAGE ON SCHEMA public TO filarr_gate;
GRANT SELECT ON public.commandes TO filarr_gate;
```

To publish or sync both ways, add the writes on that one table:

<!-- snippet: examples/sync-postgres/role.sql#readwrite -->
```sql
-- Publishing (Filarr → PostgreSQL) or both ways: write the mapped columns, insert, delete
GRANT INSERT, UPDATE, DELETE ON public.commandes TO filarr_gate;
```

Choose your own password; it goes to the gate, never to Filarr. The test suite creates this exact role and connects
with it: these grants are enough, for the mirror and for both ways (insert with `RETURNING` included).

## 3. TLS

The definition says how the gate connects (`conn.tls`):

- `verify-full` (default): TLS, certificate checked against the host name. Use it whenever PostgreSQL has a
  certificate.
- `require`: TLS without checking the certificate (encrypted, but a machine in the middle could pose as the server).
- `off-local`: no TLS. Allowed only for a host of the local network (private ranges, names in `.lan`, `.local`,
  `.internal`, `.home.arpa`); Filarr shows it in red. That is what the example uses, for `db.lan`.

## 4. A gate on the same network

Install the gate on a machine that reaches `db.lan:5432`: [with Docker](install-docker.md) on the ERP's server, or
[on a computer](install-local.md). The PostgreSQL driver (`pg`) comes with the gate.

## 5. In Filarr: the mirror (coming soon)

On the Filarr database "Commandes", "···" › "Feed from an external database…": PostgreSQL, host `db.lan`, port 5432,
database `atelier`, user `filarr_gate`, TLS; the table `commandes`; `id` as the row key, `updated_at` as the marker;
direction **inbound mirror**; runner: this gate; every 15 minutes. Filarr signs the definition
([definition.mirror.json](../../examples/sync-postgres/definition.mirror.json)):

<!-- snippet: examples/sync-postgres/definition.mirror.json -->
```json
{
  "v": 1,
  "id": "xs_DemoCommandesAtelier00",
  "rev": 1,
  "name": "Commandes de l'atelier (miroir)",
  "connector": "postgres",
  "conn": { "host": "db.lan", "port": 5432, "db": "atelier", "user": "filarr_gate", "schema": "public", "tls": "off-local" },
  "host": "db.lan:5432",
  "from": { "table": "commandes" },
  "key": { "cols": ["id"], "gen": "source" },
  "marker": { "col": "updated_at", "kind": "iso" },
  "mode": "mirror",
  "map": [
    { "col": "id", "prop": "p_id", "dir": "in", "type": "number" },
    { "col": "numero", "prop": "p_numero", "dir": "in", "type": "text" },
    { "col": "client", "prop": "p_client", "dir": "in", "type": "text" },
    { "col": "montant", "prop": "p_montant", "dir": "in", "type": "number" },
    { "col": "statut", "prop": "p_statut", "dir": "in", "type": "select" }
  ],
  "onGone": "mark",
  "guard": { "pct": 20, "min": 10 },
  "runner": { "kind": "gate", "accessId": "<the access id>", "name": "Serveur de l'atelier" },
  "schedule": { "every": "15m", "tz": "Europe/Paris" },
  "signer": "<the user id of the access creator>",
  "sig": "<signature by the creator's identity key>"
}
```

## 6. The password to the gate, a first pass

```sh
printf '%s' "$PG_PASSWORD" | filarr-gate sources key xs_DemoCommandesAtelier00 --stdin
filarr-gate sources run xs_DemoCommandesAtelier00
```

```text
Clé enregistrée (chiffrée sur cette machine).
Passage : ok
```

The orders are in Filarr. `statut` is a select column: each label PostgreSQL holds (`Reçue`, `Expédiée`) became an
option of it. The mapped columns are locked in Filarr; add your own columns (a "Suivi" column for your notes): they stay
yours.

## 7. Both ways, with "ask me"

Change the definition in Filarr: direction **both ways**, policy **Ask me** for cells and for rows. It becomes
revision 2 of the same definition, signed again; the gate keeps its shadow and carries on
([definition.both.json](../../examples/sync-postgres/definition.both.json)):

<!-- snippet: examples/sync-postgres/definition.both.json -->
```json
{
  "v": 1,
  "id": "xs_DemoCommandesAtelier00",
  "rev": 2,
  "name": "Commandes de l'atelier",
  "connector": "postgres",
  "conn": { "host": "db.lan", "port": 5432, "db": "atelier", "user": "filarr_gate", "schema": "public", "tls": "off-local" },
  "host": "db.lan:5432",
  "from": { "table": "commandes" },
  "key": { "cols": ["id"], "gen": "source" },
  "marker": { "col": "updated_at", "kind": "iso" },
  "mode": "both",
  "map": [
    { "col": "id", "prop": "p_id", "dir": "in", "type": "number" },
    { "col": "numero", "prop": "p_numero", "dir": "both", "type": "text" },
    { "col": "client", "prop": "p_client", "dir": "both", "type": "text" },
    { "col": "montant", "prop": "p_montant", "dir": "in", "type": "number" },
    { "col": "statut", "prop": "p_statut", "dir": "both", "type": "select" }
  ],
  "conflict": "ask",
  "rowConflict": "ask",
  "onGone": "mark",
  "onFilarrDelete": "ignore",
  "guard": { "pct": 20, "min": 10 },
  "runner": { "kind": "gate", "accessId": "<the access id>", "name": "Serveur de l'atelier" },
  "schedule": { "every": "15m", "tz": "Europe/Paris" },
  "signer": "<the user id of the access creator>",
  "sig": "<signature by the creator's identity key>"
}
```

What the test suite then does, and sees:

1. Filarr changes the status of `C-2026-1181` to "Reçue"; the ERP sets it to "Livrée" in PostgreSQL. The next pass
   writes nothing for that cell, and the state says `extdb_conflicts_pending`, one conflict.
2. Someone settles it in Filarr: **keep Filarr's value**. The decision triggers a pass, and PostgreSQL gets
   "Reçue" (an `UPDATE … WHERE id = $1 AND statut IS NOT DISTINCT FROM $2`: if the ERP had changed the cell again in
   the meantime, nothing would be overwritten, and the conflict would come back).
3. A row created in Filarr (`C-2026-1200`, Initech) is inserted into PostgreSQL in the next pass; the `id`
   PostgreSQL gives it comes back into Filarr.

A pass to PostgreSQL is one transaction: if something fails, nothing of that pass is written to the source.

## Things to know

- `onFilarrDelete: "ignore"` in the example: deleting an order in Filarr does not delete it in the ERP; the gate notes
  it and never imports it again unless it is restored in Filarr.
- The sync reads only the mapped columns (and the key and the marker): `SELECT "id", "numero", … FROM "public"."commandes"`.
- A source written as a query (`from.query`, a `SELECT`) is read in a read-only transaction and can only be mirrored.
- 100,000 rows at most per definition, for a gate.

## If it does not work

- `extdb_unreachable`: the gate's machine cannot reach `db.lan:5432` (firewall, `pg_hba.conf`, `listen_addresses`).
- `extdb_key_refused`: wrong password, or `pg_hba.conf` refuses the role from the gate's address.
- `extdb_tls`: the certificate does not match the host; fix it, or choose `require`.
- `extdb_not_found`: the database or the table does not exist (or the role cannot see it).
- More: [troubleshooting](../troubleshooting.md#external-syncs).
- In Filarr's help: [feeding a database from an external database](https://filarr.com/en/docs/external-databases),
  [syncing both ways](https://filarr.com/en/docs/two-way-sync) and [creating a limited key per connector](https://filarr.com/en/docs/external-databases-connectors).
