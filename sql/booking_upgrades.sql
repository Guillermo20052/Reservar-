-- Booking upgrades: auto-approve Nidus, seed all teaching rooms, per-user
-- space restriction, and the RLS pin that makes the restriction real
-- ---------------------------------------------------------------------------
-- FOUR CHANGES IN ONE FILE (single transaction):
--
-- (1) AUTO-APPROVE: study_spaces.requires_approval boolean NOT NULL DEFAULT
--     true; set false where name ILIKE 'nidus%'. request_study_booking inserts
--     directly as 'approved' for such spaces — every other check (role gate,
--     duration whitelist, active check, 2h student cap, study_space_busy
--     overlap/teaching-conflict) runs exactly as before, in the same order.
--     Because the row is never 'pending', it never appears in the admin queue
--     (which filters status = 'pending') — no UI change needed for that.
--
-- (2) SEED ALL TEACHING ROOMS: one study_spaces row per public.spaces row that
--     has no linked study space yet — name = room name, space_id = the room,
--     requires_approval = true, active = FALSE. Inactive spaces are invisible
--     to students (both the UI query and request_study_booking check active),
--     so nothing changes for students until the admin activates each room.
--
--     CONFLICT CHECK FOR THESE ROOMS — where it fires: request_study_booking
--     and decide_study_booking both call public.study_space_busy()
--     (sql/study_spaces_schema.sql). Its branch (a) runs whenever the study
--     space has space_id set and the date is Mon–Fri, and rejects any interval
--     overlapping a CONFIRMED teaching reservation for that room
--     (reservations.space_id = link, r.day = weekday, r.confirmed = true,
--     interval overlap against timetable_slots.end_time). Every seeded row has
--     space_id set, so branch (a) fires for all of them with no changes. Note
--     its known scope: it checks confirmed reservations for the matching
--     WEEKDAY regardless of reservations.week_start — conservative (a room
--     "busy on Monday 10:00" blocks every Monday), which is the safe direction.
--
-- (3) LUMEN-ONLY USER: profiles.only_space_id smallint NULL REFERENCES
--     public.spaces(id). When set, request_study_booking rejects (in the RPC,
--     server-side) any booking for a study space not linked to that room.
--     Admins write it via the new SECURITY DEFINER RPC
--     admin_set_user_space(p_user_id, p_space_id) which verifies is_admin().
--     The profiles UPDATE policy is NOT widened.
--
-- (4) POLICY PIN (required for 3 to hold): "Users can update own profile"
--     (sql/teacher_profile_schema.sql) already pins role and teacher_code but
--     would let a user UPDATE her own row and CLEAR only_space_id, escaping
--     the restriction. The policy is re-created — same name, same USING, same
--     existing pins — with only_space_id added to the pinned columns. This
--     NARROWS what owners can write; it widens nothing.
--
-- SIGNATURES: request_study_booking(uuid, date, time, int) is unchanged and
-- replaced in place. admin_set_user_space(uuid, smallint) is new. The DO block
-- before COMMIT aborts if either name has more than one overload.
--
-- Idempotent: safe to re-run. Run MANUALLY in the Supabase SQL Editor
-- (Dashboard -> SQL -> New query). DO NOT run automatically.
--
-- Prerequisites: sql/schema.sql, sql/reservations_schema.sql,
-- sql/teacher_profile_schema.sql, sql/study_spaces_schema.sql.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- (1a) requires_approval + Nidus backfill
-- ---------------------------------------------------------------------------
ALTER TABLE public.study_spaces
  ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE public.study_spaces
SET requires_approval = FALSE
WHERE name ILIKE 'nidus%'
  AND requires_approval = TRUE;

-- ---------------------------------------------------------------------------
-- (2a) Seed a (dormant) study space for every unlinked teaching room.
-- ON CONFLICT (name) DO NOTHING: study_spaces.name is UNIQUE, and an existing
-- unlinked study space may already carry a room's name — never clobber it.
-- active = FALSE is the rollout switch: the admin activates rooms when ready.
-- ---------------------------------------------------------------------------
INSERT INTO public.study_spaces (name, space_id, requires_approval, active)
SELECT s.name, s.id, TRUE, FALSE
FROM public.spaces s
WHERE NOT EXISTS (
  SELECT 1 FROM public.study_spaces ss WHERE ss.space_id = s.id
)
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- (3a) profiles.only_space_id
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS only_space_id SMALLINT REFERENCES public.spaces (id);

