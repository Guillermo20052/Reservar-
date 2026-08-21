-- Confirming a turn ends it immediately
-- ---------------------------------------------------------------------------
-- PROBLEM: confirm_turn locked a teacher's picks but left her turn 'active'.
-- The queue only moved when the 3-minute timer expired, so a 15-teacher draft
-- took ~45 minutes of dead waiting even when everyone confirmed in 20 seconds.
--
-- NEW BEHAVIOUR: a successful confirm_turn ends that teacher's turn on the spot
-- and starts the next teacher's. A draft now runs at the speed the teachers
-- actually pick.
--
-- HOW: reuse the existing public._advance_draft_turn() rather than duplicating
-- the advance logic — it already marks the current turn done/skipped, activates
-- the next turn, resets turn_ends_at, and flips the session to 'open' after the
-- last turn. The only obstacle is the deadline re-check added by
-- sql/draft_race_fix.sql, which would make a confirm-triggered advance return
-- early because the timer has NOT expired. So _advance_draft_turn gains
-- p_force boolean DEFAULT false, which skips THAT ONE CHECK and nothing else.
--
-- WHAT IS NOT WEAKENED:
--   * The advisory lock is still taken first, on every path including forced.
--   * The timer-expiry path (advance_turn -> p_force => false) still runs the
--     full deadline re-check, so the double-advance / skipped-turn protection
--     from sql/draft_race_fix.sql is completely intact.
--   * advance_turn's own non-admin gate ("turn has not ended yet") is untouched.
--   * Auto-confirm-on-expiry, week_start scoping, every role gate, the código
--     check, the active-turn check and the 0-rows exception are all preserved.
--
-- ONE ADDITION TO confirm_turn BEYOND THE ADVANCE, and why it is required:
-- confirm_turn now takes the SAME advisory lock before it checks whose turn it
-- is. Without it, this sequence would reintroduce the skipped-turn bug we just
-- fixed:
--   1. teacher A's timer expires; another client's advance_turn moves to B;
--   2. teacher A's confirm_turn had already read the pre-advance snapshot and
--      believes she is still active;
--   3. A's forced advance fires and pushes past B — B skipped with 0 seconds.
-- Taking the lock before the active-turn check makes steps 2-3 impossible: A
-- either sees the post-advance state and gets 'not your turn', or holds the
-- lock and the timer-expiry caller waits, then re-reads turn_ends_at (now +3
-- min, set by A's forced advance) and returns early. pg_advisory_xact_lock is
-- re-entrant within a transaction, so acquiring it here and again inside
-- _advance_draft_turn is safe, and both functions take it in the same order, so
-- no deadlock is possible.
--
-- TURN MARKED 'done', NOT 'skipped': _advance_draft_turn already decides via
--   CASE WHEN EXISTS(confirmed rows for that teacher in that session)
--        THEN 'done' ELSE 'skipped' END
-- and confirm_turn only reaches the advance after its UPDATE confirmed at least
-- one row (otherwise the 0-rows exception fires and the whole transaction rolls
-- back). So the confirming teacher is always recorded as 'done'. No change to
-- that CASE was needed, and none was made.
--
-- SIGNATURES:
--   * _advance_draft_turn(uuid) -> _advance_draft_turn(uuid, boolean). The OLD
--     one-argument signature is DROPPED explicitly; its only caller,
--     public.advance_turn(uuid), is re-created in this same file passing
--     p_force => false explicitly rather than relying on the default.
--   * advance_turn(uuid) and confirm_turn(text) keep their exact signatures and
--     are replaced in place.
-- The DO block before COMMIT fails the transaction if any of the three names
-- ends up with more than one overload.
--
-- Idempotent: safe to re-run. Run MANUALLY in the Supabase SQL Editor
-- (Dashboard -> SQL -> New query). DO NOT run automatically.
--
-- Prerequisites (in order): sql/draft_schema.sql, sql/draft_open_mode.sql,
-- sql/draft_autoconfirm.sql, sql/fix_legacy_teacher_ownership.sql,
-- sql/draft_weeks.sql, sql/draft_race_fix.sql, >>> then this file <<<
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- (1) _advance_draft_turn — gains p_force, which skips ONLY the deadline
-- re-check. Body is otherwise byte-identical to sql/draft_race_fix.sql.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public._advance_draft_turn(uuid);

CREATE OR REPLACE FUNCTION public._advance_draft_turn(
  p_session_id uuid,
  p_force boolean DEFAULT false
)
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
  -- Taken on the forced path too: forcing skips the deadline check, never the
  -- mutual exclusion.
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
  --
  -- p_force skips ONLY this check, for confirm_turn: a teacher who has just
  -- confirmed has deliberately ended her own turn early, so there is no
  -- deadline to wait for. Every other guard below still applies, and the
  -- caller still had to prove it was her turn before getting here.
  IF NOT p_force
     AND NOT public.is_admin()
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
-- public.advance_turn(uuid) and public.confirm_turn(text), both of which keep
-- their own grants. Clients still get no EXECUTE on it, so p_force is not
-- reachable from the API.

-- ---------------------------------------------------------------------------
-- (2) advance_turn — the timer-expiry / admin-skip path. Body is byte-identical
-- to sql/draft_weeks.sql except that the delegation now names p_force => false
-- explicitly instead of relying on the default. Both gates are untouched, so
-- this path still cannot advance early.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.advance_turn(p_session_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.draft_sessions;
BEGIN
  IF p_session_id IS NULL THEN
    v_session := public.current_session();
  ELSE
    SELECT * INTO v_session
    FROM public.draft_sessions
    WHERE id = p_session_id;
  END IF;

  IF v_session.id IS NULL OR v_session.phase <> 'live'::public.draft_phase THEN
    RAISE EXCEPTION 'no live draft to advance';
  END IF;

  IF NOT public.is_admin() AND (v_session.turn_ends_at IS NULL OR NOW() < v_session.turn_ends_at) THEN
    RAISE EXCEPTION 'turn has not ended yet';
  END IF;

  PERFORM public._advance_draft_turn(v_session.id, p_force => false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.advance_turn(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- (3) confirm_turn — same gates, same UPDATE, same 0-rows exception, plus the
-- lock (see header) and the forced advance at the end.
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

  -- Serialize against concurrent advances for the REST of this function, so the
  -- active-turn check below and the forced advance at the end see — and act on
  -- — the same state. Same lock and same acquisition order as
  -- _advance_draft_turn, and re-entrant within this transaction.
  PERFORM pg_advisory_xact_lock(hashtext(v_session.id::text));

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

  -- Her turn is finished the moment she confirms — end it now instead of
  -- burning the rest of the 3-minute timer. p_force skips only the deadline
  -- re-check; the advisory lock, the active-turn requirement above, and every
  -- other rule in _advance_draft_turn still apply. Because the UPDATE above
  -- confirmed at least one row, _advance_draft_turn records her turn as 'done',
  -- not 'skipped'.
  --
  -- Guarded on 'live': in the 'open' phase there is no turn queue to advance
  -- (a session only reaches 'open' once every turn is resolved, and an
  -- open-mode session has no turns at all), so nothing should move.
  IF v_session.phase = 'live'::public.draft_phase THEN
    PERFORM public._advance_draft_turn(v_session.id, p_force => true);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_turn(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- (4) Overload guard — abort the migration unless each name has exactly one
-- signature. This is what catches a stale _advance_draft_turn(uuid) surviving
-- alongside the new _advance_draft_turn(uuid, boolean): with both present,
-- PERFORM ... (v_session.id) would be ambiguous and the older, unforceable body
-- could still be reached.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_advance int;
  v_public_advance int;
  v_confirm int;
BEGIN
  SELECT count(*) INTO v_advance
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = '_advance_draft_turn';

  SELECT count(*) INTO v_public_advance
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'advance_turn';

  SELECT count(*) INTO v_confirm
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'confirm_turn';

  IF v_advance <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 _advance_draft_turn overload, found %', v_advance;
  END IF;

  IF v_public_advance <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 advance_turn overload, found %', v_public_advance;
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
--   _advance_draft_turn | p_session_id uuid, p_force boolean
--   advance_turn        | p_session_id uuid
--   confirm_turn        | p_code text
--
-- (2) Confirm ends the turn immediately (as the active teacher, mid-timer):
-- SELECT position, status FROM public.draft_turns
-- WHERE session_id = (SELECT id FROM public.current_session()) ORDER BY position;
-- SELECT public.confirm_turn('<her teacher_code>');
-- SELECT position, status FROM public.draft_turns
-- WHERE session_id = (SELECT id FROM public.current_session()) ORDER BY position;
-- -- her row must read 'done' and the next position must be 'active'.
--
-- (3) The timer-expiry path is still gated (run as a non-admin, mid-timer):
-- SELECT public.advance_turn();   -- must raise 'turn has not ended yet'
--
-- (4) Double-advance protection still holds — two psql sessions, expired timer:
-- Session A:  BEGIN; SELECT public.advance_turn(); -- do NOT commit yet
-- Session B:  SELECT public.advance_turn();        -- blocks on the advisory lock
-- Session A:  COMMIT;
-- B unblocks, re-reads turn_ends_at = now + 3 min, and returns without
-- advancing. Exactly one turn must have moved.
