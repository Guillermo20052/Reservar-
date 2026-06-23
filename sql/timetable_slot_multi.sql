-- IB split slots: two classes / two spaces in one time block (e.g. Business + History)
-- Re-runnable: safe to execute multiple times during development.
-- Prerequisites: sql/timetable_slot_teachers.sql, sql/draft_schema.sql
-- Run in Supabase SQL Editor (Dashboard → SQL → New query).

-- ---------------------------------------------------------------------------
-- timetable_slots.is_multi
-- ---------------------------------------------------------------------------
ALTER TABLE public.timetable_slots
  ADD COLUMN IF NOT EXISTS is_multi BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- timetable_slot_parts (exactly 2 parts when is_multi)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.timetable_slot_parts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id UUID NOT NULL REFERENCES public.timetable_slots (id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES public.classes (id) ON DELETE CASCADE,
  part_index SMALLINT NOT NULL CHECK (part_index IN (1, 2)),
  UNIQUE (slot_id, part_index)
);

CREATE INDEX IF NOT EXISTS timetable_slot_parts_slot_id_idx
  ON public.timetable_slot_parts (slot_id);

CREATE TABLE IF NOT EXISTS public.timetable_slot_part_teachers (
  part_id UUID NOT NULL REFERENCES public.timetable_slot_parts (id) ON DELETE CASCADE,
  teacher_id UUID NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  PRIMARY KEY (part_id, teacher_id)
);

CREATE INDEX IF NOT EXISTS timetable_slot_part_teachers_teacher_id_idx
  ON public.timetable_slot_part_teachers (teacher_id);

-- ---------------------------------------------------------------------------
-- reservations.slot_part_id (NULL = single-class slot)
-- ---------------------------------------------------------------------------
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS slot_part_id UUID REFERENCES public.timetable_slot_parts (id) ON DELETE CASCADE;

ALTER TABLE public.reservations
  DROP CONSTRAINT IF EXISTS one_reservation_per_slot;

CREATE UNIQUE INDEX IF NOT EXISTS reservations_one_per_single_slot
  ON public.reservations (slot_id)
  WHERE slot_part_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reservations_one_per_slot_part
  ON public.reservations (slot_part_id)
  WHERE slot_part_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.timetable_slot_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timetable_slot_part_teachers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can select timetable_slot_parts" ON public.timetable_slot_parts;
DROP POLICY IF EXISTS "Admins can insert timetable_slot_parts" ON public.timetable_slot_parts;
DROP POLICY IF EXISTS "Admins can update timetable_slot_parts" ON public.timetable_slot_parts;
DROP POLICY IF EXISTS "Admins can delete timetable_slot_parts" ON public.timetable_slot_parts;

CREATE POLICY "Authenticated can select timetable_slot_parts"
  ON public.timetable_slot_parts FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can insert timetable_slot_parts"
  ON public.timetable_slot_parts FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY "Admins can update timetable_slot_parts"
  ON public.timetable_slot_parts FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "Admins can delete timetable_slot_parts"
  ON public.timetable_slot_parts FOR DELETE TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "Authenticated can select timetable_slot_part_teachers" ON public.timetable_slot_part_teachers;
DROP POLICY IF EXISTS "Admins can insert timetable_slot_part_teachers" ON public.timetable_slot_part_teachers;
DROP POLICY IF EXISTS "Admins can delete timetable_slot_part_teachers" ON public.timetable_slot_part_teachers;

CREATE POLICY "Authenticated can select timetable_slot_part_teachers"
  ON public.timetable_slot_part_teachers FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can insert timetable_slot_part_teachers"
  ON public.timetable_slot_part_teachers FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY "Admins can delete timetable_slot_part_teachers"
  ON public.timetable_slot_part_teachers FOR DELETE TO authenticated USING (public.is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.timetable_slot_parts TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.timetable_slot_part_teachers TO authenticated;

-- ---------------------------------------------------------------------------
-- Assigned teachers include part teachers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._assigned_teacher_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(t.teacher_id ORDER BY t.teacher_id), '{}'::uuid[])
  FROM (
    SELECT DISTINCT tst.teacher_id
    FROM public.timetable_slot_teachers tst
    UNION
    SELECT DISTINCT tspt.teacher_id
    FROM public.timetable_slot_part_teachers tspt
    UNION
    SELECT DISTINCT ts.teacher_id
    FROM public.timetable_slots ts
    WHERE ts.teacher_id IS NOT NULL
  ) AS t;
$$;

-- ---------------------------------------------------------------------------
-- place_pick / remove_pick with optional slot_part_id
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.place_pick(
  p_slot_id uuid,
  p_space_id smallint,
  p_slot_part_id uuid DEFAULT NULL
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
      WHERE tsp.id = p_slot_part_id
        AND tsp.slot_id = p_slot_id
    ) THEN
      RAISE EXCEPTION 'invalid slot part';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.timetable_slot_part_teachers tspt
      WHERE tspt.part_id = p_slot_part_id
        AND tspt.teacher_id = auth.uid()
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
    AND (
      (p_slot_part_id IS NULL AND slot_part_id IS NULL)
      OR slot_part_id = p_slot_part_id
    );

  BEGIN
    INSERT INTO public.reservations (
      slot_id, slot_part_id, space_id, teacher_id, day, start_time, confirmed, session_id
    )
    VALUES (
      p_slot_id, p_slot_part_id, p_space_id, auth.uid(),
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
  p_slot_part_id uuid DEFAULT NULL
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
    AND confirmed = false
    AND (
      (p_slot_part_id IS NULL AND slot_part_id IS NULL)
      OR slot_part_id = p_slot_part_id
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.place_pick(uuid, smallint, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_pick(uuid, uuid) TO authenticated;