-- ---------------------------------------------------------------------------
-- (1b + 3b) request_study_booking — same signature, replaced in place.
-- Additions relative to sql/study_spaces_schema.sql, in body order:
--   * the study-space SELECT also reads requires_approval and space_id;
--   * only_space_id gate right after the active check (before the cap and the
--     busy check, so a restricted user gets the clearest error first);
--   * INSERT status is 'approved' when the space skips approval.
-- Everything else — role gate, duration whitelist, active check, student 2h
-- cap, study_space_busy — is byte-identical and in the original order.
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

  SELECT ss.active, ss.requires_approval, ss.space_id
  INTO v_active, v_requires_approval, v_space_link
  FROM public.study_spaces ss
  WHERE ss.id = p_study_space_id;

  IF NOT FOUND OR NOT v_active THEN
    RAISE EXCEPTION 'espacio de estudio no disponible';
  END IF;

  -- Per-user room restriction (server-side; the dropdown filter in the UI is
  -- cosmetic). A restricted account may only book study spaces LINKED to its
  -- assigned room; unlinked spaces are rejected too (v_space_link NULL never
  -- equals v_only_space).
  SELECT p.only_space_id
  INTO v_only_space
  FROM public.profiles p
  WHERE p.id = auth.uid();

  IF v_only_space IS NOT NULL
     AND (v_space_link IS NULL OR v_space_link <> v_only_space) THEN
    SELECT s.name INTO v_only_name FROM public.spaces s WHERE s.id = v_only_space;
    RAISE EXCEPTION 'tu cuenta solo puede reservar el espacio %',
      COALESCE(v_only_name, 'asignado');
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

  -- Auto-approve spaces (requires_approval = false) go straight to 'approved':
  -- the request IS the reservation, no admin decision involved. decided_by /
  -- decided_at stay NULL — nobody decided; the system did.
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
-- (3c) admin_set_user_space — the ONLY write path for only_space_id.
-- SECURITY DEFINER + explicit is_admin() check; the profiles UPDATE RLS is not
-- touched (and (4) below pins the column against owner self-updates).
-- p_space_id NULL clears the restriction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_user_space(
  p_user_id uuid,
  p_space_id smallint DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'solo administradoras pueden restringir espacios';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'usuario no encontrado';
  END IF;

  IF p_space_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.spaces WHERE id = p_space_id) THEN
    RAISE EXCEPTION 'espacio no encontrado';
  END IF;

  UPDATE public.profiles
  SET only_space_id = p_space_id
  WHERE id = p_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_set_user_space(uuid, smallint) TO authenticated;

-- ---------------------------------------------------------------------------
-- (4) Pin only_space_id in the owner-update policy. Identical to the policy in
-- sql/teacher_profile_schema.sql plus ONE new pinned column — an owner update
-- that changes only_space_id now fails WITH CHECK. Admins are unaffected: they
-- write through admin_set_user_space (definer bypasses RLS).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;

CREATE POLICY "Users can update own profile"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    AND role = (SELECT p.role FROM public.profiles AS p WHERE p.id = auth.uid())
    AND teacher_code IS NOT DISTINCT FROM (
      SELECT p.teacher_code FROM public.profiles AS p WHERE p.id = auth.uid()
    )
    AND only_space_id IS NOT DISTINCT FROM (
      SELECT p.only_space_id FROM public.profiles AS p WHERE p.id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Overload guard
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_req int;
  v_set int;
BEGIN
  SELECT count(*) INTO v_req
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'request_study_booking';

  SELECT count(*) INTO v_set
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'admin_set_user_space';

  IF v_req <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 request_study_booking overload, found %', v_req;
  END IF;

  IF v_set <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 admin_set_user_space overload, found %', v_set;
  END IF;
END;
$$;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification (manual — run in SQL Editor, AFTER the COMMIT above)
-- ---------------------------------------------------------------------------
-- (1) Nidus auto-approves, everything else still defaults to approval:
-- SELECT name, requires_approval, active FROM public.study_spaces ORDER BY name;
--
-- (2) Seeded rooms exist, inactive, linked:
-- SELECT ss.name, ss.space_id, ss.active
-- FROM public.study_spaces ss JOIN public.spaces s ON s.id = ss.space_id
-- ORDER BY ss.name;
--
-- (3) As a student, book a Nidus slot → row lands directly as 'approved':
-- SELECT public.request_study_booking(
--   (SELECT id FROM public.study_spaces WHERE name ILIKE 'nidus%' LIMIT 1),
--   CURRENT_DATE + 1, '10:00'::time, 60);
-- SELECT status FROM public.study_bookings ORDER BY created_at DESC LIMIT 1;
--
-- (4) Restrict a user to a room, then have them book elsewhere → clear error:
-- SELECT public.admin_set_user_space('<user-uuid>', (SELECT id FROM public.spaces WHERE name = 'Lumen'));
-- -- as that user, booking a non-Lumen study space →
-- --   ERROR: tu cuenta solo puede reservar el espacio Lumen
--
-- (5) The pinned policy holds — as a restricted user:
-- UPDATE public.profiles SET only_space_id = NULL WHERE id = auth.uid();
-- --   → 0 rows / policy violation; the restriction cannot be self-cleared.
