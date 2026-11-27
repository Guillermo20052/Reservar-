-- Learning modalities per class reservation (Prakash Nair's 20 modalities)
-- ---------------------------------------------------------------------------
-- Tracks HOW a teacher uses her spaces each week: for every class she teaches
-- in a draft week she records 1–20 of Nair's 20 learning modalities (was 2–3;
-- see sql/modalities_any_count.sql for the live change).
--
--   public.modalities        id 1–20 (Nair number) + name. Seeded VERBATIM from
--                            DATA.modalidades in index.html (array index + 1).
--                            Read-only for clients.
--   public.class_modalities  one row per (week_start, slot_id, slot_part_id,
--                            teacher_id). Modalities belong to the CLASS, not to
--                            each space pick: a class with two space picks still
--                            has exactly one modality set.
--   set_class_modalities()   SECURITY DEFINER upsert. Caller must be the teacher
--                            assigned to the slot/part via the junction tables
--                            (same ownership check as place_pick); week is the
--                            current session's week_start.
--
-- NOT CHANGED: place_pick, remove_pick, confirm_turn, advance_turn or any other
-- draft function. Modalities never gate the draft, the turn timer or confirm.
--
-- Idempotent: safe to re-run.
--
-- Prerequisites: sql/draft_weeks.sql (current_session(), week_start),
-- sql/timetable_slot_teachers.sql + sql/timetable_slot_multi.sql (junctions).
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. modalities (catalog)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.modalities (
  id   smallint PRIMARY KEY CHECK (id BETWEEN 1 AND 20),
  name text NOT NULL UNIQUE
);

INSERT INTO public.modalities (id, name) VALUES
  (1,  'Estudio independiente'),
  (2,  'Tutoría entre pares'),
  (3,  'Aprendizaje uno a uno con el docente'),
  (4,  'Cátedra del docente (clase magistral)'),
  (5,  'Colaboración en equipo'),
  (6,  'Aprendizaje basado en proyectos'),
  (7,  'Aprendizaje a distancia'),
  (8,  'Aprendizaje con tecnología móvil'),
  (9,  'Presentaciones de las alumnas'),
  (10, 'Investigación en internet'),
  (11, 'Mesas redondas / discusiones'),
  (12, 'Aprendizaje basado en performance'),
  (13, 'Estudio interdisciplinario'),
  (14, 'Aprendizaje naturalista'),
  (15, 'Aprendizaje basado en arte'),
  (16, 'Aprendizaje socioemocional'),
  (17, 'Aprendizaje basado en el diseño'),
  (18, 'Narración de historias (storytelling)'),
  (19, 'Co-enseñanza y aprendizaje en equipo'),
  (20, 'Aprendizaje basado en el juego y el movimiento')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

ALTER TABLE public.modalities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can select modalities" ON public.modalities;
CREATE POLICY "Authenticated can select modalities"
  ON public.modalities FOR SELECT
  TO authenticated
  USING (true);
-- No INSERT/UPDATE/DELETE policies: clients cannot write the catalog.

-- ---------------------------------------------------------------------------
-- 2. class_modalities
-- ---------------------------------------------------------------------------
-- Pure helper for the CHECK: every element distinct and non-null.
CREATE OR REPLACE FUNCTION public.smallint_array_distinct_nonnull(a smallint[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT a IS NOT NULL
     AND array_position(a, NULL) IS NULL
     AND cardinality(a) = (SELECT count(DISTINCT x) FROM unnest(a) AS x);
$$;

CREATE TABLE IF NOT EXISTS public.class_modalities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start    date NOT NULL,
  slot_id       uuid NOT NULL REFERENCES public.timetable_slots(id) ON DELETE CASCADE,
  slot_part_id  uuid NULL REFERENCES public.timetable_slot_parts(id) ON DELETE CASCADE,
  teacher_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  modality_ids  smallint[] NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT class_modalities_count_chk
    CHECK (cardinality(modality_ids) BETWEEN 1 AND 20),
  CONSTRAINT class_modalities_distinct_chk
    CHECK (public.smallint_array_distinct_nonnull(modality_ids)),
  CONSTRAINT class_modalities_class_unique
    UNIQUE NULLS NOT DISTINCT (week_start, slot_id, slot_part_id, teacher_id)
);

CREATE INDEX IF NOT EXISTS class_modalities_week_idx
  ON public.class_modalities (week_start);
CREATE INDEX IF NOT EXISTS class_modalities_teacher_week_idx
  ON public.class_modalities (teacher_id, week_start);

-- Every id must exist in public.modalities. A CHECK cannot read another
-- table, so a trigger enforces it on every insert/update (also covers any
-- future write path, not just the RPC).
CREATE OR REPLACE FUNCTION public.class_modalities_validate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.modality_ids) AS x
    WHERE NOT EXISTS (SELECT 1 FROM public.modalities m WHERE m.id = x)
  ) THEN
    RAISE EXCEPTION 'modalidad no válida';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS class_modalities_validate_trg ON public.class_modalities;
CREATE TRIGGER class_modalities_validate_trg
  BEFORE INSERT OR UPDATE ON public.class_modalities
  FOR EACH ROW EXECUTE FUNCTION public.class_modalities_validate();

ALTER TABLE public.class_modalities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can select class_modalities" ON public.class_modalities;
CREATE POLICY "Authenticated can select class_modalities"
  ON public.class_modalities FOR SELECT
  TO authenticated
  USING (true);
-- No INSERT/UPDATE/DELETE policies: writes only through set_class_modalities.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.class_modalities FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.modalities FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. set_class_modalities RPC
-- ---------------------------------------------------------------------------
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
-- SELECT id, name FROM public.modalities ORDER BY id;           -- 20 rows
-- SELECT count(*) FROM public.class_modalities;
-- ---------------------------------------------------------------------------
