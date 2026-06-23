-- Reservar reservation schema
-- Re-runnable: safe to execute multiple times during development.
-- Prerequisites: run sql/schema.sql first (public.role enum + public.profiles).
-- Run in Supabase SQL Editor (Dashboard → SQL → New query).

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.grade AS ENUM ('10mo', '11vo', '12vo');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.weekday AS ENUM (
    'lunes', 'martes', 'miercoles', 'jueves', 'viernes'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin(uid uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = uid
      AND role = 'admin'::public.role
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Classes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES public.profiles (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Spaces (seeded — guide order)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.spaces (
  id SMALLINT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort_order SMALLINT NOT NULL
);

INSERT INTO public.spaces (id, name, sort_order) VALUES
  (1, 'Lumen', 1),
  (2, 'Anima', 2),
  (3, 'Sedes', 3),
  (5, 'Rivus', 4),
  (6, 'The WHY', 5),
  (7, 'Lacus', 6),
  (8, 'Agora', 7),
  (9, 'Eureka', 8),
  (11, 'Radices 1', 9),
  (14, 'Radices 2', 10),
  (12, 'Virtus', 11),
  (13, 'Vesta', 12),
  (15, 'Caelum', 13)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;

-- ---------------------------------------------------------------------------
-- Timetable slots (one row per class placement)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.timetable_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES public.classes (id) ON DELETE CASCADE,
  teacher_id UUID REFERENCES public.profiles (id),
  grade public.grade NOT NULL,
  day public.weekday NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_time CHECK (end_time > start_time),
  is_multi BOOLEAN NOT NULL DEFAULT false
);

-- Multiple teachers per slot (preferred; teacher_id above is legacy)
CREATE TABLE IF NOT EXISTS public.timetable_slot_teachers (
  slot_id UUID NOT NULL REFERENCES public.timetable_slots (id) ON DELETE CASCADE,
  teacher_id UUID NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  PRIMARY KEY (slot_id, teacher_id)
);

CREATE INDEX IF NOT EXISTS timetable_slot_teachers_teacher_id_idx
  ON public.timetable_slot_teachers (teacher_id);

CREATE TABLE IF NOT EXISTS public.timetable_slot_parts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id UUID NOT NULL REFERENCES public.timetable_slots (id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES public.classes (id) ON DELETE CASCADE,
  part_index SMALLINT NOT NULL CHECK (part_index IN (1, 2)),
  UNIQUE (slot_id, part_index)
);

CREATE INDEX IF NOT EXISTS timetable_slot_parts_slot_id_idx
  ON public.timetable_slot_parts (slot_id);

CREATE TABLE IF NOT EXISTS public.timetable_slot_part_teachers (
  part_id UUID NOT NULL REFERENCES public.timetable_slot_parts (id) ON DELETE CASCADE,
  teacher_id UUID NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  PRIMARY KEY (part_id, teacher_id)
);

CREATE INDEX IF NOT EXISTS timetable_slot_part_teachers_teacher_id_idx
  ON public.timetable_slot_part_teachers (teacher_id);

-- ---------------------------------------------------------------------------
-- Teacher classes (self-declared interest at signup)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.teacher_classes (
  teacher_id UUID NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES public.classes (id) ON DELETE CASCADE,
  PRIMARY KEY (teacher_id, class_id)
);

-- ---------------------------------------------------------------------------
-- Reservations
-- day and start_time are denormalized from the slot at insert time (app sets
-- them when booking); no trigger copies them from timetable_slots.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id UUID NOT NULL REFERENCES public.timetable_slots (id) ON DELETE CASCADE,
  space_id SMALLINT NOT NULL REFERENCES public.spaces (id),
  teacher_id UUID NOT NULL REFERENCES public.profiles (id),
  day public.weekday NOT NULL,
  start_time TIME NOT NULL,
  confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  slot_part_id UUID REFERENCES public.timetable_slot_parts (id) ON DELETE CASCADE,
  pick_index SMALLINT NOT NULL DEFAULT 1 CHECK (pick_index IN (1, 2))
);

CREATE UNIQUE INDEX IF NOT EXISTS reservations_teacher_slot_pick_single
  ON public.reservations (slot_id, teacher_id, pick_index)
  WHERE slot_part_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reservations_teacher_part_pick
  ON public.reservations (slot_id, teacher_id, slot_part_id, pick_index)
  WHERE slot_part_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reservations_space_day_start_unique
  ON public.reservations (space_id, day, start_time);

-- ---------------------------------------------------------------------------
-- Role management (admin assigns roles from the app)
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
  SET role = new_role
  WHERE id = target_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_user_role(uuid, public.role) TO authenticated;

-- ---------------------------------------------------------------------------
-- Profiles: admin can list all users (additive — keeps "select own profile")
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can select all profiles" ON public.profiles;

CREATE POLICY "Admins can select all profiles"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- ---------------------------------------------------------------------------
-- Row Level Security — new tables
-- ---------------------------------------------------------------------------
ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timetable_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timetable_slot_teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timetable_slot_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timetable_slot_part_teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teacher_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;

-- classes
DROP POLICY IF EXISTS "Authenticated can select classes" ON public.classes;
DROP POLICY IF EXISTS "Admins can insert classes" ON public.classes;
DROP POLICY IF EXISTS "Admins can update classes" ON public.classes;
DROP POLICY IF EXISTS "Admins can delete classes" ON public.classes;

CREATE POLICY "Authenticated can select classes"
  ON public.classes
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can insert classes"
  ON public.classes
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "Admins can update classes"
  ON public.classes
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "Admins can delete classes"
  ON public.classes
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- spaces
DROP POLICY IF EXISTS "Authenticated can select spaces" ON public.spaces;
DROP POLICY IF EXISTS "Admins can insert spaces" ON public.spaces;
DROP POLICY IF EXISTS "Admins can update spaces" ON public.spaces;
DROP POLICY IF EXISTS "Admins can delete spaces" ON public.spaces;

CREATE POLICY "Authenticated can select spaces"
  ON public.spaces
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can insert spaces"
  ON public.spaces
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "Admins can update spaces"
  ON public.spaces
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "Admins can delete spaces"
  ON public.spaces
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- timetable_slots
DROP POLICY IF EXISTS "Authenticated can select timetable_slots" ON public.timetable_slots;
DROP POLICY IF EXISTS "Admins can insert timetable_slots" ON public.timetable_slots;
DROP POLICY IF EXISTS "Admins can update timetable_slots" ON public.timetable_slots;
DROP POLICY IF EXISTS "Admins can delete timetable_slots" ON public.timetable_slots;

CREATE POLICY "Authenticated can select timetable_slots"
  ON public.timetable_slots
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can insert timetable_slots"
  ON public.timetable_slots
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "Admins can update timetable_slots"
  ON public.timetable_slots
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "Admins can delete timetable_slots"
  ON public.timetable_slots
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- timetable_slot_teachers
DROP POLICY IF EXISTS "Authenticated can select timetable_slot_teachers" ON public.timetable_slot_teachers;
DROP POLICY IF EXISTS "Admins can insert timetable_slot_teachers" ON public.timetable_slot_teachers;
DROP POLICY IF EXISTS "Admins can delete timetable_slot_teachers" ON public.timetable_slot_teachers;

CREATE POLICY "Authenticated can select timetable_slot_teachers"
  ON public.timetable_slot_teachers
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can insert timetable_slot_teachers"
  ON public.timetable_slot_teachers
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "Admins can delete timetable_slot_teachers"
  ON public.timetable_slot_teachers
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- timetable_slot_parts
DROP POLICY IF EXISTS "Authenticated can select timetable_slot_parts" ON public.timetable_slot_parts;
DROP POLICY IF EXISTS "Admins can insert timetable_slot_parts" ON public.timetable_slot_parts;
DROP POLICY IF EXISTS "Admins can update timetable_slot_parts" ON public.timetable_slot_parts;
DROP POLICY IF EXISTS "Admins can delete timetable_slot_parts" ON public.timetable_slot_parts;

CREATE POLICY "Authenticated can select timetable_slot_parts"
  ON public.timetable_slot_parts FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can insert timetable_slot_parts"
  ON public.timetable_slot_parts FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY "Admins can update timetable_slot_parts"
  ON public.timetable_slot_parts FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "Admins can delete timetable_slot_parts"
  ON public.timetable_slot_parts FOR DELETE TO authenticated USING (public.is_admin());

-- timetable_slot_part_teachers
DROP POLICY IF EXISTS "Authenticated can select timetable_slot_part_teachers" ON public.timetable_slot_part_teachers;
DROP POLICY IF EXISTS "Admins can insert timetable_slot_part_teachers" ON public.timetable_slot_part_teachers;
DROP POLICY IF EXISTS "Admins can delete timetable_slot_part_teachers" ON public.timetable_slot_part_teachers;

CREATE POLICY "Authenticated can select timetable_slot_part_teachers"
  ON public.timetable_slot_part_teachers FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can insert timetable_slot_part_teachers"
  ON public.timetable_slot_part_teachers FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY "Admins can delete timetable_slot_part_teachers"
  ON public.timetable_slot_part_teachers FOR DELETE TO authenticated USING (public.is_admin());

-- teacher_classes
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
  WITH CHECK (teacher_id = auth.uid());

CREATE POLICY "Teachers can delete own teacher_classes"
  ON public.teacher_classes
  FOR DELETE
  TO authenticated
  USING (teacher_id = auth.uid());

-- reservations
DROP POLICY IF EXISTS "Authenticated can select reservations" ON public.reservations;
DROP POLICY IF EXISTS "Teachers and admins can insert reservations" ON public.reservations;
DROP POLICY IF EXISTS "Teachers and admins can update reservations" ON public.reservations;
DROP POLICY IF EXISTS "Teachers and admins can delete reservations" ON public.reservations;

CREATE POLICY "Authenticated can select reservations"
  ON public.reservations
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Teachers and admins can insert reservations"
  ON public.reservations
  FOR INSERT
  TO authenticated
  WITH CHECK (teacher_id = auth.uid() OR public.is_admin());

CREATE POLICY "Teachers and admins can update reservations"
  ON public.reservations
  FOR UPDATE
  TO authenticated
  USING (teacher_id = auth.uid() OR public.is_admin())
  WITH CHECK (teacher_id = auth.uid() OR public.is_admin());

CREATE POLICY "Teachers and admins can delete reservations"
  ON public.reservations
  FOR DELETE
  TO authenticated
  USING (teacher_id = auth.uid() OR public.is_admin());

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.classes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.spaces TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.timetable_slots TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.timetable_slot_teachers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.timetable_slot_parts TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.timetable_slot_part_teachers TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.teacher_classes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reservations TO authenticated;

-- ---------------------------------------------------------------------------
-- Verification (manual — uncomment to run)
-- ---------------------------------------------------------------------------
-- (1) All timetable slots for a grade:
-- SELECT ts.*, c.name AS class_name
-- FROM public.timetable_slots ts
-- JOIN public.classes c ON c.id = ts.class_id
-- WHERE ts.grade = '10mo'::public.grade
-- ORDER BY ts.day, ts.start_time;
--
-- (2) Spaces still free for a given day + start_time (not yet reserved):
-- SELECT s.*
-- FROM public.spaces s
-- WHERE NOT EXISTS (
--   SELECT 1
--   FROM public.reservations r
--   WHERE r.space_id = s.id
--     AND r.day = 'lunes'::public.weekday
--     AND r.start_time = '08:00'::time
-- )
-- ORDER BY s.sort_order;

-- ---------------------------------------------------------------------------
-- First admin (one-time — replace email, run in SQL Editor)
-- ---------------------------------------------------------------------------
-- UPDATE public.profiles
-- SET role = 'admin'
-- WHERE id = (
--   SELECT id FROM auth.users WHERE email = 'you@example.com'
-- );
