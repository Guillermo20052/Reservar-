-- Add Caelum as 13th teaching room (id 15, sort_order 13)
-- Prerequisites: public.spaces exists (sql/reservations_schema.sql)
-- Run in Supabase SQL Editor. Idempotent — safe to re-run.

BEGIN;

INSERT INTO public.spaces (id, name, sort_order)
VALUES (15, 'Caelum', 13)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;

COMMIT;
