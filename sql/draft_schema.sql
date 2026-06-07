-- Weekly reservation draft: sessions, turns, guarded picks, Realtime
-- Re-runnable: safe to execute multiple times during development.
-- Prerequisites: sql/schema.sql, sql/reservations_schema.sql,
-- sql/teacher_profile_schema.sql (is_admin, profiles.teacher_code).
-- Run in Supabase SQL Editor (Dashboard → SQL → New query).

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.draft_phase AS ENUM ('setup', 'live', 'open', 'closed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.turn_status AS ENUM ('pending', 'active', 'done', 'skipped');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- draft_sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.draft_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phase public.draft_phase NOT NULL DEFAULT 'setup',
  order_mode TEXT NOT NULL CHECK (order_mode IN ('random', 'ordenado')),
  current_position INT,
  turn_ends_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.draft_sessions REPLICA IDENTITY FULL;

-- ---------------------------------------------------------------------------
-- draft_turns
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.draft_turns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.draft_sessions (id) ON DELETE CASCADE,
  position INT NOT NULL,
  teacher_id UUID NOT NULL REFERENCES public.profiles (id),
  status public.turn_status NOT NULL DEFAULT 'pending',
  UNIQUE (session_id, position),
  UNIQUE (session_id, teacher_id)
);

ALTER TABLE public.draft_turns REPLICA IDENTITY FULL;

-- ---------------------------------------------------------------------------
-- reservations.session_id (link picks to a draft week)
-- ---------------------------------------------------------------------------
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES public.draft_sessions (id) ON DELETE SET NULL;

ALTER TABLE public.reservations REPLICA IDENTITY FULL;

-- ---------------------------------------------------------------------------
-- Helpers (not granted to clients)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_session()
RETURNS public.draft_sessions
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT *
  FROM public.draft_sessions
  WHERE phase <> 'closed'::public.draft_phase
  ORDER BY created_at DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public._assigned_teacher_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(t.teacher_id ORDER BY t.teacher_id), '{}'::uuid[])
  FROM (
    SELECT DISTINCT ts.teacher_id
    FROM public.timetable_slots ts
    WHERE ts.teacher_id IS NOT NULL
  ) AS t;
$$;

