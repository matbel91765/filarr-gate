-- The PostgreSQL role the gate connects with: only what the sync needs, on one table.
-- Run as an administrator; choose your own password, and give it to the gate (never to Filarr).
--
-- region readonly
-- Inbound mirror (PostgreSQL → Filarr): reading is enough
CREATE ROLE filarr_gate LOGIN PASSWORD 'choose-a-long-password';
GRANT CONNECT ON DATABASE atelier TO filarr_gate;
GRANT USAGE ON SCHEMA public TO filarr_gate;
GRANT SELECT ON public.commandes TO filarr_gate;
-- endregion

-- region readwrite
-- Publishing (Filarr → PostgreSQL) or both ways: write the mapped columns, insert, delete
GRANT INSERT, UPDATE, DELETE ON public.commandes TO filarr_gate;
-- endregion
