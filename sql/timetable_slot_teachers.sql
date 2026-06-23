-- Multiple teachers per timetable slot (junction table)
-- Re-runnable: safe to execute multiple times during development.
-- Prerequisites: sql/reservations_schema.sql, sql/draft_schema.sql
-- Run in Supabase SQL Editor (Dashboard → SQL → New query).

-- ---------------------------------------------------------------------------
-- timetable_slot_teachers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.timetable_slot_teachers (
  slot_id UUID NOT NULL REFERENCES public.timetable_slots (id) ON DELETE CASCADE,
  teacher_id UUID NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  PRIMARY KEY (slot_id, teacher_id)
);

CREATE INDEX IF NOT EXISTS timetable_slot_teachers_teacher_id_idx
  ON public.timetable_slot_teachers (teacher_id);

-- Migrate existing single-teacher assignments
INSERT INTO public.timetable_slot_teachers (slot_id, teacher_id)
SELECT id, teacher_id
FROM public.timetable_slots
WHERE teacher_id IS NOT NULL
ON CONFLICT (slot_id, teacher_id) DO NOTHING;

ALTER TABLE public.timetable_slot_teachers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can select timetable_slot_teachers" ON public.timetable_slot_teachers;
DROP POLICY IF EXISTS "Admins can insert timetable_slot_teachers" ON public.timetable_slot_teachers;
DROP POLICY IF EXISTS "Admins can delete timetable_slot_teachers" ON public.timetable_slot_teachers;

CREATE POLICY "Authenticated can select timetable_slot_teachers"
  ON public.timetable_slot_teachers
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can insert timetable_slot_teachers"
  ON public.timetable_slot_teachers
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "Admins can delete timetable_slot_teachers"
  ON public.timetable_slot_teachers
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

GRANT SELECT, INSERT, DELETE ON TABLE public.timetable_slot_teachers TO authenticated;

-- ---------------------------------------------------------------------------
-- Draft helpers: assigned teachers from junction table
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
    SELECT DISTINCT ts.teacher_id
    FROM public.timetable_slots ts
    WHERE ts.teacher_id IS NOT NULL
  ) AS t;
$$;

-- ---------------------------------------------------------------------------
-- place_pick / remove_pick: any assigned teacher may pick for the slot
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.place_pick(
  p_slot_id uuid,
  p_space_id smallint
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
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'teacher'::public.role
  ) THEN
    RAISE EXCEPTION 'solo docentes pueden reservar';
  END IF;

  SELECT * INTO v_slot
  FROM public.timetable_slots
  WHERE id = p_slot_id;

  IF v_slot.id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.timetable_slot_teachers tst
    WHERE tst.slot_id = p_slot_id
      AND tst.teacher_id = auth.uid()
  ) AND NOT EXISTS (
    SELECT 1
    FROM public.timetable_slots ts
    WHERE ts.id = p_slot_id
      AND ts.teacher_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not your slot';
  END IF;

  IF v_session.phase = 'live'::public.draft_phase THEN
    SELECT dt.teacher_id
    INTO v_active_teacher
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
    AND teacher_id = auth.uid();

  BEGIN
    INSERT INTO public.reservations (
      slot_id,
      space_id,
      teacher_id,
      day,
      start_time,
      confirmed,
      session_id
    )
    VALUES (
      p_slot_id,
      p_space_id,
      auth.uid(),
      v_slot.day,
      v_slot.start_time,
      false,
      v_session.id
    );
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'espacio no disponible';
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_pick(p_slot_id uuid)
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
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'teacher'::public.role
  ) THEN
    RAISE EXCEPTION 'solo docentes pueden reservar';
  END IF;

  SELECT * INTO v_slot
  FROM public.timetable_slots
  WHERE id = p_slot_id;

  IF v_slot.id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.timetable_slot_teachers tst
    WHERE tst.slot_id = p_slot_id
      AND tst.teacher_id = auth.uid()
  ) AND NOT EXISTS (
    SELECT 1
    FROM public.timetable_slots ts
    WHERE ts.id = p_slot_id
      AND ts.teacher_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not your slot';
  END IF;

  IF v_session.phase = 'live'::public.draft_phase THEN
    SELECT dt.teacher_id
    INTO v_active_teacher
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
    AND confirmed = false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.place_pick(uuid, smallint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_pick(uuid) TO authenticated;

-- Optional: drop legacy column after migration (uncomment when ready)
-- ALTER TABLE public.timetable_slots DROP COLUMN IF EXISTS teacher_id;
