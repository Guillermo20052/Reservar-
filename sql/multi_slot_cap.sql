-- Raise the multi-class slot cap from 2 to 5 parts per time slot.
--
-- Context: multi/IB slots store their classes in public.timetable_slot_parts.
-- The table was created (sql/timetable_slot_multi.sql:19 and
-- sql/reservations_schema.sql:110) with an inline column constraint
--   part_index SMALLINT NOT NULL CHECK (part_index IN (1, 2))
-- which is the only database-level enforcement of the 2-class cap.
-- No trigger or RPC caps the number of parts: place_pick/remove_pick only
-- verify that the given part belongs to the slot and to the caller, so they
-- work unchanged with up to 5 parts.
--
-- NOTE: reservations.pick_index CHECK (pick_index IN (1, 2)) is a DIFFERENT
-- feature (a teacher's first/second space choice) and is intentionally left
-- untouched by this migration.
--
-- Idempotent: safe to re-run. Run manually in the Supabase SQL Editor
-- (Dashboard -> SQL -> New query). DO NOT run automatically.

BEGIN;

-- Drop every existing CHECK constraint on timetable_slot_parts that mentions
-- part_index (covers the default name timetable_slot_parts_part_index_check
-- as well as any manually named variant).
DO $$
DECLARE
  v_constraint text;
BEGIN
  FOR v_constraint IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'timetable_slot_parts'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%part_index%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.timetable_slot_parts DROP CONSTRAINT %I',
      v_constraint
    );
  END LOOP;
END;
$$;

-- Recreate the cap at 5 parts under the default name so future re-runs of
-- this script (and of the original schema scripts' DROP/ADD patterns, if any)
-- keep working.
ALTER TABLE public.timetable_slot_parts
  ADD CONSTRAINT timetable_slot_parts_part_index_check
  CHECK (part_index BETWEEN 1 AND 5);

COMMIT;
