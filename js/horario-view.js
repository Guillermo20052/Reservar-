import { supabase } from './supabase.js';
import {
  displayWeekStart,
  weekDays,
  todayIndexIn,
  formatWeekRange,
} from './week-utils.js';

const GRADES = ['10mo', '11vo', '12vo'];
const WEEKDAYS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'];

const WEEKDAY_LABELS = {
  lunes: 'Lunes',
  martes: 'Martes',
  miercoles: 'Miércoles',
  jueves: 'Jueves',
  viernes: 'Viernes',
};

export { GRADES };

/**
 * The grid is rendered by an *instance* so the same code can be mounted more
 * than once on a page (the Horario tab shows one grade with a selector; the
 * Horario general tab stacks all three). Every DOM id is namespaced with the
 * instance prefix and every instance owns its own Realtime channel.
 *
 * @typedef {{
 *   prefix: string,
 *   channelName: string,
 *   grade: string,
 *   showGradeSelect: boolean,
 *   showPlanoLink: boolean,
 *   title: string | null,
 *   weekStart: string,
 *   slots: object[],
 *   session: object | null,
 *   spaceBySlotId: Record<string, string[]>,
 *   spaceByPartId: Record<string, string[]>,
 *   teacherNames: Record<string, string>,
 *   channel: object | null,
 *   debounceTimer: ReturnType<typeof setTimeout> | null,
 * }} HorarioInstance
 */

/** Live instances, so a re-mount can tear down its predecessors. */
const instances = new Map();

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(time) {
  if (!time) return '';
  return String(time).slice(0, 5);
}

function timeToMinutes(time) {
  const [h, m] = formatTime(time).split(':').map(Number);
  return h * 60 + m;
}

