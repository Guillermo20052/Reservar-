-- Study-space booking (separate from weekly teacher draft)
-- Re-runnable: safe to execute multiple times during development.
-- Prerequisites: sql/schema.sql, sql/reservations_schema.sql (spaces, reservations,
-- timetable_slots, weekday enum, is_admin, profiles).
-- Run in Supabase SQL Editor (Dashboard → SQL → New query).

-- ---------------------------------------------------------------------------
-- Enum
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.study_status AS ENUM (
    'pending', 'approved', 'rejected', 'cancelled'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- study_spaces (admin-managed; optional link to a teaching space = same room)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.study_spaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  space_id SMALLINT REFERENCES public.spaces (id),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES public.profiles (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.study_spaces REPLICA IDENTITY FULL;

-- ---------------------------------------------------------------------------
-- study_bookings
-- Interval end is computed as start_time + duration_min (see study_space_busy).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.study_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_space_id UUID NOT NULL REFERENCES public.study_spaces (id) ON DELETE CASCADE,
  requester_id UUID NOT NULL REFERENCES public.profiles (id),
  booking_date DATE NOT NULL,
  start_time TIME NOT NULL,
  duration_min SMALLINT NOT NULL CHECK (duration_min IN (30, 60, 120)),
  status public.study_status NOT NULL DEFAULT 'pending',
  decided_by UUID REFERENCES public.profiles (id),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.study_bookings REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS study_bookings_space_date_idx
  ON public.study_bookings (study_space_id, booking_date)
  WHERE status IN ('pending'::public.study_status, 'approved'::public.study_status);

-- ---------------------------------------------------------------------------
-- Map calendar date → teaching weekday enum (Mon–Fri only; Sat/Sun → NULL)
-- Uses ISO day: 1 = lunes … 5 = viernes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._date_to_weekday(p_date date)
RETURNS public.weekday
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE extract(isodow FROM p_date)::int
    WHEN 1 THEN 'lunes'::public.weekday
    WHEN 2 THEN 'martes'::public.weekday
    WHEN 3 THEN 'miercoles'::public.weekday
    WHEN 4 THEN 'jueves'::public.weekday
    WHEN 5 THEN 'viernes'::public.weekday
    ELSE NULL
  END;
$$;

-- ---------------------------------------------------------------------------
-- study_space_busy: TRUE if the requested interval conflicts with teaching or study
--
-- Overlap math (half-open [start, end) on TIME for same calendar day):
--   req_end = p_start + p_duration_min minutes
--   overlaps other when: p_start < other_end AND other_start < req_end
--
-- Branch (a) Teaching: only when study space has space_id set AND p_date is Mon–Fri.
--   Match reservations.day = weekday(p_date), confirmed = true, same space_id.
--   Teaching interval: [r.start_time, ts.end_time) via slot_id → timetable_slots.
--
-- Branch (b) Study: pending/approved bookings on same booking_date, same physical
--   room (same study_space_id OR both study_spaces share the same linked space_id).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.study_space_busy(
  p_study_space_id uuid,
  p_date date,
  p_start time,
  p_duration_min int,
  p_exclude_booking uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link smallint;
  v_weekday public.weekday;
  v_req_end time;
BEGIN
  IF p_duration_min IS NULL OR p_duration_min NOT IN (30, 60, 120) THEN
    RETURN TRUE;
  END IF;

  v_req_end := p_start + (p_duration_min || ' minutes')::interval;

  SELECT ss.space_id
  INTO v_link
  FROM public.study_spaces ss
  WHERE ss.id = p_study_space_id;

  IF NOT FOUND THEN
    RETURN TRUE;
  END IF;

  v_weekday := public._date_to_weekday(p_date);

  -- (a) Confirmed teaching reservation in linked physical room (weekdays only)
  IF v_link IS NOT NULL AND v_weekday IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.reservations r
      JOIN public.timetable_slots ts ON ts.id = r.slot_id
      WHERE r.space_id = v_link
        AND r.day = v_weekday
        AND r.confirmed = true
        AND p_start < ts.end_time
        AND r.start_time < v_req_end
    ) THEN
      RETURN TRUE;
    END IF;
  END IF;

  -- (b) Other study bookings (pending or approved) in the same room
  IF EXISTS (
    SELECT 1
    FROM public.study_bookings b
    JOIN public.study_spaces ss ON ss.id = b.study_space_id
    WHERE b.status IN ('pending'::public.study_status, 'approved'::public.study_status)
      AND b.booking_date = p_date
      AND (p_exclude_booking IS NULL OR b.id <> p_exclude_booking)
      AND (
        b.study_space_id = p_study_space_id
        OR (
          v_link IS NOT NULL
          AND ss.space_id IS NOT NULL
          AND ss.space_id = v_link
        )
      )
      AND p_start < (b.start_time + (b.duration_min || ' minutes')::interval)
      AND b.start_time < v_req_end
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$;

-- Not granted to clients — used only from other definer RPCs.

-- ---------------------------------------------------------------------------
-- request_study_booking
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_study_booking(
  p_study_space_id uuid,
  p_date date,
  p_start time,
  p_duration_min int
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_held int;
  v_active boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role IN ('student'::public.role, 'teacher'::public.role)
  ) THEN
    RAISE EXCEPTION 'solo estudiantes y docentes pueden solicitar espacio de estudio';
  END IF;

  IF p_duration_min IS NULL OR p_duration_min NOT IN (30, 60, 120) THEN
    RAISE EXCEPTION 'duración inválida';
  END IF;

  SELECT ss.active
  INTO v_active
  FROM public.study_spaces ss
  WHERE ss.id = p_study_space_id;

  IF NOT FOUND OR NOT v_active THEN
    RAISE EXCEPTION 'espacio de estudio no disponible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'student'::public.role
  ) THEN
    SELECT COALESCE(sum(sb.duration_min), 0)::int
    INTO v_held
    FROM public.study_bookings sb
    WHERE sb.requester_id = auth.uid()
      AND sb.booking_date = p_date
      AND sb.status IN ('pending'::public.study_status, 'approved'::public.study_status);

    IF v_held + p_duration_min > 120 THEN
      RAISE EXCEPTION 'límite diario de 2 horas';
    END IF;
  END IF;

  IF public.study_space_busy(p_study_space_id, p_date, p_start, p_duration_min, NULL) THEN
    RAISE EXCEPTION 'espacio no disponible en ese horario';
  END IF;

  INSERT INTO public.study_bookings (
    study_space_id,
    requester_id,
    booking_date,
    start_time,
    duration_min,
    status
  )
  VALUES (
    p_study_space_id,
    auth.uid(),
    p_date,
    p_start,
    p_duration_min,
    'pending'::public.study_status
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_study_booking(uuid, date, time, int) TO authenticated;

-- ---------------------------------------------------------------------------
-- decide_study_booking (any teacher or admin)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decide_study_booking(
  p_booking_id uuid,
  p_approve boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_booking public.study_bookings;
BEGIN
  IF NOT public.is_admin() AND NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'teacher'::public.role
  ) THEN
    RAISE EXCEPTION 'solo docentes o administradores pueden decidir solicitudes';
  END IF;

  SELECT *
  INTO v_booking
  FROM public.study_bookings
  WHERE id = p_booking_id;

  IF v_booking.id IS NULL THEN
    RAISE EXCEPTION 'solicitud no encontrada';
  END IF;

  IF v_booking.status <> 'pending'::public.study_status THEN
    RAISE EXCEPTION 'la solicitud ya fue resuelta';
  END IF;

  IF p_approve THEN
    IF public.study_space_busy(
      v_booking.study_space_id,
      v_booking.booking_date,
      v_booking.start_time,
      v_booking.duration_min,
      p_booking_id
    ) THEN
      RAISE EXCEPTION 'espacio no disponible en ese horario';
    END IF;

    UPDATE public.study_bookings
    SET
      status = 'approved'::public.study_status,
      decided_by = auth.uid(),
      decided_at = NOW()
    WHERE id = p_booking_id;
  ELSE
    UPDATE public.study_bookings
    SET
      status = 'rejected'::public.study_status,
      decided_by = auth.uid(),
      decided_at = NOW()
    WHERE id = p_booking_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.decide_study_booking(uuid, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- cancel_study_booking (requester, teacher, or admin)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_study_booking(p_booking_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_booking public.study_bookings;
BEGIN
  SELECT *
  INTO v_booking
  FROM public.study_bookings
  WHERE id = p_booking_id;

  IF v_booking.id IS NULL THEN
    RAISE EXCEPTION 'solicitud no encontrada';
  END IF;

  IF v_booking.status IN ('rejected'::public.study_status, 'cancelled'::public.study_status) THEN
    RAISE EXCEPTION 'la solicitud ya fue resuelta';
  END IF;

  IF v_booking.requester_id <> auth.uid()
    AND NOT public.is_admin()
    AND NOT EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE id = auth.uid()
        AND role = 'teacher'::public.role
    )
  THEN
    RAISE EXCEPTION 'no autorizado para cancelar esta solicitud';
  END IF;

  UPDATE public.study_bookings
  SET status = 'cancelled'::public.study_status
  WHERE id = p_booking_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_study_booking(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Writes to study_bookings go only through SECURITY DEFINER RPCs (no INSERT/UPDATE/
-- DELETE policies on study_bookings), same pattern as draft_sessions / reservations.
-- ---------------------------------------------------------------------------
ALTER TABLE public.study_spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_bookings ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.study_spaces TO authenticated;
GRANT SELECT ON TABLE public.study_bookings TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.study_spaces TO authenticated;

DROP POLICY IF EXISTS "Authenticated can select study_spaces" ON public.study_spaces;
CREATE POLICY "Authenticated can select study_spaces"
  ON public.study_spaces
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Admins can insert study_spaces" ON public.study_spaces;
CREATE POLICY "Admins can insert study_spaces"
  ON public.study_spaces
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins can update study_spaces" ON public.study_spaces;
CREATE POLICY "Admins can update study_spaces"
  ON public.study_spaces
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins can delete study_spaces" ON public.study_spaces;
CREATE POLICY "Admins can delete study_spaces"
  ON public.study_spaces
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "Authenticated can select study_bookings" ON public.study_bookings;
CREATE POLICY "Authenticated can select study_bookings"
  ON public.study_bookings
  FOR SELECT
  TO authenticated
  USING (true);

-- No INSERT/UPDATE/DELETE policies on study_bookings — request/decide/cancel RPCs only.

-- ---------------------------------------------------------------------------
-- Realtime publication
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.study_spaces;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.study_bookings;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Dashboard step: Database → Replication → enable Realtime for study_spaces and
-- study_bookings (publication alone may not be enough in all projects).

-- ---------------------------------------------------------------------------
-- Verification (manual — run in SQL Editor)
-- ---------------------------------------------------------------------------
-- Replace UUIDs and dates as needed. Run as admin to create space; as student/teacher
-- to request; as teacher/admin to decide.
--
-- (1) Create a study space linked to teaching space 1 (Lumen):
--
-- INSERT INTO public.study_spaces (name, space_id, created_by)
-- VALUES (
--   'Sala estudio Lumen',
--   1,
--   auth.uid()
-- );
--
-- (2) Request a booking (as student or teacher):
--
-- SELECT public.request_study_booking(
--   (SELECT id FROM public.study_spaces WHERE name = 'Sala estudio Lumen'),
--   CURRENT_DATE + 1,
--   '10:00'::time,
--   60
-- );
--
-- (3) Overlapping request should fail:
--
-- SELECT public.request_study_booking(
--   (SELECT id FROM public.study_spaces WHERE name = 'Sala estudio Lumen'),
--   CURRENT_DATE + 1,
--   '10:30'::time,
--   60
-- );
--   → ERROR: espacio no disponible en ese horario
--
-- (4) Student daily cap (as student — third 60-min booking same day should fail):
--
-- SELECT public.request_study_booking(..., CURRENT_DATE + 2, '08:00'::time, 60);
-- SELECT public.request_study_booking(..., CURRENT_DATE + 2, '09:00'::time, 60);
-- SELECT public.request_study_booking(..., CURRENT_DATE + 2, '10:00'::time, 60);
--   → ERROR: límite diario de 2 horas
--
-- (5) Approve a pending booking (as teacher or admin):
--
-- SELECT public.decide_study_booking(
--   '<booking-id>'::uuid,
--   true
-- );
