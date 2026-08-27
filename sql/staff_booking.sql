-- Staff (teacher + admin) book instantly, any space, no policy limits
-- ---------------------------------------------------------------------------
-- NEW MODEL, by role:
--
--   STUDENTS — completely unchanged. Active spaces only, 2h daily cap,
--   only_space_id restriction, and approval driven by the space's
--   requires_approval flag (auto-approve for Nidus, pending elsewhere).
--
--   TEACHERS and ADMINS — "staff":
--     (a) may book ANY study space, including active = false ones. Inactive
--         spaces are the rooms hidden from alumnas, which is exactly how staff
--         reserve a room "fuera de horario" that is not open for student
--         booking.
--     (b) skip the 2h daily cap and the only_space_id restriction — both are
--         student policy, not physical constraints.
--     (c) their booking is inserted directly as 'approved'. Staff do not queue
--         for their own approval, so requires_approval is not consulted for
--         them and the admin pending list never sees these rows.
--
-- ALSO: admins were previously rejected outright by the role gate
--   role IN ('student', 'teacher')
-- so they had no booking path at all. The gate now admits 'admin'. Since
-- public.role has exactly three values, the gate's exception is now reachable
-- only when the caller has no profiles row; its message is left unchanged.
--
-- KEPT FOR EVERY ROLE, deliberately — these two protect physical reality
-- rather than policy, so staff are NOT exempt:
--   * the overlap check (no two bookings in the same room at the same time)
--   * the linked-room class-conflict check (no booking over a confirmed class)
-- Both live in public.study_space_busy() (sql/study_spaces_schema.sql) and are
-- still called on the same line, for all roles, with the same arguments.
--
-- "Read the role once": the function now does a single
--   SELECT role, only_space_id INTO ... FROM profiles WHERE id = auth.uid()
-- at the top and reuses it. This replaces BOTH of the previous per-check
-- EXISTS(SELECT 1 FROM profiles ...) subqueries (the role gate and the
-- student-cap test) and the separate only_space_id lookup — three reads of
-- profiles become one.
--
-- SIGNATURE: request_study_booking(uuid, date, time, int) is UNCHANGED, so it
-- is replaced in place with CREATE OR REPLACE and no DROP is required. The
-- DO block before COMMIT aborts the transaction if more than one overload
-- somehow exists.
--
-- Idempotent: safe to re-run. Run MANUALLY in the Supabase SQL Editor
-- (Dashboard -> SQL -> New query). DO NOT run automatically.
--
-- Prerequisites (in order): sql/schema.sql, sql/reservations_schema.sql,
-- sql/teacher_profile_schema.sql, sql/study_spaces_schema.sql,
-- sql/booking_upgrades.sql (requires_approval + only_space_id must exist),
-- >>> then this file <<<
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- request_study_booking — role-aware. Student path is byte-for-byte the
-- behaviour from sql/booking_upgrades.sql; staff take the relaxed path.
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
  v_requires_approval boolean;
  v_space_link smallint;
  v_only_space smallint;
  v_only_name text;
  v_role public.role;
  v_is_staff boolean;
BEGIN
  -- Single read of the caller's profile: role gate, the student-cap test and
  -- the room restriction all derive from these two values.
  SELECT p.role, p.only_space_id
  INTO v_role, v_only_space
  FROM public.profiles p
  WHERE p.id = auth.uid();

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'solo estudiantes y docentes pueden solicitar espacio de estudio';
  END IF;

  v_is_staff := v_role IN ('teacher'::public.role, 'admin'::public.role);

  IF p_duration_min IS NULL OR p_duration_min NOT IN (30, 60, 120) THEN
    RAISE EXCEPTION 'duración inválida';
  END IF;

  SELECT ss.active, ss.requires_approval, ss.space_id
  INTO v_active, v_requires_approval, v_space_link
  FROM public.study_spaces ss
  WHERE ss.id = p_study_space_id;

  -- (a) A nonexistent space is always rejected. An INACTIVE space is rejected
  -- for students only — staff book hidden rooms on purpose.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'espacio de estudio no disponible';
  END IF;

  IF NOT v_active AND NOT v_is_staff THEN
    RAISE EXCEPTION 'espacio de estudio no disponible';
  END IF;

  -- (b) Per-user room restriction — student policy, so staff are exempt.
  -- Server-side; the dropdown filter in the UI is cosmetic.
  IF NOT v_is_staff
     AND v_only_space IS NOT NULL
     AND (v_space_link IS NULL OR v_space_link <> v_only_space) THEN
    SELECT s.name INTO v_only_name FROM public.spaces s WHERE s.id = v_only_space;
    RAISE EXCEPTION 'tu cuenta solo puede reservar el espacio %',
      COALESCE(v_only_name, 'asignado');
  END IF;

  -- (b) 2h daily cap — students only, exactly as before.
  IF v_role = 'student'::public.role THEN
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

  -- KEPT FOR ALL ROLES: overlap with another booking in the same physical room,
  -- and overlap with a confirmed class in the linked teaching room. Staff get
  -- no exemption here — two people cannot occupy one room at one time.
  IF public.study_space_busy(p_study_space_id, p_date, p_start, p_duration_min, NULL) THEN
    RAISE EXCEPTION 'espacio no disponible en ese horario';
  END IF;

  -- (c) Staff bookings are approved on insert. For students the space's
  -- requires_approval flag decides, unchanged. decided_by / decided_at stay
  -- NULL in both auto paths — nobody decided; the system did.
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
    CASE
      WHEN v_is_staff THEN 'approved'::public.study_status
      WHEN v_requires_approval THEN 'pending'::public.study_status
      ELSE 'approved'::public.study_status
    END
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_study_booking(uuid, date, time, int) TO authenticated;

-- ---------------------------------------------------------------------------
-- Overload guard — the signature did not change, so exactly one must remain.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_req int;
BEGIN
  SELECT count(*) INTO v_req
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'request_study_booking';

  IF v_req <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 request_study_booking overload, found %', v_req;
  END IF;
END;
$$;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification (manual — run in SQL Editor, AFTER the COMMIT above)
-- ---------------------------------------------------------------------------
-- (1) Exactly one signature:
-- SELECT p.proname, pg_get_function_identity_arguments(p.oid)
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public' AND p.proname = 'request_study_booking';
-- Expected: request_study_booking | p_study_space_id uuid, p_date date,
--                                   p_start time without time zone,
--                                   p_duration_min integer
--
-- (2) As a TEACHER or ADMIN — an inactive space books instantly:
-- SELECT public.request_study_booking(
--   (SELECT id FROM public.study_spaces WHERE active = false LIMIT 1),
--   CURRENT_DATE + 1, '16:00'::time, 120);
-- SELECT status FROM public.study_bookings ORDER BY created_at DESC LIMIT 1;
--   → approved
--
-- (3) As a STUDENT — that same inactive space is still refused:
--   → ERROR: espacio de estudio no disponible
--
-- (4) Staff skip the cap: four 120-min bookings on one day all succeed
-- (different rooms/times). A student's third hour still raises
--   → ERROR: límite diario de 2 horas
--
-- (5) Physical checks still bite for staff — book the same room/time twice:
--   → ERROR: espacio no disponible en ese horario
-- and over a confirmed class in the linked room:
--   → ERROR: espacio no disponible en ese horario
