-- Admin delete user RPC
-- Re-runnable: safe to execute multiple times during development (CREATE OR REPLACE).
-- Prerequisites: sql/schema.sql, sql/reservations_schema.sql,
-- sql/teacher_profile_schema.sql, sql/draft_schema.sql, sql/study_spaces_schema.sql.
--
-- MUST BE RUN MANUALLY in the Supabase SQL Editor (Dashboard → SQL → New query)
-- BEFORE the "Eliminar" button in the admin Usuarios panel works. Until this file
-- is applied, the button's RPC call fails with "function does not exist".
--
-- ---------------------------------------------------------------------------
-- auth.users decision
-- ---------------------------------------------------------------------------
-- sql/schema.sql defines:
--   profiles.id UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE
-- The cascade direction is auth.users → profiles: deleting the auth.users row
-- removes the profile, but deleting the profile does NOT remove the auth user.
--
-- CHOICE: this function deletes FROM auth.users directly (after the dependent
-- cleanup below). Rationale:
--   * The function is created in the Supabase SQL Editor, so it is owned by the
--     `postgres` role. As SECURITY DEFINER it runs with that role at RPC time,
--     and `postgres` in Supabase can delete rows in auth.users (same privilege
--     the SQL Editor itself uses for the documented manual cleanup pattern).
--   * Leaving an orphaned auth.users row would be worse than the small risk:
--     the person could still sign in, but with no profiles row the app breaks
--     for them, and the admin would get no signal that cleanup is pending.
--   * The whole function runs in one transaction: if the auth.users delete is
--     ever refused (e.g. Supabase tightens auth-schema privileges in a future
--     release), the ENTIRE operation rolls back — no half-deleted user — and
--     the admin sees the error in the UI. Fallback in that case: delete the
--     user in Dashboard → Authentication → Users, which cascades to profiles;
--     the dependent cleanup below would then need to be run by hand first for
--     the NO ACTION FKs (reservations, study_bookings, draft_turns, ...).
-- The explicit profiles delete before the auth delete is technically redundant
-- (the cascade would remove it) but is kept as a defensive step: it is a no-op
-- when the cascade fires and keeps the function correct even if the FK were
-- ever recreated without ON DELETE CASCADE.
--
-- ---------------------------------------------------------------------------
-- FK inventory for public.profiles (why the manual deletes below are needed)
-- ---------------------------------------------------------------------------
-- NO ACTION (would block the profiles/auth delete — must be handled manually):
--   * reservations.teacher_id           (reservations_schema.sql:144) → DELETE
--   * study_bookings.requester_id       (study_spaces_schema.sql:39)  → DELETE
--   * study_bookings.decided_by         (study_spaces_schema.sql:44)  → SET NULL
--       (these are OTHER people's bookings this user merely approved/rejected;
--        deleting them would destroy someone else's data, so only unlink)
--   * study_spaces.created_by           (study_spaces_schema.sql:26)  → SET NULL
--       (nullable; keep the space, drop authorship)
--   * classes.created_by                (reservations_schema.sql:49)  → SET NULL
--       (nullable; keep the class, drop authorship)
--   * timetable_slots.teacher_id        (reservations_schema.sql:86)  → SET NULL
--       (legacy single-teacher column, nullable; keep the slot)
--   * draft_turns.teacher_id            (draft_schema.sql:44)         → DELETE
--       (their turn rows; removing mid-draft leaves a position gap, which the
--        draft advance logic tolerates — it walks pending turns by ORDER BY
--        position, not by consecutive numbering)
--
-- ON DELETE CASCADE (no manual delete needed — removed automatically when the
-- profiles row goes away):
--   * teacher_classes.teacher_id                (reservations_schema.sql:130)
--   * timetable_slot_teachers.teacher_id        (reservations_schema.sql:99)
--   * timetable_slot_part_teachers.teacher_id   (reservations_schema.sql:119)
--
-- Deletion order chosen: leaf/dependent rows first (no table below references
-- another one in the list through the deleted user), then profiles, then
-- auth.users. reservations are deleted before draft_turns only for readability;
-- there is no FK between them through this user.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_delete_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Caller must be an admin.
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'::public.role
  ) THEN
    RAISE EXCEPTION 'solo administradoras pueden eliminar cuentas';
  END IF;

  -- Never delete yourself.
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'no puedes eliminar tu propia cuenta';
  END IF;

  -- Target must exist.
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = p_user_id
  ) THEN
    RAISE EXCEPTION 'usuario no encontrado';
  END IF;

  -- Never delete another admin (demote first via set_user_role if intended).
  IF EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = p_user_id
      AND role = 'admin'::public.role
  ) THEN
    RAISE EXCEPTION 'no se puede eliminar a otra administradora';
  END IF;

  -- 1) Their teaching reservations (FK reservations.teacher_id is NO ACTION).
  DELETE FROM public.reservations
  WHERE teacher_id = p_user_id;

  -- 2) Their study-space requests (FK study_bookings.requester_id is NO ACTION).
  DELETE FROM public.study_bookings
  WHERE requester_id = p_user_id;

  -- 3) Bookings of OTHER users that this user decided: unlink, do not delete
  --    (FK study_bookings.decided_by is NO ACTION; column is nullable).
  UPDATE public.study_bookings
  SET decided_by = NULL
  WHERE decided_by = p_user_id;

  -- 4) Study spaces they created: keep the space, drop authorship
  --    (FK study_spaces.created_by is NO ACTION; column is nullable).
  UPDATE public.study_spaces
  SET created_by = NULL
  WHERE created_by = p_user_id;

  -- 5) Classes they created: keep the class, drop authorship
  --    (FK classes.created_by is NO ACTION; column is nullable).
  UPDATE public.classes
  SET created_by = NULL
  WHERE created_by = p_user_id;

  -- 6) Legacy single-teacher slot ownership: keep the slot
  --    (FK timetable_slots.teacher_id is NO ACTION; column is nullable and
  --     normally NULL everywhere after fix_legacy_teacher_ownership.sql).
  UPDATE public.timetable_slots
  SET teacher_id = NULL
  WHERE teacher_id = p_user_id;

  -- 7) Their draft turns (FK draft_turns.teacher_id is NO ACTION).
  DELETE FROM public.draft_turns
  WHERE teacher_id = p_user_id;

  -- teacher_classes, timetable_slot_teachers and timetable_slot_part_teachers
  -- all reference profiles ON DELETE CASCADE — handled by the next statement.

  -- 8) The profile itself (defensive; the auth.users delete below would also
  --    remove it via ON DELETE CASCADE).
  DELETE FROM public.profiles
  WHERE id = p_user_id;

  -- 9) The auth account, so the person is fully signed out/removed and can
  --    sign up again with the same email. See "auth.users decision" above.
  DELETE FROM auth.users
  WHERE id = p_user_id;
END;
$$;

-- Callable by any signed-in user; the admin check is enforced inside.
REVOKE ALL ON FUNCTION public.admin_delete_user(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid) TO authenticated;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification (manual — run in SQL Editor)
-- ---------------------------------------------------------------------------
-- As an admin session (or via the app's Usuarios panel):
--
-- SELECT public.admin_delete_user('<target-profiles-id>'::uuid);
--
-- Then check both rows are gone:
--
-- SELECT * FROM public.profiles WHERE id = '<target-profiles-id>'::uuid;
-- SELECT * FROM auth.users     WHERE id = '<target-profiles-id>'::uuid;
--
-- Expected failures:
--   SELECT public.admin_delete_user(auth.uid());          → no puedes eliminar tu propia cuenta
--   SELECT public.admin_delete_user('<other-admin-id>');  → no se puede eliminar a otra administradora
