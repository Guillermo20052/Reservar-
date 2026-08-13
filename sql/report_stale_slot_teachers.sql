-- Report: stale SLOT-LEVEL teacher rows on MULTI slots.
--
-- A slot that is_multi = true gets its teachers from timetable_slot_part_teachers
-- (one set per part). Any row still in timetable_slot_teachers for such a slot is
-- a leftover from before the slot was converted to multi (older sync code didn't
-- clean the opposite direction). Symptom: the teacher's "Reservar mi espacio"
-- pick list showed the same class twice — once part-less, once as "Parte A" —
-- in app versions that listed multi slots through both junctions.
--
-- The current JS already refuses to display these rows AND deletes them on the
-- next admin save of the slot; this report is for cleaning the ones already in
-- the database.
--
-- Run the SELECT manually in the Supabase SQL Editor and review the rows.
-- Nothing here modifies data — the DELETE below is commented out on purpose.

SELECT
  tst.slot_id,
  c.name        AS class_name,
  ts.grade,
  ts.day,
  ts.start_time,
  ts.end_time,
  pn.full_name  AS teacher_name
FROM public.timetable_slot_teachers tst
JOIN public.timetable_slots ts ON ts.id = tst.slot_id
LEFT JOIN public.classes c ON c.id = ts.class_id
LEFT JOIN public.profile_names pn ON pn.id = tst.teacher_id
WHERE ts.is_multi = true
ORDER BY ts.grade, ts.day, ts.start_time, pn.full_name;

-- ---------------------------------------------------------------------------
-- AFTER REVIEWING the rows above, uncomment and run this block to delete
-- exactly those rows (slot-level teacher rows whose slot is multi). It touches
-- nothing else: part teachers, single-slot teachers, and reservations are
-- unaffected.
-- ---------------------------------------------------------------------------
-- BEGIN;
--
-- DELETE FROM public.timetable_slot_teachers tst
-- USING public.timetable_slots ts
-- WHERE ts.id = tst.slot_id
--   AND ts.is_multi = true;
--
-- COMMIT;
