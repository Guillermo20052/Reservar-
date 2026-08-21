-- Week-scoped drafts with per-week history
-- ---------------------------------------------------------------------------
-- Problem this fixes: start_draft() and reset_draft() ran
--   DELETE FROM public.reservations WHERE true;
-- so every new draft wiped the ENTIRE reservation history. There was no notion
-- of "which week is this draft for", so a draft run on Thursday for next week
-- destroyed the current week's confirmed assignments, and a draft could never
-- be prepared in advance for a future week.
--
-- End state after this migration:
--   * draft_sessions.week_start DATE  — the Monday of the week the draft is for.
--   * reservations.week_start   DATE  — denormalized from the session so history
--     survives even if the session row is later closed, and so week queries are
--     a single indexed predicate with no join.
--   * start_draft(p_week_start, p_order_mode, p_ordered_ids) clears ONLY that
--     week (and only unconfirmed rows when that week already had a session), so
--     other weeks — past history and pre-run future drafts — are untouched.
--   * reset_draft(p_week_start) deletes only that week's reservations.
--   * The three unique indexes on reservations are now week-scoped, so week 2
--     can reuse a room/slot that week 1 used. See "CONSTRAINTS CHANGED" below.
--
-- CONSTRAINTS CHANGED (all three kept their ORIGINAL NAMES on purpose, so that
-- re-running the older CREATE UNIQUE INDEX IF NOT EXISTS statements in
-- sql/reservations_schema.sql or sql/reservation_two_picks.sql cannot silently
-- resurrect a global variant):
--
--   1. reservations_space_day_start_unique   -- the double-booking guard
--        was: UNIQUE (space_id, day, start_time)                     [GLOBAL]
--        now: UNIQUE (week_start, space_id, day, start_time)         [PER WEEK]
--      This is the constraint named in the request. Without this change, once a
--      space was taken on Monday 08:00 in week 1, NO later week could ever book
--      that space at that time again.
--
--   2. reservations_teacher_slot_pick_single  (partial: slot_part_id IS NULL)
--        was: UNIQUE (slot_id, teacher_id, pick_index)               [GLOBAL]
--        now: UNIQUE (week_start, slot_id, teacher_id, pick_index)   [PER WEEK]
--
--   3. reservations_teacher_part_pick         (partial: slot_part_id IS NOT NULL)
--        was: UNIQUE (slot_id, teacher_id, slot_part_id, pick_index)          [GLOBAL]
--        now: UNIQUE (week_start, slot_id, teacher_id, slot_part_id, pick_index)
--
--      2 and 3 were NOT named in the request but have the identical defect: they
--      are one-row-per-(slot, teacher, pick) FOREVER, so a teacher who booked a
--      franja in week 1 could not book that same franja again in week 2. Leaving
--      them global would make week-scoped drafts fail on the second week.
--
-- Preserved unchanged: every role gate (is_admin on start/reset, teacher role +
-- slot-ownership + turn checks on place_pick/remove_pick), the turn creation and
-- phase logic in start_draft, all RLS policies, all Realtime publication
-- membership and REPLICA IDENTITY settings, _advance_draft_turn (already
-- session-scoped), and confirm_turn (already session-scoped).
--
-- Idempotent: safe to re-run. Run MANUALLY in the Supabase SQL Editor
-- (Dashboard -> SQL -> New query). DO NOT run automatically.
--
-- Prerequisites, in this order:
--   sql/reservations_schema.sql
--   sql/timetable_slot_multi.sql
--   sql/reservation_two_picks.sql
--   sql/draft_schema.sql
--   sql/draft_open_mode.sql
--   sql/draft_autoconfirm.sql
--   sql/fix_legacy_teacher_ownership.sql
--   >>> then this file <<<
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- (0) Week helpers
--
-- week_start_of() uses date_trunc('week', ...), which in PostgreSQL is ISO week
-- and therefore always returns a MONDAY.
--
-- current_week_start() evaluates "today" in America/Monterrey rather than the
-- database's UTC clock, so it agrees with the client-side week computation in
-- js/horario-view.js (getMonterreyToday). Using CURRENT_DATE here would roll to
-- the next week from 18:00 Sunday Monterrey onward.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.week_start_of(p_date date)
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT (date_trunc('week', p_date::timestamp))::date;
$$;

