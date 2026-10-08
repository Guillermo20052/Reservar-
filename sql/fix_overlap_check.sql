-- Fix: teacher draft reservations can overlap in the same room
-- ---------------------------------------------------------------------------
-- BUG: place_pick only relied on the unique index
--   reservations_space_day_start_unique (week_start, space_id, day, start_time)
-- which catches two bookings with the SAME start, but not an OVERLAP with a
-- different start. Example seen in production: Anima, jueves,
-- 12:15–14:15 and 13:15–14:15, both confirmed, same week.
--
-- FIX: place_pick(uuid, smallint, uuid, smallint) is replaced in place. Every
-- existing check (pick index, session phase, role gate, slot/part ownership,
-- turn check, week-scoped replace-DELETE, INSERT + unique_violation handler)
-- is byte-identical and in the original order. One block is added after the
-- DELETE and before the INSERT:
--   1. pg_advisory_xact_lock(hashtext(week_start:space_id:day)) — serializes
--      concurrent picks for the same room+day+week (same pattern as
--      sql/draft_race_fix.sql), so two overlapping picks can't both pass the
--      check before either inserts. Under READ COMMITTED the EXISTS below takes
--      a fresh snapshot after the lock is granted, so it sees the winner's row.
--   2. Reject if any other reservation in the same week_start + space_id + day
--      overlaps by true half-open interval math:
--        existing.start_time < v_slot.end_time
--        AND v_slot.start_time < existing_slot.end_time
--      The existing row's end comes from timetable_slots via slot_id. Multi
--      slot parts have no times of their own; they share the parent slot's
--      start_time/end_time, so the same join covers them.
--      The caller's own row being replaced is already gone (DELETE above, same
--      transaction); it is also excluded explicitly for clarity.
--
-- NOT CHANGED: study_space_busy(), remove_pick, the unique indexes, existing
-- rows. Existing overlapping pairs are NOT touched — resolve them manually
-- (see the read-only report query shared alongside this file).
--
-- SIGNATURE: place_pick(uuid, smallint, uuid, smallint) is unchanged, so
-- CREATE OR REPLACE replaces it in place and no DROP is needed. The DO block
-- before COMMIT aborts if more than one place_pick overload exists.
--
-- Idempotent: safe to re-run. Run MANUALLY in the Supabase SQL Editor
-- (Dashboard -> SQL -> New query). DO NOT run automatically.
--
-- Prerequisites: sql/draft_weeks.sql (reservations.week_start, session_id).
-- ---------------------------------------------------------------------------

BEGIN;

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
    AND week_start = v_session.week_start
    AND (
      (p_slot_part_id IS NULL AND slot_part_id IS NULL)
      OR slot_part_id = p_slot_part_id
    );

  -- Overlap guard: serialize picks for this room+day+week, then reject any
  -- existing reservation whose [start, end) overlaps this slot's [start, end).
  PERFORM pg_advisory_xact_lock(
    hashtext(v_session.week_start::text || ':' || p_space_id::text || ':' || v_slot.day::text)
  );

  IF EXISTS (
    SELECT 1
    FROM public.reservations r
    JOIN public.timetable_slots rts ON rts.id = r.slot_id
    WHERE r.week_start = v_session.week_start
      AND r.space_id = p_space_id
      AND r.day = v_slot.day
      AND r.start_time < v_slot.end_time
      AND v_slot.start_time < rts.end_time
      AND NOT (
        r.slot_id = p_slot_id
        AND r.teacher_id = auth.uid()
        AND r.pick_index = p_pick_index
        AND (
          (p_slot_part_id IS NULL AND r.slot_part_id IS NULL)
          OR r.slot_part_id = p_slot_part_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'espacio no disponible en ese horario';
  END IF;

  BEGIN
    INSERT INTO public.reservations (
      slot_id, slot_part_id, pick_index, space_id, teacher_id, day, start_time,
      confirmed, session_id, week_start
    )
    VALUES (
      p_slot_id, p_slot_part_id, p_pick_index, p_space_id, auth.uid(),
      v_slot.day, v_slot.start_time, false, v_session.id, v_session.week_start
    );
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'espacio no disponible';
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.place_pick(uuid, smallint, uuid, smallint) TO authenticated;

-- ---------------------------------------------------------------------------
-- Overload guard: exactly one place_pick must exist after this file.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_place int;
BEGIN
  SELECT count(*) INTO v_place
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'place_pick';

  IF v_place <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 place_pick overload, found %', v_place;
  END IF;
END;
$$;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification (run manually after COMMIT):
-- SELECT pg_get_functiondef('public.place_pick(uuid,smallint,uuid,smallint)'::regprocedure)
--        LIKE '%pg_advisory_xact_lock%' AS has_lock;
-- ---------------------------------------------------------------------------
