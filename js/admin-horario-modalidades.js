/**
 * Admin-only "Horario con modalidades" tab.
 *
 * The same weekly grid as the Horario tab (mountHorarioGrid: grade selector,
 * class, day, time, teacher, confirmed space), plus a week selector and, on
 * every class card, the Nair modalities its teacher saved for that week
 * (number + name) or "Sin modalidades".
 *
 * Modality data comes only from public.class_modalities (what teachers saved
 * through set_class_modalities) and names from public.modalities. The regular
 * Horario never loads this module, so it never fetches either table.
 */
import { supabase } from './supabase.js';
import { mountHorarioGrid } from './horario-view.js';

/** @type {Map<number, string>} */
let catalog = new Map();

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadCatalog() {
  const { data, error } = await supabase
    .from('modalities')
    .select('id, name')
    .order('id');
  if (error) throw error;
  catalog = new Map((data ?? []).map((m) => [Number(m.id), m.name]));
}

/**
 * Saved modality sets for the displayed week and grade, keyed by slot (single
 * classes) or part (multi classes). One class can have a row per teacher.
 */
async function loadModalities(inst) {
  inst.modsBySlot = {};
  inst.modsByPart = {};
  const slotIds = inst.slots.map((s) => s.id);
  if (!slotIds.length) return;

  const { data, error } = await supabase
    .from('class_modalities')
    .select('slot_id, slot_part_id, teacher_id, modality_ids')
    .eq('week_start', inst.weekStart)
    .in('slot_id', slotIds);
  if (error) throw error;

  for (const row of data ?? []) {
    const target = row.slot_part_id ? inst.modsByPart : inst.modsBySlot;
    const key = row.slot_part_id || row.slot_id;
    if (!target[key]) target[key] = [];
    target[key].push({
      teacher_id: row.teacher_id,
      ids: (row.modality_ids ?? []).map(Number).sort((a, b) => a - b),
    });
  }
}

function chipsHtml(ids) {
  return ids
    .map((id) => {
      const name = catalog.get(id) ?? `Modalidad ${id}`;
      return `<span class="chip horario-mod-chip"><span class="horario-mod-num">${id}</span>${escapeHtml(name)}</span>`;
    })
    .join('');
}

function renderSets(inst, sets, teacherCount) {
  if (!sets?.length) {
    return '<div class="horario-mod-block"><span class="chip chip--muted horario-mod-empty">Sin modalidades</span></div>';
  }
  // Co-taught class: label each teacher's set so they can't be confused.
  const labelled = sets.length > 1 || teacherCount > 1;
  const groups = sets
    .map((set) => {
      const who = labelled
        ? `<span class="horario-mod-teacher">${escapeHtml(inst.teacherNames[set.teacher_id] || 'Maestra')}</span>`
        : '';
      return `<div class="horario-mod-chips">${who}${chipsHtml(set.ids)}</div>`;
    })
    .join('');
  return `<div class="horario-mod-block" aria-label="Modalidades de enseñanza">${groups}</div>`;
}

const cardExtras = {
  load: loadModalities,
  renderSlot: (inst, slot) => renderSets(inst, inst.modsBySlot?.[slot.id], slot.teacher_ids.length),
  renderPart: (inst, _slot, part) => renderSets(inst, inst.modsByPart?.[part.id], part.teacher_ids.length),
};

export async function mountHorarioModalidades(profile) {
  if (profile?.role !== 'admin') return;
  const panel = document.getElementById('panel-horario-con-modalidades');
  if (!panel) return;

  try {
    await loadCatalog();
  } catch (_) {
    catalog = new Map();
  }

  await mountHorarioGrid({
    root: panel,
    prefix: 'horario-mods',
    channelName: 'horario-mods',
    grade: '10mo',
    showGradeSelect: true,
    showWeekSelect: true,
    cardExtras,
    title: 'Horario con modalidades',
  });
}
