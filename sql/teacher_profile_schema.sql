-- Teacher profile schema: teacher_code + tightened teacher_classes RLS
-- Re-runnable: safe to execute multiple times during development.
-- Prerequisites: sql/schema.sql and sql/reservations_schema.sql (is_admin,
-- set_user_role, teacher_classes, admin profiles SELECT policy).
-- Run in Supabase SQL Editor (Dashboard → SQL → New query).

-- ---------------------------------------------------------------------------
-- profiles.teacher_code (unique when set; NULL for non-teachers / never promoted)
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS teacher_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_teacher_code_unique
  ON public.profiles (teacher_code)
  WHERE teacher_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Generate a unique teacher code (SECURITY DEFINER — not granted to clients)
-- Alphabet excludes ambiguous O/0/I/1. Length 6–8 characters.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_teacher_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  chars constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code text;
  code_len int;
  i int;
  attempts int := 0;
BEGIN
  LOOP
    code_len := 6 + floor(random() * 3)::int;
    code := '';
    FOR i IN 1..code_len LOOP
      code := code || substr(chars, 1 + floor(random() * length(chars))::int, 1);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1 FROM public.profiles WHERE teacher_code = code
    ) THEN
      RETURN code;
    END IF;

    attempts := attempts + 1;
    IF attempts > 100 THEN
      RAISE EXCEPTION 'could not generate unique teacher_code after 100 attempts';
    END IF;
  END LOOP;
END;
$$;

-- Intentionally no GRANT on generate_teacher_code — only called from set_user_role.

-- ---------------------------------------------------------------------------
-- Admin role changes: assign teacher_code when promoting to teacher
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_user_role(target_id uuid, new_role public.role)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'only admins can change roles';
  END IF;

  UPDATE public.profiles
  SET
    role = new_role,
    teacher_code = COALESCE(
      teacher_code,
      CASE
        WHEN new_role = 'teacher'::public.role THEN public.generate_teacher_code()
        ELSE NULL
      END
    )
  WHERE id = target_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_user_role(uuid, public.role) TO authenticated;

-- ---------------------------------------------------------------------------
-- profiles UPDATE: owners may edit full_name etc., but NOT role or teacher_code.
-- teacher_code is set only by set_user_role / generate_teacher_code (definer).
-- SELECT: unchanged — own row includes teacher_code; admins use select-all policy.
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
  );

-- ---------------------------------------------------------------------------
-- teacher_classes: writes restricted to role = teacher (not merely auth.uid())
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Teachers can select own teacher_classes or admin all" ON public.teacher_classes;
DROP POLICY IF EXISTS "Teachers can insert own teacher_classes" ON public.teacher_classes;
DROP POLICY IF EXISTS "Teachers can delete own teacher_classes" ON public.teacher_classes;

CREATE POLICY "Teachers can select own teacher_classes or admin all"
  ON public.teacher_classes
  FOR SELECT
  TO authenticated
  USING (teacher_id = auth.uid() OR public.is_admin());

CREATE POLICY "Teachers can insert own teacher_classes"
  ON public.teacher_classes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    teacher_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.profiles AS p
      WHERE p.id = auth.uid()
        AND p.role = 'teacher'::public.role
    )
  );

CREATE POLICY "Teachers can delete own teacher_classes"
  ON public.teacher_classes
  FOR DELETE
  TO authenticated
  USING (
    teacher_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.profiles AS p
      WHERE p.id = auth.uid()
        AND p.role = 'teacher'::public.role
    )
  );

-- ---------------------------------------------------------------------------
-- Verification (manual — run as admin in SQL Editor after applying this file)
-- ---------------------------------------------------------------------------
-- 1) Promote a user to teacher (replace UUID with a real profiles.id):
--
-- SELECT public.set_user_role(
--   '00000000-0000-0000-0000-000000000000'::uuid,
--   'teacher'::public.role
-- );
--
-- SELECT id, full_name, role, teacher_code
-- FROM public.profiles
-- WHERE id = '00000000-0000-0000-0000-000000000000'::uuid;
--   → role = teacher, teacher_code is a 6–8 char uppercase code
--
-- 2) Re-promote same user to teacher — code must not change:
--
-- SELECT public.set_user_role(
--   '00000000-0000-0000-0000-000000000000'::uuid,
--   'teacher'::public.role
-- );
--   → teacher_code unchanged (COALESCE keeps existing value)
--
-- 3) As a student session, insert into teacher_classes should fail RLS:
--
-- INSERT INTO public.teacher_classes (teacher_id, class_id)
-- VALUES (
--   auth.uid(),
--   (SELECT id FROM public.classes LIMIT 1)
-- );
--   → ERROR: new row violates row-level security policy