CREATE OR REPLACE FUNCTION public._advance_draft_turn(p_session_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active public.draft_turns;
  v_has_confirmed boolean;
  v_next public.draft_turns;
BEGIN
  SELECT *
  INTO v_active
  FROM public.draft_turns
  WHERE session_id = p_session_id
    AND status = 'active'::public.turn_status
  LIMIT 1;

  IF v_active.id IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM public.reservations
  WHERE session_id = p_session_id
    AND teacher_id = v_active.teacher_id
    AND confirmed = false;

  SELECT EXISTS (
    SELECT 1
    FROM public.reservations r
    WHERE r.session_id = p_session_id
      AND r.teacher_id = v_active.teacher_id
      AND r.confirmed = true
  )
  INTO v_has_confirmed;

  UPDATE public.draft_turns
  SET status = CASE
    WHEN v_has_confirmed THEN 'done'::public.turn_status
    ELSE 'skipped'::public.turn_status
  END
  WHERE id = v_active.id;

  SELECT *
  INTO v_next
  FROM public.draft_turns
  WHERE session_id = p_session_id
    AND status = 'pending'::public.turn_status
  ORDER BY position
  LIMIT 1;

  IF v_next.id IS NOT NULL THEN
    UPDATE public.draft_turns
    SET status = 'active'::public.turn_status
    WHERE id = v_next.id;

    UPDATE public.draft_sessions
    SET
      current_position = v_next.position,
      turn_ends_at = NOW() + INTERVAL '3 minutes'
    WHERE id = p_session_id;
  ELSE
    UPDATE public.draft_sessions
    SET
      phase = 'open'::public.draft_phase,
      turn_ends_at = NULL
    WHERE id = p_session_id;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- start_draft (admin)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_draft(
  p_order_mode text,
  p_ordered_ids uuid[] DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_teacher_ids uuid[];
  v_ordered uuid[];
  v_session_id uuid;
  v_pos int;
  v_teacher_id uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'only admins can start draft';
  END IF;

  IF p_order_mode NOT IN ('random', 'ordenado') THEN
    RAISE EXCEPTION 'invalid order_mode';
  END IF;

  UPDATE public.draft_sessions
  SET phase = 'closed'::public.draft_phase
  WHERE phase <> 'closed'::public.draft_phase;

  DELETE FROM public.reservations WHERE true;

  v_teacher_ids := public._assigned_teacher_ids();

  IF array_length(v_teacher_ids, 1) IS NULL OR array_length(v_teacher_ids, 1) = 0 THEN
    RAISE EXCEPTION 'no teachers assigned in timetable';
  END IF;

  IF p_order_mode = 'random' THEN
    SELECT array_agg(t.id ORDER BY random())
    INTO v_ordered
    FROM unnest(v_teacher_ids) AS t(id);
  ELSE
    IF p_ordered_ids IS NULL THEN
      RAISE EXCEPTION 'ordered mode requires p_ordered_ids';
    END IF;

    IF (
      SELECT array_agg(x ORDER BY x)
      FROM unnest(v_teacher_ids) AS x
    ) IS DISTINCT FROM (
      SELECT array_agg(x ORDER BY x)
      FROM unnest(p_ordered_ids) AS x
    ) THEN
      RAISE EXCEPTION 'ordered teacher list does not match assigned teachers';
    END IF;

    v_ordered := p_ordered_ids;
  END IF;

  INSERT INTO public.draft_sessions (
    phase,
    order_mode,
    current_position,
    turn_ends_at,
    started_at
  )
  VALUES (
    'live'::public.draft_phase,
    p_order_mode,
    1,
    NOW() + INTERVAL '3 minutes',
    NOW()
  )
  RETURNING id INTO v_session_id;

  v_pos := 0;
  FOREACH v_teacher_id IN ARRAY v_ordered LOOP
    v_pos := v_pos + 1;
    INSERT INTO public.draft_turns (session_id, position, teacher_id, status)
    VALUES (
      v_session_id,
      v_pos,
      v_teacher_id,
      CASE
        WHEN v_pos = 1 THEN 'active'::public.turn_status
        ELSE 'pending'::public.turn_status
      END
    );
  END LOOP;

  RETURN v_session_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.start_draft(text, uuid[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- place_pick (teacher via RPC)
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

  IF v_slot.teacher_id IS DISTINCT FROM auth.uid() THEN
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

GRANT EXECUTE ON FUNCTION public.place_pick(uuid, smallint) TO authenticated;

-- ---------------------------------------------------------------------------
-- remove_pick (teacher via RPC)
-- ---------------------------------------------------------------------------
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

  IF v_slot.teacher_id IS DISTINCT FROM auth.uid() THEN
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

GRANT EXECUTE ON FUNCTION public.remove_pick(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- confirm_turn (teacher via RPC)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_turn(p_code text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.draft_sessions;
  v_stored_code text;
  v_is_active boolean;
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
    RAISE EXCEPTION 'solo docentes pueden confirmar';
  END IF;

  SELECT p.teacher_code
  INTO v_stored_code
  FROM public.profiles p
  WHERE p.id = auth.uid();

  IF v_stored_code IS NULL OR v_stored_code <> p_code THEN
    RAISE EXCEPTION 'código incorrecto';
  END IF;

  IF v_session.phase = 'live'::public.draft_phase THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.draft_turns dt
      WHERE dt.session_id = v_session.id
        AND dt.status = 'active'::public.turn_status
        AND dt.teacher_id = auth.uid()
    )
    INTO v_is_active;

    IF NOT v_is_active THEN
      RAISE EXCEPTION 'not your turn';
    END IF;
  END IF;

  UPDATE public.reservations
  SET confirmed = true
  WHERE teacher_id = auth.uid()
    AND session_id = v_session.id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_turn(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- advance_turn (admin manual skip or deadline)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.advance_turn()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.draft_sessions;
BEGIN
  v_session := public.current_session();

  IF v_session.id IS NULL OR v_session.phase <> 'live'::public.draft_phase THEN
    RAISE EXCEPTION 'no live draft to advance';
  END IF;

  IF NOT public.is_admin() AND (v_session.turn_ends_at IS NULL OR NOW() < v_session.turn_ends_at) THEN
    RAISE EXCEPTION 'turn has not ended yet';
  END IF;

  PERFORM public._advance_draft_turn(v_session.id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.advance_turn() TO authenticated;

-- ---------------------------------------------------------------------------
-- reset_draft (admin)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_draft()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'only admins can reset draft';
  END IF;

  DELETE FROM public.reservations WHERE true;

  UPDATE public.draft_sessions
  SET phase = 'closed'::public.draft_phase
  WHERE phase <> 'closed'::public.draft_phase;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_draft() TO authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE public.draft_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_turns ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.draft_sessions TO authenticated;
GRANT SELECT ON TABLE public.draft_turns TO authenticated;

DROP POLICY IF EXISTS "Authenticated can select draft_sessions" ON public.draft_sessions;
CREATE POLICY "Authenticated can select draft_sessions"
  ON public.draft_sessions
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Authenticated can select draft_turns" ON public.draft_turns;
CREATE POLICY "Authenticated can select draft_turns"
  ON public.draft_turns
  FOR SELECT
  TO authenticated
  USING (true);

-- No INSERT/UPDATE/DELETE policies on draft_sessions or draft_turns — only
-- SECURITY DEFINER functions write those tables.

-- reservations: tighten writes — teachers must use place_pick / remove_pick /
-- confirm_turn (definer bypasses RLS). Admins retain direct table access.
DROP POLICY IF EXISTS "Teachers and admins can insert reservations" ON public.reservations;
DROP POLICY IF EXISTS "Teachers and admins can update reservations" ON public.reservations;
DROP POLICY IF EXISTS "Teachers and admins can delete reservations" ON public.reservations;
DROP POLICY IF EXISTS "Admins can insert reservations" ON public.reservations;
DROP POLICY IF EXISTS "Admins can update reservations" ON public.reservations;
DROP POLICY IF EXISTS "Admins can delete reservations" ON public.reservations;

CREATE POLICY "Admins can insert reservations"
  ON public.reservations
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "Admins can update reservations"
  ON public.reservations
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "Admins can delete reservations"
  ON public.reservations
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- "Authenticated can select reservations" unchanged (defined in reservations_schema.sql).

-- ---------------------------------------------------------------------------
-- Realtime publication
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.draft_sessions;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.draft_turns;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.reservations;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Verification (manual — run in SQL Editor as admin)
-- ---------------------------------------------------------------------------
-- Dashboard step: Database → Replication → enable Realtime for
-- draft_sessions, draft_turns, and reservations (publication alone may not
-- be enough in all projects).
--
-- (1) Start a random-order draft:
-- SELECT public.start_draft('random');
--
-- (2) List turns for the current session:
-- SELECT dt.position, dt.status, p.full_name
-- FROM public.draft_turns dt
-- JOIN public.profiles p ON p.id = dt.teacher_id
-- WHERE dt.session_id = (SELECT id FROM public.current_session())
-- ORDER BY dt.position;
--
-- (3) Simulate timeout advance (as admin, or wait 3 minutes):
-- SELECT public.advance_turn();
--
-- (4) Reset:
-- SELECT public.reset_draft();
