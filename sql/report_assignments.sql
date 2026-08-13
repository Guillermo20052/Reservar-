-- ASSIGNMENT AUDIT — read-only report for the admin.
--
-- Purpose: see the FULL current teacher-assignment truth, one row per
-- slot-teacher (single slots) or part-teacher (multi slots), to spot crossed
-- assignments (e.g. the chemistry teacher listed on a History slot).
--
-- Run manually in the Supabase SQL Editor. Nothing here modifies data.

-- ---------------------------------------------------------------------------
-- 1) Every slot (and every part of multi slots) with its assigned teacher(s).
--    Slots/parts with NO assigned teacher appear with teacher = '— SIN ASIGNAR'.
-- ---------------------------------------------------------------------------
SELECT
  ts.grade,
  ts.day,
  ts.start_time,
  ts.end_time,
  COALESCE(pc.name, c.name)                                   AS class_name,
  ts.is_multi,
  CASE
    WHEN tsp.part_index IS NOT NULL
    THEN 'Parte ' || substr('ABCDE', tsp.part_index, 1)
    ELSE ''
  END                                                          AS part,
  COALESCE(pn.full_name, '— SIN ASIGNAR')                      AS teacher,
  ts.id                                                        AS slot_id
FROM public.timetable_slots ts
LEFT JOIN public.classes c ON c.id = ts.class_id
-- multi slots: one row per part (and per teacher of that part)
LEFT JOIN public.timetable_slot_parts tsp ON ts.is_multi AND tsp.slot_id = ts.id
LEFT JOIN public.classes pc ON pc.id = tsp.class_id
LEFT JOIN public.timetable_slot_part_teachers tspt ON tspt.part_id = tsp.id
-- single slots: one row per slot-level teacher
LEFT JOIN public.timetable_slot_teachers tst
  ON NOT ts.is_multi AND tst.slot_id = ts.id
LEFT JOIN public.profile_names pn
  ON pn.id = COALESCE(tspt.teacher_id, tst.teacher_id)
ORDER BY
  ts.grade,
  array_position(ARRAY['lunes','martes','miercoles','jueves','viernes'], ts.day),
  ts.start_time,
  part,
  teacher;

-- ---------------------------------------------------------------------------
-- 2) Orphan check: junction rows pointing at a teacher_id with NO profiles row.
--    Should return ZERO rows (both junctions cascade on profile delete) —
--    anything listed here is corrupt and explains ghosts in pickers.
-- ---------------------------------------------------------------------------
SELECT 'timetable_slot_teachers' AS junction, tst.slot_id::text AS ref, tst.teacher_id
FROM public.timetable_slot_teachers tst
WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = tst.teacher_id)
UNION ALL
SELECT 'timetable_slot_part_teachers', tspt.part_id::text, tspt.teacher_id
FROM public.timetable_slot_part_teachers tspt
WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = tspt.teacher_id);
