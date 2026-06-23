-- Allow up to 2 space picks per teacher per class (franja)
-- Re-runnable: safe to execute multiple times during development.
-- Prerequisites: sql/timetable_slot_multi.sql (or reservations_schema with slot_part_id)
-- Run in Supabase SQL Editor (Dashboard → SQL → New query).

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS pick_index SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE public.reservations
  DROP CONSTRAINT IF EXISTS reservations_pick_index_check;

ALTER TABLE public.reservations
  ADD CONSTRAINT reservations_pick_index_check
  CHECK (pick_index IN (1, 2));

UPDATE public.reservations
SET pick_index = 1
WHERE pick_index IS NULL;

DROP INDEX IF EXISTS public.reservations_one_per_single_slot;
DROP INDEX IF EXISTS public.reservations_one_per_slot_part;

CREATE UNIQUE INDEX IF NOT EXISTS reservations_teacher_slot_pick_single
  ON public.reservations (slot_id, teacher_id, pick_index)
  WHERE slot_part_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reservations_teacher_part_pick
  ON public.reservations (slot_id, teacher_id, slot_part_id, pick_index)
  WHERE slot_part_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- place_pick / remove_pick — up to 2 picks per teacher per franja
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

    IF NOT EXISTS (
      SELECT 1 FROM public.timetable_slot_teachers tst
      WHERE tst.slot_id = p_slot_id AND tst.teacher_id = auth.uid()
    ) AND NOT EXISTS (
      SELECT 1 FROM public.timetable_slots ts
      WHERE ts.id = p_slot_id AND ts.teacher_id = auth.uid()
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
    IF NOT EXISTS (
      SELECT 1 FROM public.timetable_slot_teachers tst
      WHERE tst.slot_id = p_slot_id AND tst.teacher_id = auth.uid()
    ) AND NOT EXISTS (
      SELECT 1 FROM public.timetable_slots ts
      WHERE ts.id = p_slot_id AND ts.teacher_id = auth.uid()
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

GRANT EXECUTE ON FUNCTION public.place_pick(uuid, smallint, uuid, smallint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_pick(uuid, uuid, smallint) TO authenticated;
