-- Add Cora as 14th reservable teaching space (id 16, sort_order 14)
-- Prerequisites: public.spaces exists (sql/reservations_schema.sql)
-- Run in Supabase SQL Editor. Idempotent — safe to re-run.

BEGIN;

INSERT INTO public.spaces (id, name, sort_order)
VALUES (16, 'Cora', 14)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;

COMMIT;