CREATE OR REPLACE FUNCTION public.current_week_start()
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.week_start_of((NOW() AT TIME ZONE 'America/Monterrey')::date);
$$;

GRANT EXECUTE ON FUNCTION public.week_start_of(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_week_start() TO authenticated;

-- ---------------------------------------------------------------------------
-- (1) draft_sessions.week_start
-- Backfill: every pre-existing session becomes "this week's draft" so the data
-- that is live right now is preserved instead of being orphaned.
-- ---------------------------------------------------------------------------
ALTER TABLE public.draft_sessions
  ADD COLUMN IF NOT EXISTS week_start DATE;

UPDATE public.draft_sessions
SET week_start = public.current_week_start()
WHERE week_start IS NULL;

ALTER TABLE public.draft_sessions
  ALTER COLUMN week_start SET DEFAULT public.current_week_start();

ALTER TABLE public.draft_sessions
  ALTER COLUMN week_start SET NOT NULL;

CREATE INDEX IF NOT EXISTS draft_sessions_week_start_idx
  ON public.draft_sessions (week_start);

-- ---------------------------------------------------------------------------
-- (2) reservations.week_start
-- Denormalized from the owning session; rows with no session (legacy/manual
-- admin inserts) fall back to the current week, same as the sessions above.
-- ---------------------------------------------------------------------------
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS week_start DATE;

UPDATE public.reservations r
SET week_start = COALESCE(ds.week_start, public.current_week_start())
FROM public.draft_sessions ds
WHERE ds.id = r.session_id
  AND r.week_start IS NULL;

UPDATE public.reservations
SET week_start = public.current_week_start()
WHERE week_start IS NULL;

ALTER TABLE public.reservations
  ALTER COLUMN week_start SET DEFAULT public.current_week_start();

ALTER TABLE public.reservations
  ALTER COLUMN week_start SET NOT NULL;

CREATE INDEX IF NOT EXISTS reservations_week_start_idx
  ON public.reservations (week_start);

CREATE INDEX IF NOT EXISTS reservations_session_id_idx
  ON public.reservations (session_id);

-- ---------------------------------------------------------------------------
-- (3) Re-scope the uniqueness guards to the week. See "CONSTRAINTS CHANGED".
-- DROP + CREATE (not CREATE ... IF NOT EXISTS) because the index names already
-- exist with the old, global definition.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.reservations_space_day_start_unique;
CREATE UNIQUE INDEX reservations_space_day_start_unique
  ON public.reservations (week_start, space_id, day, start_time);
COMMENT ON INDEX public.reservations_space_day_start_unique IS
  'One booking per space+day+time PER WEEK (week-scoped by sql/draft_weeks.sql).';

DROP INDEX IF EXISTS public.reservations_teacher_slot_pick_single;
CREATE UNIQUE INDEX reservations_teacher_slot_pick_single
  ON public.reservations (week_start, slot_id, teacher_id, pick_index)
  WHERE slot_part_id IS NULL;
COMMENT ON INDEX public.reservations_teacher_slot_pick_single IS
  'One pick per slot+teacher+pick_index PER WEEK (week-scoped by sql/draft_weeks.sql).';

DROP INDEX IF EXISTS public.reservations_teacher_part_pick;
CREATE UNIQUE INDEX reservations_teacher_part_pick
  ON public.reservations (week_start, slot_id, teacher_id, slot_part_id, pick_index)
  WHERE slot_part_id IS NOT NULL;
COMMENT ON INDEX public.reservations_teacher_part_pick IS
  'One pick per slot+part+teacher+pick_index PER WEEK (week-scoped by sql/draft_weeks.sql).';

-- ---------------------------------------------------------------------------
-- (4) start_draft — now takes the target week.
--
-- The OLD signature start_draft(text, uuid[]) is DROPPED explicitly so no stale
-- overload survives: leaving it would let a cached PostgREST schema (or an old
-- browser tab) keep calling the global-delete version.
--
-- Differences from the previous body, and nothing else:
--   a) new required first parameter p_week_start, normalized to its Monday;
--   b) the session-closing UPDATE is scoped to week_start <= the target week, so
--      a draft already prepared for a LATER week is not closed;
--   c) "DELETE FROM public.reservations WHERE true" is replaced by a delete
--      scoped to the target week — all of that week's rows when the week has no
--      session yet, only the UNCONFIRMED ones when it does (re-running a draft
--      for a week that already ran keeps its confirmed history);
--   d) the new session row carries week_start.
-- Role gate, order_mode validation, teacher-list validation, open/live phase
-- handling and turn creation are byte-for-byte the previous logic.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.start_draft(text, uuid[]);

