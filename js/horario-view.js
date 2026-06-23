import { supabase } from './supabase.js';

const GRADES = ['10mo', '11vo', '12vo'];
const WEEKDAYS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'];

const WEEKDAY_LABELS = {
  lunes: 'Lunes',
  martes: 'Martes',
  miercoles: 'Miércoles',
  jueves: 'Jueves',
  viernes: 'Viernes',
};

/** @type {{
 *   grade: string,
 *   slots: object[],
 *   session: object | null,
 *   spaceBySlotId: Record<string, string>,
 *   teacherNames: Record<string, string>,
 *   channel: object | null,
 *   debounceTimer: ReturnType<typeof setTimeout> | null,
 * }} */
const state = {
  grade: '10mo',
  slots: [],
  session: null,
  spaceBySlotId: {},
  teacherNames: {},
  channel: null,
  debounceTimer: null,
};

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

function showAlert(message) {
  const el = document.getElementById('horario-view-alert');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function hideAlert() {
  const el = document.getElementById('horario-view-alert');
  if (el) el.hidden = true;
}

function unsubscribeChannel() {
  if (state.channel) {
    supabase.removeChannel(state.channel);
    state.channel = null;
  }
}

function cleanup() {
  unsubscribeChannel();
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
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

async function fetchSlots(grade) {
  const { data, error } = await supabase
    .from('timetable_slots')
    .select('id, teacher_id, grade, day, start_time, end_time, classes(name), timetable_slot_teachers(teacher_id)')
    .eq('grade', grade)
    .order('day')
    .order('start_time');

  if (error) {
    const { data: legacy, error: legacyError } = await supabase
      .from('timetable_slots')
      .select('id, teacher_id, grade, day, start_time, end_time, classes(name)')
      .eq('grade', grade)
      .order('day')
      .order('start_time');
    if (legacyError) throw legacyError;
    return (legacy ?? []).map((slot) => ({
      ...slot,
      teacher_ids: slotTeacherIds(slot),
    }));
  }

  return (data ?? []).map((slot) => ({
    ...slot,
    teacher_ids: slotTeacherIds(slot),
  }));
}

async function fetchSession() {
  const { data: active, error: activeError } = await supabase
    .from('draft_sessions')
    .select('id, phase, created_at')
    .neq('phase', 'closed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeError) throw activeError;
  if (active) return active;

  const { data: latest, error: latestError } = await supabase
    .from('draft_sessions')
    .select('id, phase, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw latestError;
  return latest;
}

async function fetchConfirmedReservations(sessionId) {
  const { data, error } = await supabase
    .from('reservations')
    .select('slot_id, space_id, spaces(name)')
    .eq('session_id', sessionId)
    .eq('confirmed', true);
  if (error) throw error;
  return data ?? [];
}

function buildSpaceBySlotId(reservations) {
  /** @type {Record<string, string>} */
  const map = {};
  for (const r of reservations) {
    if (r.slot_id) {
      map[r.slot_id] = r.spaces?.name || '—';
    }
  }
  return map;
}

function buildPanelShell() {
  return `
    <h2 class="panel-title">Horario</h2>
    <div id="horario-view-alert" class="alert alert-error" hidden></div>
    <div id="horario-view-draft-banner" class="horario-view-draft-banner" hidden></div>
    <section class="horario-view-plano-link">
      <a class="btn btn-ghost horario-view-plano-btn" href="home.html#plano">Ver plano interactivo</a>
      <p class="horario-view-plano-note">Consulta el mapa de espacios en la guía pedagógica.</p>
    </section>
    <section class="horario-view-section">
      <label class="horario-view-grade-label" for="horario-view-grade">Grado</label>
      <select class="input horario-grade-select" id="horario-view-grade">
        ${GRADES.map((g) => `<option value="${g}">${g}</option>`).join('')}
      </select>
    </section>
    <section class="horario-view-section">
      <div id="horario-view-grid" class="horario-grid"></div>
    </section>
  `;
}

function renderDraftBanner() {
  const banner = document.getElementById('horario-view-draft-banner');
  if (!banner) return;

  if (state.session && (state.session.phase === 'live' || state.session.phase === 'open')) {
    banner.hidden = false;
    banner.textContent = 'Draft en curso — los espacios aparecen al confirmarse.';
  } else {
    banner.hidden = true;
    banner.textContent = '';
  }
}

function renderGrid() {
  const grid = document.getElementById('horario-view-grid');
  if (!grid) return;

  grid.innerHTML = WEEKDAYS.map((day) => {
    const daySlots = state.slots
      .filter((s) => s.day === day)
      .sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time));

    const cards = daySlots.length
      ? daySlots.map((slot) => {
          const className = slot.classes?.name || 'Clase';
          const teacher = slot.teacher_ids.length
            ? slot.teacher_ids.map((id) => state.teacherNames[id] || 'Sin asignar').join(', ')
            : 'Sin asignar';
          const spaceName = state.spaceBySlotId[slot.id];
          const spaceHtml = spaceName
            ? `<span class="chip horario-view-space-chip">${escapeHtml(spaceName)}</span>`
            : '<span class="chip chip--muted horario-view-space-pending">Espacio por definir</span>';

          return `
            <article class="horario-slot-card horario-view-slot">
              <div class="horario-slot-main">
                <strong class="horario-slot-class">${escapeHtml(className)}</strong>
                <div class="horario-slot-meta">
                  <span class="horario-slot-time">${formatTime(slot.start_time)} – ${formatTime(slot.end_time)}</span>
                  <span class="horario-slot-teacher">${escapeHtml(teacher)}</span>
                </div>
                ${spaceHtml}
              </div>
            </article>
          `;
        }).join('')
      : '<p class="horario-day-empty">Sin franjas</p>';

    return `
      <div class="horario-day-col">
        <h4 class="horario-day-hd">${WEEKDAY_LABELS[day]}</h4>
        <div class="horario-day-slots">${cards}</div>
      </div>
    `;
  }).join('');
}

async function refresh() {
  hideAlert();
  state.slots = await fetchSlots(state.grade);
  state.teacherNames = await fetchProfileNameMap(
    state.slots.flatMap((s) => s.teacher_ids)
  );
  state.session = await fetchSession();

  if (state.session) {
    const reservations = await fetchConfirmedReservations(state.session.id);
    state.spaceBySlotId = buildSpaceBySlotId(reservations);
  } else {
    state.spaceBySlotId = {};
  }

  renderDraftBanner();
  renderGrid();
}

function onRealtimeChange() {
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    refresh().catch((err) => {
      showAlert(err.message || 'No se pudo actualizar el horario.');
    });
  }, 150);
}

function subscribe() {
  unsubscribeChannel();

  state.channel = supabase
    .channel('horario-view')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'reservations' },
      onRealtimeChange
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'draft_sessions' },
      onRealtimeChange
    )
    .subscribe();
}

function wireEvents(panel) {
  panel.addEventListener('change', async (e) => {
    if (e.target.id !== 'horario-view-grade') return;
    hideAlert();
    state.grade = e.target.value;
    try {
      await refresh();
    } catch (err) {
      showAlert(err.message || 'No se pudo cargar el horario.');
    }
  });
}

export async function mountHorario(profile) {
  const panel = document.getElementById('panel-horario');
  if (!panel) return;

  cleanup();

  state.grade = '10mo';
  state.slots = [];
  state.session = null;
  state.spaceBySlotId = {};
  state.teacherNames = {};

  panel.innerHTML = buildPanelShell();
  document.getElementById('horario-view-grade').value = state.grade;

  wireEvents(panel);
  subscribe();

  try {
    await refresh();
  } catch (err) {
    showAlert(err.message || 'No se pudo cargar el horario.');
  }
}
