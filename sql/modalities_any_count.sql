-- Modalities per class: any number from 1 to 20 (was 2–3)
-- ---------------------------------------------------------------------------
-- Teachers may now record as many of Nair's 20 modalities as they use in a
-- class: at least 1, up to all 20.
--
--   class_modalities_count_chk   cardinality BETWEEN 2 AND 3  ->  BETWEEN 1 AND 20
--   set_class_modalities()       same signature, CREATE OR REPLACE; validation
--                                is now: at least 1, no duplicates, every id
--                                in public.modalities. 'elige 2 o 3 modalidades'
--                                becomes 'elige al menos 1 modalidad'.
--
-- NOT CHANGED: class_modalities_distinct_chk (no duplicates / no nulls), the
-- validate trigger (ids must exist in public.modalities, i.e. 1–20), the
-- unique key, RLS (sql/class_modalities_rls.sql), grants, existing rows
-- (all have 2–3 ids, which still satisfies 1–20).
--
-- Idempotent: safe to re-run.
-- Prerequisites: sql/modalities.sql.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE public.class_modalities
  DROP CONSTRAINT IF EXISTS class_modalities_count_chk;

ALTER TABLE public.class_modalities
  ADD CONSTRAINT class_modalities_count_chk
  CHECK (cardinality(modality_ids) BETWEEN 1 AND 20);

CREATE OR REPLACE FUNCTION public.set_class_modalities(
  p_slot_id uuid,
  p_slot_part_id uuid,
  p_modality_ids smallint[]
)
RETURNS public.class_modalities
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.draft_sessions;
  v_slot public.timetable_slots;
  v_ids smallint[];
  v_row public.class_modalities;
BEGIN
  v_session := public.current_session();

  IF v_session.id IS NULL OR v_session.phase NOT IN ('live'::public.draft_phase, 'open'::public.draft_phase) THEN
    RAISE EXCEPTION 'reservas cerradas';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'teacher'::public.role
  ) THEN
    RAISE EXCEPTION 'solo docentes pueden registrar modalidades';
  END IF;

  -- At least 1 (up to all 20) distinct, valid modality ids.
  IF p_modality_ids IS NULL
     OR cardinality(p_modality_ids) = 0
     OR array_position(p_modality_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'elige al menos 1 modalidad';
  END IF;

  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_ids FROM unnest(p_modality_ids) AS x;

  IF cardinality(v_ids) <> cardinality(p_modality_ids) THEN
    RAISE EXCEPTION 'modalidades repetidas';
  END IF;

  IF cardinality(v_ids) NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'elige al menos 1 modalidad';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) AS x
    WHERE NOT EXISTS (SELECT 1 FROM public.modalities m WHERE m.id = x)
  ) THEN
    RAISE EXCEPTION 'modalidad no válida';
  END IF;

  -- Ownership: identical junction-only check to place_pick.
  SELECT * INTO v_slot FROM public.timetable_slots WHERE id = p_slot_id;

  IF v_slot.id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  IF v_slot.is_multi THEN
    IF p_slot_part_id IS NULL THEN
      RAISE EXCEPTION 'part required for multi slot';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.timetable_slot_parts tsp
      WHERE tsp.id = p_slot_part_id AND tsp.slot_id = p_slot_id
    ) THEN
      RAISE EXCEPTION 'invalid slot part';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.timetable_slot_part_teachers tspt
      WHERE tspt.part_id = p_slot_part_id AND tspt.teacher_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not your slot';
    END IF;
  ELSE
    IF p_slot_part_id IS NOT NULL THEN
      RAISE EXCEPTION 'part not allowed for single slot';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.timetable_slot_teachers tst
      WHERE tst.slot_id = p_slot_id AND tst.teacher_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not your slot';
    END IF;
  END IF;

  INSERT INTO public.class_modalities (week_start, slot_id, slot_part_id, teacher_id, modality_ids)
  VALUES (v_session.week_start, p_slot_id, p_slot_part_id, auth.uid(), v_ids)
  ON CONFLICT ON CONSTRAINT class_modalities_class_unique
  DO UPDATE SET modality_ids = EXCLUDED.modality_ids, updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.set_class_modalities(uuid, uuid, smallint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_class_modalities(uuid, uuid, smallint[]) TO authenticated;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification (run manually after COMMIT):
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conname = 'class_modalities_count_chk';
-- ---------------------------------------------------------------------------
