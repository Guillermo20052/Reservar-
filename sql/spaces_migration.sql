-- One-time migration: teaching spaces catalog 13 → 12 rooms
-- Prerequisites: sql/schema.sql, sql/reservations_schema.sql (spaces table exists)
-- Run in Supabase SQL Editor. Wrapped in a transaction — all or nothing.
--
-- Removes Aether (10) and Nidus (4) from teaching spaces; renames Radices (11) →
-- "Radices 1"; adds Radices 2 (14). Keeps stable ids (no renumbering of 1–13).
-- Nidus as a study space is created separately via the admin UI (study_spaces).
--
-- Audit assumption: zero rows in reservations or study_spaces reference ids 4, 10, or 11.
-- If a future run finds references, DELETE below will RESTRICT-fail and roll back.

BEGIN;

-- Safety re-check (expect 0 for every count)
SELECT
  (SELECT COUNT(*) FROM public.reservations WHERE space_id = 4)  AS reservations_nidus,
  (SELECT COUNT(*) FROM public.reservations WHERE space_id = 10) AS reservations_aether,
  (SELECT COUNT(*) FROM public.reservations WHERE space_id = 11) AS reservations_radices,
  (SELECT COUNT(*) FROM public.study_spaces WHERE space_id = 4)  AS study_spaces_nidus,
  (SELECT COUNT(*) FROM public.study_spaces WHERE space_id = 10) AS study_spaces_aether,
  (SELECT COUNT(*) FROM public.study_spaces WHERE space_id = 11) AS study_spaces_radices;

UPDATE public.spaces
SET name = 'Radices 1', sort_order = 9
WHERE id = 11;

INSERT INTO public.spaces (id, name, sort_order)
VALUES (14, 'Radices 2', 10)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;

DELETE FROM public.spaces WHERE id = 10; -- Aether
DELETE FROM public.spaces WHERE id = 4;   -- Nidus

UPDATE public.spaces
SET sort_order = CASE id
  WHEN 1  THEN 1
  WHEN 2  THEN 2
  WHEN 3  THEN 3
  WHEN 5  THEN 4
  WHEN 6  THEN 5
  WHEN 7  THEN 6
  WHEN 8  THEN 7
  WHEN 9  THEN 8
  WHEN 11 THEN 9
  WHEN 14 THEN 10
  WHEN 12 THEN 11
  WHEN 13 THEN 12
END
WHERE id IN (1, 2, 3, 5, 6, 7, 8, 9, 11, 12, 13, 14);

COMMIT;
