-- Fix: the obsolete timetable_slots.teacher_id column poisons draft ownership.
--
-- Symptoms it caused: teachers saw (and could reserve) single-class slots whose
-- legacy teacher_id still pointed at them after the class had been reassigned
-- via the junction tables, while place_pick/remove_pick accepted that stale
-- column as an ownership OR-branch.
--
-- End state after this migration:
--   * timetable_slot_teachers is the ONLY source of single-slot ownership
--     (timetable_slot_part_teachers already is, for multi parts).
--   * timetable_slots.teacher_id is NULL everywhere (column kept for now so
--     old scripts referencing it don't break; it is no longer consulted).
--   * place_pick / remove_pick check junction rows only.
--
-- Idempotent: safe to re-run. Run manually in the Supabase SQL Editor
-- (Dashboard -> SQL -> New query). DO NOT run automatically.

BEGIN;

-- ---------------------------------------------------------------------------
-- (a) Backfill: any slot whose ownership exists ONLY in the legacy column gets
-- a junction row, so no legitimate assignment is lost when we null the column.
-- ON CONFLICT matches timetable_slot_teachers' PRIMARY KEY (slot_id, teacher_id).
-- ---------------------------------------------------------------------------
INSERT INTO public.timetable_slot_teachers (slot_id, teacher_id)
SELECT ts.id, ts.teacher_id
FROM public.timetable_slots ts
WHERE ts.teacher_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.timetable_slot_teachers t
    WHERE t.slot_id = ts.id
  )
ON CONFLICT (slot_id, teacher_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- (b) Null out the legacy column. MUST run after the backfill above.
-- Slots whose junction rows already disagree with the legacy value keep the
-- junction assignment (the admin-maintained truth); the stale value is dropped.
-- ---------------------------------------------------------------------------
UPDATE public.timetable_slots
SET teacher_id = NULL
WHERE teacher_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- (c) Recreate place_pick and remove_pick with junction-only ownership.
-- Bodies are byte-identical to sql/draft_schema.sql except that the
-- "OR timetable_slots.teacher_id = auth.uid()" legacy branch is gone from the
-- single-slot check.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.place_pick(
  p_slot_id uuid,
  p_space_id smallint,
  p_slot_part_id uuid DEFAULT NULL,
  p_pick_index smallint DEFAULT 1
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.draft_sessions;
  v_slot public.timetable_slots;
  v_active_teacher uuid;
BEGIN
  IF p_pick_index IS NULL OR p_pick_index NOT IN (1, 2) THEN
    RAISE EXCEPTION 'invalid pick index';
  END IF;

  v_session := public.current_session();

  IF v_session.id IS NULL OR v_session.phase NOT IN ('live'::public.draft_phase, 'open'::public.draft_phase) THEN
    RAISE EXCEPTION 'reservas cerradas';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'teacher'::public.role
  ) THEN
    RAISE EXCEPTION 'solo docentes pueden reservar';
  END IF;

  SELECT * INTO v_slot FROM public.timetable_slots WHERE id = p_slot_id;

  IF v_slot.id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  IF v_slot.is_multi THEN
    IF p_slot_part_id IS NULL THEN
      RAISE EXCEPTION 'part required for multi slot';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.timetable_slot_parts tsp
      WHERE tsp.id = p_slot_part_id AND tsp.slot_id = p_slot_id
    ) THEN
      RAISE EXCEPTION 'invalid slot part';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.timetable_slot_part_teachers tspt
      WHERE tspt.part_id = p_slot_part_id AND tspt.teacher_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not your slot';
    END IF;
  ELSE
    IF p_slot_part_id IS NOT NULL THEN
      RAISE EXCEPTION 'part not allowed for single slot';
    END IF;

    -- Junction-only ownership: the legacy timetable_slots.teacher_id
    -- OR-branch that used to sit here is intentionally removed.
    IF NOT EXISTS (
      SELECT 1 FROM public.timetable_slot_teachers tst
      WHERE tst.slot_id = p_slot_id AND tst.teacher_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not your slot';
    END IF;
  END IF;

  IF v_session.phase = 'live'::public.draft_phase THEN
    SELECT dt.teacher_id INTO v_active_teacher
    FROM public.draft_turns dt
    WHERE dt.session_id = v_session.id
      AND dt.status = 'active'::public.turn_status
    LIMIT 1;

    IF v_active_teacher IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'not your turn';
    END IF;
  END IF;

  DELETE FROM public.reservations
  WHERE slot_id = p_slot_id
    AND teacher_id = auth.uid()
    AND pick_index = p_pick_index
    AND (
      (p_slot_part_id IS NULL AND slot_part_id IS NULL)
      OR slot_part_id = p_slot_part_id
    );

  BEGIN
    INSERT INTO public.reservations (
      slot_id, slot_part_id, pick_index, space_id, teacher_id, day, start_time, confirmed, session_id
    )
    VALUES (
      p_slot_id, p_slot_part_id, p_pick_index, p_space_id, auth.uid(),
      v_slot.day, v_slot.start_time, false, v_session.id
    );
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'espacio no disponible';
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_pick(
  p_slot_id uuid,
  p_slot_part_id uuid DEFAULT NULL,
  p_pick_index smallint DEFAULT 1
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.draft_sessions;
  v_slot public.timetable_slots;
  v_active_teacher uuid;
BEGIN
  IF p_pick_index IS NULL OR p_pick_index NOT IN (1, 2) THEN
    RAISE EXCEPTION 'invalid pick index';
  END IF;

  v_session := public.current_session();

  IF v_session.id IS NULL OR v_session.phase NOT IN ('live'::public.draft_phase, 'open'::public.draft_phase) THEN
    RAISE EXCEPTION 'reservas cerradas';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'teacher'::public.role
  ) THEN
    RAISE EXCEPTION 'solo docentes pueden reservar';
  END IF;

  SELECT * INTO v_slot FROM public.timetable_slots WHERE id = p_slot_id;

  IF v_slot.id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  IF v_slot.is_multi THEN
    IF p_slot_part_id IS NULL THEN
      RAISE EXCEPTION 'part required for multi slot';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.timetable_slot_part_teachers tspt
      WHERE tspt.part_id = p_slot_part_id AND tspt.teacher_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not your slot';
    END IF;
  ELSE
    -- Junction-only ownership: legacy OR-branch removed (see place_pick).
    IF NOT EXISTS (
      SELECT 1 FROM public.timetable_slot_teachers tst
      WHERE tst.slot_id = p_slot_id AND tst.teacher_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not your slot';
    END IF;
  END IF;

  IF v_session.phase = 'live'::public.draft_phase THEN
    SELECT dt.teacher_id INTO v_active_teacher
    FROM public.draft_turns dt
    WHERE dt.session_id = v_session.id
      AND dt.status = 'active'::public.turn_status
    LIMIT 1;

    IF v_active_teacher IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'not your turn';
    END IF;
  END IF;

  DELETE FROM public.reservations
  WHERE slot_id = p_slot_id
    AND teacher_id = auth.uid()
    AND pick_index = p_pick_index
    AND confirmed = false
    AND (
      (p_slot_part_id IS NULL AND slot_part_id IS NULL)
      OR slot_part_id = p_slot_part_id
    );
END;
$$;

-- Grants are preserved by CREATE OR REPLACE, but re-assert them so this file
-- is self-sufficient on a fresh database too.
GRANT EXECUTE ON FUNCTION public.place_pick(uuid, smallint, uuid, smallint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_pick(uuid, uuid, smallint) TO authenticated;

COMMIT;
