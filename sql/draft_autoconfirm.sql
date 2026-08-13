-- Auto-confirm picks on turn expiry
-- ---------------------------------------------------------------------------
-- Behavior change: when a live-draft turn's deadline passes and the turn is
-- advanced, the expiring teacher's UNCONFIRMED picks for that session used to
-- be DELETED — a teacher who placed picks but never entered her confirmation
-- code lost everything. Now those picks are AUTO-CONFIRMED instead
-- (UPDATE ... SET confirmed = true), scoped strictly to that teacher AND that
-- session AND confirmed = false, so no other teacher's rows are ever touched.
--
-- confirm_turn (manual code entry) is unchanged and still confirms early.
-- advance_turn is unchanged — it only delegates to this helper.
--
-- Idempotent: CREATE OR REPLACE with the exact original signature; safe to run
-- multiple times. This script must be run MANUALLY in the Supabase SQL Editor
-- (Dashboard -> SQL -> New query). Requires sql/draft_schema.sql to have been
-- run previously.
-- ---------------------------------------------------------------------------

BEGIN;

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

-- No GRANTs needed: _advance_draft_turn is a private helper and the original
-- schema intentionally grants no EXECUTE on it to clients; it is only invoked
-- via public.advance_turn() (SECURITY DEFINER), which retains its own grant.

COMMIT;