function showAlert(inst, message) {
  const el = document.getElementById(`${inst.prefix}-alert`);
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function hideAlert(inst) {
  const el = document.getElementById(`${inst.prefix}-alert`);
  if (el) el.hidden = true;
}

function unsubscribeChannel(inst) {
  if (inst.channel) {
    supabase.removeChannel(inst.channel);
    inst.channel = null;
  }
}

function cleanup(inst) {
  unsubscribeChannel(inst);
  if (inst.debounceTimer) {
    clearTimeout(inst.debounceTimer);
    inst.debounceTimer = null;
  }
}

async function fetchProfileNameMap(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const { data, error } = await supabase
    .from('profile_names')
    .select('id, full_name')
    .in('id', unique);
  if (error) throw error;
  /** @type {Record<string, string>} */
  const map = {};
  for (const row of data ?? []) {
    map[row.id] = row.full_name;
  }
  return map;
}

function slotTeacherIds(slot) {
  const rows = slot.timetable_slot_teachers ?? [];
  const fromJunction = rows.map((row) => row.teacher_id).filter(Boolean);
  if (fromJunction.length) return fromJunction;
  if (slot.teacher_id) return [slot.teacher_id];
  return [];
}

function partTeacherIds(part) {
  return (part.timetable_slot_part_teachers ?? []).map((row) => row.teacher_id).filter(Boolean);
}

function normalizeSlot(slot) {
  const parts = (slot.timetable_slot_parts ?? [])
    .slice()
    .sort((a, b) => a.part_index - b.part_index)
    .map((part) => ({
      id: part.id,
      part_index: part.part_index,
      class_name: part.classes?.name || 'Clase',
      teacher_ids: partTeacherIds(part),
    }));
  const isMulti = Boolean(slot.is_multi) && parts.length > 0;
  return {
    ...slot,
    is_multi: isMulti,
    parts,
    teacher_ids: isMulti ? [] : slotTeacherIds(slot),
  };
}

async function fetchSlots(grade) {
  const { data, error } = await supabase
    .from('timetable_slots')
    .select(`
      id, teacher_id, grade, day, start_time, end_time, is_multi, classes(name),
      timetable_slot_teachers(teacher_id),
      timetable_slot_parts(
        id, part_index, classes(name),
        timetable_slot_part_teachers(teacher_id)
      )
    `)
    .eq('grade', grade)
    .order('day')
    .order('start_time');

  if (error) {
    const { data: legacy, error: legacyError } = await supabase
      .from('timetable_slots')
      .select('id, teacher_id, grade, day, start_time, end_time, is_multi, classes(name)')
      .eq('grade', grade)
      .order('day')
      .order('start_time');
    if (legacyError) throw legacyError;
    return (legacy ?? []).map((slot) => normalizeSlot({ ...slot, timetable_slot_parts: [] }));
  }

  return (data ?? []).map(normalizeSlot);
}

/**
 * The draft session for the week the grid is showing (newest first, whatever
 * its phase) — used only to decide whether the "draft en curso" banner shows.
 * Weeks are the unit now, so this no longer looks at "the newest session
 * anywhere": a draft being prepared for a future week must not put a banner on
 * this week's grid.
 */
async function fetchWeekSession(weekStart) {
  const { data, error } = await supabase
    .from('draft_sessions')
    .select('id, phase, week_start, created_at')
    .eq('week_start', weekStart)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Confirmed picks for the displayed week, straight off reservations.week_start. */
async function fetchConfirmedReservations(weekStart) {
  const { data, error } = await supabase
    .from('reservations')
    .select('slot_id, slot_part_id, space_id, spaces(name)')
    .eq('week_start', weekStart)
    .eq('confirmed', true);
  if (error) throw error;
  return data ?? [];
}

function buildSpaceMaps(reservations) {
  /** @type {Record<string, string[]>} */
  const bySlot = {};
  /** @type {Record<string, string[]>} */
  const byPart = {};
  for (const r of reservations) {
    const name = r.spaces?.name || '—';
    if (r.slot_part_id) {
      if (!byPart[r.slot_part_id]) byPart[r.slot_part_id] = [];
      byPart[r.slot_part_id].push(name);
    } else if (r.slot_id) {
      if (!bySlot[r.slot_id]) bySlot[r.slot_id] = [];
      bySlot[r.slot_id].push(name);
    }
  }
  return { bySlot, byPart };
}

function formatSpaceList(names) {
  if (!names?.length) return null;
  return names.join(', ');
}

function buildPanelShell(inst) {
  const heading = inst.title === null
    ? ''
    : `<h2 class="panel-title">${escapeHtml(inst.title)}</h2>`;

  const planoLink = inst.showPlanoLink
    ? `
    <section class="horario-view-plano-link">
      <a class="btn btn-ghost horario-view-plano-btn" href="/#plano">Ver plano interactivo</a>
      <p class="horario-view-plano-note">Consulta el mapa de espacios en la guía pedagógica.</p>
    </section>`
    : '';

  const gradeSelect = inst.showGradeSelect
    ? `
    <section class="horario-view-section">
      <label class="horario-view-grade-label" for="${inst.prefix}-grade">Grado</label>
      <select class="input horario-grade-select" id="${inst.prefix}-grade">
        ${GRADES.map((g) => `<option value="${g}">${g}</option>`).join('')}
      </select>
    </section>`
    : '';

  return `
    ${heading}
    <div id="${inst.prefix}-alert" class="alert alert-error" hidden></div>
    <div id="${inst.prefix}-draft-banner" class="horario-view-draft-banner" hidden></div>
    ${planoLink}
    ${gradeSelect}
    <section class="horario-view-section">
      <p id="${inst.prefix}-week-label" class="horario-week-label"></p>
      <div id="${inst.prefix}-grid" class="horario-grid"></div>
    </section>
  `;
}

function renderDraftBanner(inst) {
  const banner = document.getElementById(`${inst.prefix}-draft-banner`);
  if (!banner) return;

  if (inst.session && (inst.session.phase === 'live' || inst.session.phase === 'open')) {
    banner.hidden = false;
    banner.textContent = 'Draft en curso — los espacios aparecen al confirmarse.';
  } else {
    banner.hidden = true;
    banner.textContent = '';
  }
}

function renderGrid(inst) {
  const grid = document.getElementById(`${inst.prefix}-grid`);
  if (!grid) return;

  const days = weekDays(inst.weekStart);
  const todayIndex = todayIndexIn(inst.weekStart);
  const weekLabel = document.getElementById(`${inst.prefix}-week-label`);
  if (weekLabel) weekLabel.textContent = formatWeekRange(days);

  grid.innerHTML = WEEKDAYS.map((day, dayIndex) => {
    const daySlots = inst.slots
      .filter((s) => s.day === day)
      .sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time));

    const cards = daySlots.length
      ? daySlots.map((slot) => {
          const timeLine = `<span class="horario-slot-time">${formatTime(slot.start_time)} – ${formatTime(slot.end_time)}</span>`;

          if (slot.is_multi && slot.parts.length) {
            const partsHtml = slot.parts
              .map((part) => {
                const teacher = part.teacher_ids.length
                  ? part.teacher_ids.map((id) => inst.teacherNames[id] || 'Sin asignar').join(', ')
                  : 'Sin asignar';
                const spaceNames = formatSpaceList(inst.spaceByPartId[part.id]);
                const spaceHtml = spaceNames
                  ? `<span class="chip horario-view-space-chip">${escapeHtml(spaceNames)}</span>`
                  : '<span class="chip chip--muted horario-view-space-pending">Espacio por definir</span>';

                return `
                  <div class="horario-multi-part-display">
                    <strong class="horario-slot-class">${escapeHtml(part.class_name)}</strong>
                    <div class="horario-slot-meta">
                      <span class="horario-slot-teacher">${escapeHtml(teacher)}</span>
                    </div>
                    ${spaceHtml}
                  </div>
                `;
              })
              .join('');

            return `
              <article class="horario-slot-card horario-view-slot horario-slot-card-multi">
                <span class="badge horario-multi-badge">Multi</span>
                <div class="horario-slot-main">
                  <div class="horario-multi-split">${partsHtml}</div>
                  ${timeLine}
                </div>
              </article>
            `;
          }

          const className = slot.classes?.name || 'Clase';
          const teacher = slot.teacher_ids.length
            ? slot.teacher_ids.map((id) => inst.teacherNames[id] || 'Sin asignar').join(', ')
            : 'Sin asignar';
          const spaceNames = formatSpaceList(inst.spaceBySlotId[slot.id]);
          const spaceHtml = spaceNames
            ? `<span class="chip horario-view-space-chip">${escapeHtml(spaceNames)}</span>`
            : '<span class="chip chip--muted horario-view-space-pending">Espacio por definir</span>';

          return `
            <article class="horario-slot-card horario-view-slot">
              <div class="horario-slot-main">
                <strong class="horario-slot-class">${escapeHtml(className)}</strong>
                <div class="horario-slot-meta">
                  ${timeLine}
                  <span class="horario-slot-teacher">${escapeHtml(teacher)}</span>
                </div>
                ${spaceHtml}
              </div>
            </article>
          `;
        }).join('')
      : '<p class="horario-day-empty">Sin franjas</p>';

    const isToday = dayIndex === todayIndex;
    const dayNum = days[dayIndex].getUTCDate();
    const todayChip = isToday ? '<span class="horario-today-chip">Hoy</span>' : '';

    return `
      <div class="horario-day-col${isToday ? ' horario-day-col--today' : ''}">
        <h4 class="horario-day-hd">${WEEKDAY_LABELS[day]} ${dayNum}${todayChip}</h4>
        <div class="horario-day-slots">${cards}</div>
      </div>
    `;
  }).join('');
}

