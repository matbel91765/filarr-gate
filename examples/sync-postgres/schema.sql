-- A PostgreSQL table ready for a sync with Filarr, in every direction.
--
--   psql "postgresql://admin@db.lan/atelier" -f schema.sql
--
-- region table
-- `id` is the row key the sync matches rows on. `updated_at` is the change marker.
CREATE TABLE IF NOT EXISTS commandes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero     text NOT NULL UNIQUE,
  client     text NOT NULL,
  montant    numeric(12, 2) NOT NULL DEFAULT 0,
  statut     text NOT NULL DEFAULT 'Reçue',
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- endregion

-- region trigger
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
-- endregion

INSERT INTO commandes (numero, client, montant, statut) VALUES
  ('C-2026-1181', 'Acme', 1240.50, 'Expédiée'),
  ('C-2026-1182', 'Globex', 860.00, 'Reçue')
ON CONFLICT (numero) DO NOTHING;
