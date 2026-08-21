-- Draft race fix: serialize turn advancement, and stop confirm_turn lying
-- ---------------------------------------------------------------------------
-- SYMPTOMS REPORTED DURING A LIVE DRAFT:
--   * "me saltó el turno" (x3) — a teacher's turn ended the instant it began.
--   * "no se están guardando" — confirm reported success but the picks were gone.
--
-- CAUSE 1 — unserialized double advance.
-- Every teacher client runs its own countdown and fires advance_turn() at
-- expiry (js/teacher-reservar.js tryAdvanceOnExpiry), so N teachers fire N
-- concurrent calls within the same second. public.advance_turn() checks
-- "has turn_ends_at passed?" and then delegates to _advance_draft_turn(), which
-- took NO lock and re-checked NOTHING. Two callers both passed the deadline
-- check against the SAME pre-advance snapshot, so both ran the body:
--   caller A: turn 4 -> done, turn 5 -> active, turn_ends_at = now + 3 min
--   caller B: (already past its gate) turn 5 -> done/skipped, turn 6 -> active
-- Teacher 5 was skipped with zero seconds on the clock. Three reports = this
-- happened at three separate turn boundaries.
--
-- FIX 1: take pg_advisory_xact_lock(hashtext(session_id)) as the very first
-- statement, then RE-READ the session and RE-VERIFY the deadline INSIDE the
-- lock. Caller B now blocks until A commits, re-reads turn_ends_at = now+3min,
-- sees the deadline has NOT passed, and returns without doing anything. The
-- double advance becomes a NO-OP instead of a skipped turn.
--
-- CAUSE 2 — confirm_turn reporting success on zero rows.
-- confirm_turn ended with an unchecked
--   UPDATE public.reservations SET confirmed = true WHERE teacher_id = ... ;
-- If a concurrent advance had already moved past this teacher (and, in the
-- pre-fix skip case, her picks were gone), the UPDATE matched 0 rows, the
-- function returned void, and the client showed "¡Listo! Tus clases han sido
-- registradas correctamente."
--
-- FIX 2: GET DIAGNOSTICS ... ROW_COUNT after the UPDATE; 0 rows now raises a
-- clear Spanish error instead of a silent success.
--
-- NOTE on the surviving 0-row case: the UPDATE deliberately has NO
-- "AND confirmed = false" filter (unchanged from the current body), so a
-- teacher whose picks were already AUTO-CONFIRMED on expiry still matches her
-- rows and still succeeds. Only a teacher with genuinely no rows in the session
-- gets the new error. Auto-confirm-on-expiry behaviour is untouched.
--
-- SIGNATURES: both functions are re-created with their EXACT current
-- signatures — _advance_draft_turn(uuid) and confirm_turn(text) — so
-- CREATE OR REPLACE replaces in place and NO new overload can appear. Nothing
-- is dropped because nothing changes shape; the guard block at the end of this
-- file fails the transaction if more than one overload of either name somehow
-- exists.
--
-- NOT CHANGED, deliberately: the is_admin gate and the deadline gate in
-- public.advance_turn(uuid); the teacher role gate, the teacher_code check and
-- the "not your turn" check in confirm_turn; every phase transition; the
-- week_start scoping introduced by sql/draft_weeks.sql (both functions are
-- session-scoped, and a session belongs to exactly one week); auto-confirm on
-- expiry; all RLS policies; all Realtime publication membership.
--
-- Idempotent: safe to re-run. Run MANUALLY in the Supabase SQL Editor
-- (Dashboard -> SQL -> New query). DO NOT run automatically.
--
-- Prerequisites (in order): sql/draft_schema.sql, sql/draft_open_mode.sql,
-- sql/draft_autoconfirm.sql, sql/fix_legacy_teacher_ownership.sql,
-- sql/draft_weeks.sql, >>> then this file <<<
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- (1) _advance_draft_turn — lock, then re-verify the deadline inside the lock.
--
-- Body is byte-identical to sql/draft_autoconfirm.sql from the
-- "SELECT * INTO v_active" statement onward. The ONLY additions are the
-- v_session declaration and the three guard statements at the top.
-- ---------------------------------------------------------------------------
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
  v_session public.draft_sessions;