CREATE OR REPLACE FUNCTION public.start_draft(
  p_week_start date,
  p_order_mode text,
  p_ordered_ids uuid[] DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_week date;
  v_week_had_session boolean;
  v_teacher_ids uuid[];
  v_ordered uuid[];
  v_session_id uuid;
  v_pos int;
  v_teacher_id uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'only admins can start draft';
  END IF;

  IF p_week_start IS NULL THEN
    RAISE EXCEPTION 'week_start is required';
  END IF;

  v_week := public.week_start_of(p_week_start);

  IF p_order_mode NOT IN ('random', 'ordenado', 'open') THEN
    RAISE EXCEPTION 'invalid order_mode';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.draft_sessions WHERE week_start = v_week
  )
  INTO v_week_had_session;

  -- Close this week's sessions and any still-open sessions from earlier weeks.
  -- Sessions for LATER weeks stay open so future drafts can be prepared ahead.
  UPDATE public.draft_sessions
  SET phase = 'closed'::public.draft_phase
  WHERE phase <> 'closed'::public.draft_phase
    AND week_start <= v_week;

  -- Week-scoped clear. Never touches any other week.
  IF v_week_had_session THEN
    DELETE FROM public.reservations
    WHERE week_start = v_week
      AND confirmed = false;
  ELSE
    DELETE FROM public.reservations
    WHERE week_start = v_week;
  END IF;

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
      started_at,
      week_start
    )
    VALUES (
      'open'::public.draft_phase,
      'open',
      NULL,
      NULL,
      NOW(),
      v_week
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
    started_at,
    week_start
  )
  VALUES (
    'live'::public.draft_phase,
    p_order_mode,
    1,
    NOW() + INTERVAL '3 minutes',
    NOW(),
    v_week
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

GRANT EXECUTE ON FUNCTION public.start_draft(date, text, uuid[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- (5) reset_draft — week-scoped delete.
--
-- The OLD zero-argument signature is DROPPED and replaced by a single function
-- with an optional parameter. A no-argument call (supabase.rpc('reset_draft'))
-- still works via the DEFAULT and falls back to the current session's week, so
-- there is exactly ONE reset_draft in the catalog and no ambiguous overload.
--
-- Semantics preserved: still admin-only, still a full wipe of that week
-- (confirmed rows included) plus closing that week's sessions. Only the blast
-- radius changed: one week instead of the whole table.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.reset_draft();

CREATE OR REPLACE FUNCTION public.reset_draft(p_week_start date DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_week date;
  v_session public.draft_sessions;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'only admins can reset draft';
  END IF;

  IF p_week_start IS NOT NULL THEN
    v_week := public.week_start_of(p_week_start);
  ELSE
    v_session := public.current_session();
    v_week := v_session.week_start;
  END IF;

  IF v_week IS NULL THEN
    RAISE EXCEPTION 'no hay sesión activa que reiniciar';
  END IF;

  DELETE FROM public.reservations
  WHERE week_start = v_week;

  UPDATE public.draft_sessions
  SET phase = 'closed'::public.draft_phase
  WHERE week_start = v_week
    AND phase <> 'closed'::public.draft_phase;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_draft(date) TO authenticated;

-- ---------------------------------------------------------------------------
-- (5b) advance_turn — may now be pointed at a specific session.
--
-- Why this is needed: with future weeks allowed, two sessions can be non-closed
-- at once (a draft running for this week, plus one prepared ahead for a later
-- week). current_session() returns the newest-created one, so an admin watching
-- the OTHER week's board would otherwise advance the wrong draft.
--
-- The zero-argument signature is DROPPED and replaced by one function with an
-- optional parameter, so supabase.rpc('advance_turn') with no args (the
-- teacher's turn-expiry auto-advance) keeps working through the DEFAULT and no
-- ambiguous overload is left behind. The admin panel passes the id of the
-- session it is actually displaying.
--
-- Both gates are unchanged: the session must be 'live', and a non-admin caller
-- may only advance once turn_ends_at has passed.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.advance_turn();

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

  PERFORM public._advance_draft_turn(v_session.id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.advance_turn(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- (6) place_pick / remove_pick — stamp and scope by the session's week.
--
-- Bodies are identical to sql/fix_legacy_teacher_ownership.sql (junction-only
-- ownership, teacher role gate, live-turn gate, 2-pick limit) except:
--   * the "replace my existing pick" DELETE now also matches week_start, so a
--     new pick in week 2 cannot delete the same teacher's week 1 row;
--   * the INSERT stamps week_start from the session instead of relying on the
--     column DEFAULT, which would be wrong for a draft run ahead for a future
--     week.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.place_pick(
  p_slot_id uuid,
  p_space_id smallint,
  p_slot_part_id uuid DEFAULT NULL,
  p_pick_index smallint DEFAULT 1
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
  IF p_pick_index IS NULL OR p_pick_index NOT IN (1, 2) THEN
    RAISE EXCEPTION 'invalid pick index';
  END IF;

  v_session := public.current_session();

  IF v_session.id IS NULL OR v_session.phase NOT IN ('live'::public.draft_phase, 'open'::public.draft_phase) THEN
    RAISE EXCEPTION 'reservas cerradas';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'teacher'::public.role
  ) THEN
    RAISE EXCEPTION 'solo docentes pueden reservar';
  END IF;

  SELECT * INTO v_slot FROM public.timetable_slots WHERE id = p_slot_id;

  IF v_slot.id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  IF v_slot.is_multi THEN
    IF p_slot_part_id IS NULL THEN
      RAISE EXCEPTION 'part required for multi slot';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.timetable_slot_parts tsp
      WHERE tsp.id = p_slot_part_id AND tsp.slot_id = p_slot_id
    ) THEN
      RAISE EXCEPTION 'invalid slot part';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.timetable_slot_part_teachers tspt
      WHERE tspt.part_id = p_slot_part_id AND tspt.teacher_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not your slot';
    END IF;
  ELSE
    IF p_slot_part_id IS NOT NULL THEN
      RAISE EXCEPTION 'part not allowed for single slot';
    END IF;

    -- Junction-only ownership: the legacy timetable_slots.teacher_id
    -- OR-branch that used to sit here is intentionally removed.
    IF NOT EXISTS (
      SELECT 1 FROM public.timetable_slot_teachers tst
      WHERE tst.slot_id = p_slot_id AND tst.teacher_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not your slot';
    END IF;
  END IF;

  IF v_session.phase = 'live'::public.draft_phase THEN
    SELECT dt.teacher_id INTO v_active_teacher
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
    AND pick_index = p_pick_index
    AND week_start = v_session.week_start
    AND (
      (p_slot_part_id IS NULL AND slot_part_id IS NULL)
      OR slot_part_id = p_slot_part_id
    );

  BEGIN
    INSERT INTO public.reservations (
      slot_id, slot_part_id, pick_index, space_id, teacher_id, day, start_time,
      confirmed, session_id, week_start
    )
    VALUES (
      p_slot_id, p_slot_part_id, p_pick_index, p_space_id, auth.uid(),
      v_slot.day, v_slot.start_time, false, v_session.id, v_session.week_start
    );
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'espacio no disponible';
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_pick(
  p_slot_id uuid,
  p_slot_part_id uuid DEFAULT NULL,
  p_pick_index smallint DEFAULT 1
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
  IF p_pick_index IS NULL OR p_pick_index NOT IN (1, 2) THEN
    RAISE EXCEPTION 'invalid pick index';
  END IF;

  v_session := public.current_session();

  IF v_session.id IS NULL OR v_session.phase NOT IN ('live'::public.draft_phase, 'open'::public.draft_phase) THEN
    RAISE EXCEPTION 'reservas cerradas';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'teacher'::public.role
  ) THEN
    RAISE EXCEPTION 'solo docentes pueden reservar';
  END IF;

  SELECT * INTO v_slot FROM public.timetable_slots WHERE id = p_slot_id;

  IF v_slot.id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  IF v_slot.is_multi THEN
    IF p_slot_part_id IS NULL THEN
      RAISE EXCEPTION 'part required for multi slot';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.timetable_slot_part_teachers tspt
      WHERE tspt.part_id = p_slot_part_id AND tspt.teacher_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not your slot';
    END IF;
  ELSE
    -- Junction-only ownership: legacy OR-branch removed (see place_pick).
    IF NOT EXISTS (
      SELECT 1 FROM public.timetable_slot_teachers tst
      WHERE tst.slot_id = p_slot_id AND tst.teacher_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not your slot';
    END IF;
  END IF;

  IF v_session.phase = 'live'::public.draft_phase THEN
    SELECT dt.teacher_id INTO v_active_teacher
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
    AND pick_index = p_pick_index
    AND confirmed = false
    AND week_start = v_session.week_start
    AND (
      (p_slot_part_id IS NULL AND slot_part_id IS NULL)
      OR slot_part_id = p_slot_part_id
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.place_pick(uuid, smallint, uuid, smallint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_pick(uuid, uuid, smallint) TO authenticated;

-- ---------------------------------------------------------------------------
-- (7) RLS / Realtime: intentionally untouched.
-- draft_sessions and draft_turns keep their SELECT-only policies; reservations
-- keeps "Authenticated can select reservations" (USING true) plus the
-- admin-only write policies. Adding a column does not change policy coverage,
-- and all three tables are already in the supabase_realtime publication with
-- REPLICA IDENTITY FULL, so the admin/teacher/horario channels keep firing.
-- The Historial view reads reservations + draft_sessions directly under those
-- existing SELECT policies, so no new RPC and no policy change is required.
-- ---------------------------------------------------------------------------

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification (manual — run in SQL Editor as admin, AFTER the COMMIT above)
-- ---------------------------------------------------------------------------
-- (1) Columns and backfill:
-- SELECT week_start, count(*) FROM public.reservations GROUP BY 1 ORDER BY 1;
-- SELECT week_start, phase, order_mode, started_at FROM public.draft_sessions
-- ORDER BY week_start DESC, created_at DESC;
--
-- (2) Exactly one start_draft and one reset_draft must remain:
-- SELECT p.proname, pg_get_function_identity_arguments(p.oid)
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND p.proname IN ('start_draft', 'reset_draft', 'advance_turn');
-- Expected exactly:
--   start_draft  | date, text, uuid[]
--   reset_draft  | date
--   advance_turn | uuid
--
-- (3) Week-scoped indexes:
-- SELECT indexname, indexdef FROM pg_indexes
-- WHERE schemaname = 'public' AND tablename = 'reservations';
-- Each of the three UNIQUE indexes must list week_start.
--
-- (4) Start next week's draft without touching this week:
-- SELECT public.start_draft(public.current_week_start() + 7, 'random');
-- SELECT week_start, count(*) FROM public.reservations GROUP BY 1 ORDER BY 1;
-- -- this week's row count must be unchanged.
--
-- (5) Reset only that week:
-- SELECT public.reset_draft(public.current_week_start() + 7);
