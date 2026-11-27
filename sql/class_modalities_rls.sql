-- Restrict who can read class_modalities
-- ---------------------------------------------------------------------------
-- Before: "Authenticated can select class_modalities" USING (true), so any
-- signed-in user, students included, could read every teacher's modalities.
--
-- After:
--   * teachers read only their own rows (teacher_id = auth.uid())
--   * admins read every row (public.is_admin(), SECURITY DEFINER)
--   * everyone else, students included, reads zero rows
--
-- NOT CHANGED: writes (still only through set_class_modalities, which is
-- SECURITY DEFINER and unaffected by this policy), public.modalities (the
-- 20-name catalog stays readable), existing rows, grants.
--
-- Idempotent: safe to re-run.
-- Prerequisites: sql/modalities.sql.
-- ---------------------------------------------------------------------------

BEGIN;

DROP POLICY IF EXISTS "Authenticated can select class_modalities" ON public.class_modalities;
DROP POLICY IF EXISTS "Teachers own rows, admins all: select class_modalities" ON public.class_modalities;

CREATE POLICY "Teachers own rows, admins all: select class_modalities"
  ON public.class_modalities FOR SELECT
  TO authenticated
  USING (
    teacher_id = (SELECT auth.uid())
    OR (SELECT public.is_admin())
  );

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification (run manually after COMMIT):
-- SELECT policyname, qual FROM pg_policies
--  WHERE schemaname = 'public' AND tablename = 'class_modalities';
-- ---------------------------------------------------------------------------
