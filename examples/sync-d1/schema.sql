-- A Cloudflare D1 table ready for a sync with Filarr, in every direction.
--
--   npx wrangler d1 execute boutique --remote --file schema.sql
--
-- region table
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
-- endregion

-- region trigger
-- Keep `maj_le` right whoever writes: your application, a script, or the sync itself.
-- (An UPDATE that sets maj_le itself keeps its value: the WHEN clause.)
CREATE TRIGGER IF NOT EXISTS clients_maj_le
AFTER UPDATE OF nom, ville, statut, note ON clients
FOR EACH ROW WHEN NEW.maj_le = OLD.maj_le
BEGIN
  UPDATE clients SET maj_le = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
-- endregion

-- region index
-- The incremental read is `WHERE maj_le >= ? ORDER BY id`: an index on the marker keeps it fast.
CREATE INDEX IF NOT EXISTS clients_maj_le_idx ON clients (maj_le);
-- endregion