BEGIN
  -- Serialize every advance for this session. Transaction-scoped, so it is
  -- released on COMMIT/ROLLBACK with no explicit unlock and no leak on error.
  PERFORM pg_advisory_xact_lock(hashtext(p_session_id::text));

  -- Re-read AFTER acquiring the lock: a concurrent caller that was ahead of us
  -- has now committed, so this sees the post-advance state, not the stale
  -- snapshot our caller's deadline check was based on.
  SELECT *
  INTO v_session
  FROM public.draft_sessions
  WHERE id = p_session_id;

  IF v_session.id IS NULL THEN
    RETURN;
  END IF;

  -- Same predicate as the gate in public.advance_turn(), re-evaluated on fresh
  -- data. If the deadline has not passed, someone else already advanced this
  -- session (they set turn_ends_at = NOW() + 3 min) and we must do nothing.
  -- An admin's manual skip still bypasses the deadline, exactly as before.
  IF NOT public.is_admin()
     AND (v_session.turn_ends_at IS NULL OR NOW() < v_session.turn_ends_at) THEN
    RETURN;
  END IF;

  SELECT *
  INTO v_active
  FROM public.draft_turns
  WHERE session_id = p_session_id
    AND status = 'active'::public.turn_status
  LIMIT 1;

  IF v_active.id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.reservations
  SET confirmed = true
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

-- No GRANT: _advance_draft_turn is a private helper, invoked only through
-- public.advance_turn(uuid), which keeps its own grant. Unchanged from the
-- original schema, which deliberately grants clients no EXECUTE on it.

-- ---------------------------------------------------------------------------
-- (2) confirm_turn — fail loudly when nothing was confirmed.
--
-- Body is byte-identical to sql/draft_schema.sql except for the v_rows
-- declaration and the GET DIAGNOSTICS / IF block after the UPDATE.
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
  v_rows integer;
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

  -- Nothing to confirm means the picks are gone (a concurrent advance moved
  -- past this teacher, or an admin reset the week). Reporting success here is
  -- what produced "no se están guardando": the client showed the success modal
  -- over an empty result set.
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RAISE EXCEPTION 'no se pudo confirmar: tus reservas ya no están disponibles';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_turn(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- (3) Overload guard — abort the migration if either name ended up with more
-- than one signature. Both functions were replaced in place, so the expected
-- count is exactly 1 each and nothing needed dropping; this block turns that
-- expectation into an enforced invariant instead of an assumption.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_advance int;
  v_confirm int;
BEGIN
  SELECT count(*) INTO v_advance
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = '_advance_draft_turn';

  SELECT count(*) INTO v_confirm
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'confirm_turn';

  IF v_advance <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 _advance_draft_turn overload, found %', v_advance;
  END IF;

  IF v_confirm <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 confirm_turn overload, found %', v_confirm;
  END IF;
END;
$$;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification (manual — run in SQL Editor as admin, AFTER the COMMIT above)
-- ---------------------------------------------------------------------------
-- (1) Exactly one signature each:
-- SELECT p.proname, pg_get_function_identity_arguments(p.oid)
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND p.proname IN ('_advance_draft_turn', 'confirm_turn', 'advance_turn');
-- Expected exactly:
--   _advance_draft_turn | p_session_id uuid
--   advance_turn        | p_session_id uuid
--   confirm_turn        | p_code text
--
-- (2) The lock and the re-verify are present:
-- SELECT pg_get_functiondef('public._advance_draft_turn(uuid)'::regprocedure)
--        LIKE '%pg_advisory_xact_lock%' AS has_lock;
--
-- (3) Concurrency check — two psql sessions against the SAME live draft.
-- Session A:  BEGIN; SELECT public.advance_turn(); -- do NOT commit yet
-- Session B:  SELECT public.advance_turn();        -- blocks on the advisory lock
-- Session A:  COMMIT;
-- Session B then unblocks, re-reads turn_ends_at = now + 3 min, and returns
-- without advancing. Before this fix, B advanced a second time and the teacher
-- who had just become active was skipped.
-- Confirm only ONE turn moved:
-- SELECT position, status FROM public.draft_turns
-- WHERE session_id = (SELECT id FROM public.current_session()) ORDER BY position;