async function refresh(inst) {
  hideAlert(inst);
  // Recomputed on every refresh — the displayed week is pure client-side
  // display state, and it is also the key the reservations query uses.
  inst.weekStart = displayWeekStart();
  inst.slots = await fetchSlots(inst.grade);
  inst.teacherNames = await fetchProfileNameMap(
    inst.slots.flatMap((s) => [
      ...s.teacher_ids,
      ...(s.parts ?? []).flatMap((p) => p.teacher_ids),
    ])
  );
  inst.session = await fetchWeekSession(inst.weekStart);

  const reservations = await fetchConfirmedReservations(inst.weekStart);
  const maps = buildSpaceMaps(reservations);
  inst.spaceBySlotId = maps.bySlot;
  inst.spaceByPartId = maps.byPart;

  renderDraftBanner(inst);
  renderGrid(inst);
}

function onRealtimeChange(inst) {
  if (inst.debounceTimer) clearTimeout(inst.debounceTimer);
  inst.debounceTimer = setTimeout(() => {
    refresh(inst).catch((err) => {
      showAlert(inst, err.message || 'No se pudo actualizar el horario.');
    });
  }, 150);
}

function subscribe(inst) {
  unsubscribeChannel(inst);

  inst.channel = supabase
    .channel(inst.channelName)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'reservations' },
      () => onRealtimeChange(inst)
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'draft_sessions' },
      () => onRealtimeChange(inst)
    )
    .subscribe();
}

function wireEvents(inst, root) {
  if (!inst.showGradeSelect) return;
  root.addEventListener('change', async (e) => {
    if (e.target.id !== `${inst.prefix}-grade`) return;
    hideAlert(inst);
    inst.grade = e.target.value;
    try {
      await refresh(inst);
    } catch (err) {
      showAlert(inst, err.message || 'No se pudo cargar el horario.');
    }
  });
}

/**
 * Render one grade grid into `root`. Same markup, same queries, same styling as
 * the Horario tab — only the mount point, the id prefix and the Realtime
 * channel name differ.
 */
export async function mountHorarioGrid({
  root,
  prefix,
  channelName,
  grade = '10mo',
  showGradeSelect = false,
  showPlanoLink = false,
  title = null,
}) {
  const existing = instances.get(prefix);
  if (existing) cleanup(existing);

  /** @type {HorarioInstance} */
  const inst = {
    prefix,
    channelName,
    grade,
    showGradeSelect,
    showPlanoLink,
    title,
    weekStart: displayWeekStart(),
    slots: [],
    session: null,
    spaceBySlotId: {},
    spaceByPartId: {},
    teacherNames: {},
    channel: null,
    debounceTimer: null,
  };
  instances.set(prefix, inst);

  root.innerHTML = buildPanelShell(inst);
  if (showGradeSelect) {
    document.getElementById(`${prefix}-grade`).value = inst.grade;
  }

  wireEvents(inst, root);
  subscribe(inst);

  try {
    await refresh(inst);
  } catch (err) {
    showAlert(inst, err.message || 'No se pudo cargar el horario.');
  }

  return inst;
}

export async function mountHorario(profile) {
  const panel = document.getElementById('panel-horario');
  if (!panel) return;

  await mountHorarioGrid({
    root: panel,
    prefix: 'horario-view',
    channelName: 'horario-view',
    grade: '10mo',
    showGradeSelect: true,
    showPlanoLink: true,
    title: 'Horario',
  });
}
