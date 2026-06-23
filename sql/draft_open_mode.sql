-- Start draft directly in open (free registration) mode
-- Re-runnable: safe to execute multiple times during development.
-- Prerequisites: sql/draft_schema.sql
-- Run in Supabase SQL Editor (Dashboard → SQL → New query).

ALTER TABLE public.draft_sessions
  DROP CONSTRAINT IF EXISTS draft_sessions_order_mode_check;

ALTER TABLE public.draft_sessions
  ADD CONSTRAINT draft_sessions_order_mode_check
  CHECK (order_mode IN ('random', 'ordenado', 'open'));

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

  IF p_order_mode NOT IN ('random', 'ordenado', 'open') THEN
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

  IF p_order_mode = 'open' THEN
    INSERT INTO public.draft_sessions (
      phase,
      order_mode,
      current_position,
      turn_ends_at,
      started_at
    )
    VALUES (
      'open'::public.draft_phase,
      'open',
      NULL,
      NULL,
      NOW()
    )
    RETURNING id INTO v_session_id;

    RETURN v_session_id;
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
