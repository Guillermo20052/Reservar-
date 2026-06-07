import { supabase } from './supabase.js';

const GRADES = ['10mo', '11vo', '12vo'];

const WEEKDAY_LABELS = {
  lunes: 'Lunes',
  martes: 'Martes',
  miercoles: 'Miércoles',
  jueves: 'Jueves',
  viernes: 'Viernes',
};

/** @type {{
 *   profile: object | null,
 *   grade: string,
 *   session: object | null,
 *   reservations: object[],
 *   teacherNames: Record<string, string>,
 *   reservationsChannel: object | null,
 *   debounceTimer: ReturnType<typeof setTimeout> | null,
 * }} */
const state = {
  profile: null,
  grade: '10mo',
  session: null,
  reservations: [],
  teacherNames: {},
  reservationsChannel: null,
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

function showReservacionesAlert(message) {
  const el = document.getElementById('student-reservaciones-alert');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function hideReservacionesAlert() {
  const el = document.getElementById('student-reservaciones-alert');
  if (el) el.hidden = true;
}

function unsubscribeReservations() {
  if (state.reservationsChannel) {
    supabase.removeChannel(state.reservationsChannel);
    state.reservationsChannel = null;
  }
}

function cleanup() {
  unsubscribeReservations();
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
    .select(`
      slot_id, space_id, day, start_time, confirmed,
      spaces(name),
      timetable_slots(id, grade, day, start_time, end_time, teacher_id, classes(name))
    `)
    .eq('session_id', sessionId)
    .eq('confirmed', true)
    .order('day')
    .order('start_time');
  if (error) throw error;
  return data ?? [];
}

function buildReservacionesShell() {
  return `
    <h2 class="panel-title">Reservaciones</h2>
    <div id="student-reservaciones-alert" class="alert alert-error" hidden></div>
    <div id="student-reservaciones-banner" hidden></div>
    <section class="student-section">
      <label class="student-grade-label" for="student-reservaciones-grade">Grado</label>
      <select class="input horario-grade-select" id="student-reservaciones-grade">
        ${GRADES.map((g) => `<option value="${g}">${g}</option>`).join('')}
      </select>
    </section>
    <section class="student-section">
      <div id="student-reservaciones-list"></div>
    </section>
  `;
}

function renderReservacionesList() {
  const banner = document.getElementById('student-reservaciones-banner');
  const list = document.getElementById('student-reservaciones-list');
  if (!banner || !list) return;

  if (state.session && (state.session.phase === 'live' || state.session.phase === 'open')) {
    banner.hidden = false;
    banner.className = 'student-draft-banner';
    banner.textContent = 'Reservaciones en curso — se muestran solo las confirmadas.';
  } else {
    banner.hidden = true;
    banner.textContent = '';
  }

  if (!state.session) {
    list.innerHTML = '<p class="student-empty">Aún no hay reservaciones.</p>';
    return;
  }

  const gradeSelect = document.getElementById('student-reservaciones-grade');
  const grade = gradeSelect?.value || state.grade;

  const filtered = state.reservations.filter(
    (r) => r.timetable_slots?.grade === grade
  );

  if (!filtered.length) {
    list.innerHTML = '<p class="student-empty">No hay reservaciones confirmadas para este grado.</p>';
    return;
  }

  list.innerHTML = `
    <ul class="student-reserva-list">
      ${filtered.map((r) => {
        const slot = r.timetable_slots;
        const className = slot?.classes?.name || 'Clase';
        const teacher = slot?.teacher_id
          ? (state.teacherNames[slot.teacher_id] || 'Sin asignar')
          : 'Sin asignar';
        const spaceName = r.spaces?.name || '—';
        const dayLabel = WEEKDAY_LABELS[slot?.day || r.day] || r.day;
        const timeRange = `${formatTime(slot?.start_time || r.start_time)} – ${formatTime(slot?.end_time)}`;

        return `
          <li class="student-reserva-item">
            <div class="student-reserva-main">
              <strong class="student-reserva-class">${escapeHtml(className)}</strong>
              <span class="student-reserva-meta">${escapeHtml(slot?.grade || '')} · ${dayLabel} · ${timeRange}</span>
              <span class="student-reserva-teacher">${escapeHtml(teacher)}</span>
            </div>
            <span class="student-reserva-space">${escapeHtml(spaceName)}</span>
          </li>
        `;
      }).join('')}
    </ul>
  `;
}

async function refreshReservaciones() {
  hideReservacionesAlert();
  state.session = await fetchSession();

  if (!state.session) {
    state.reservations = [];
    state.teacherNames = {};
    renderReservacionesList();
    return;
  }

  state.reservations = await fetchConfirmedReservations(state.session.id);
  state.teacherNames = await fetchProfileNameMap(
    state.reservations.map((r) => r.timetable_slots?.teacher_id)
  );
  renderReservacionesList();
}

function onRealtimeChange() {
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    refreshReservaciones().catch((err) => {
      showReservacionesAlert(err.message || 'No se pudo actualizar las reservaciones.');
    });
  }, 150);
}

function subscribeReservations() {
  unsubscribeReservations();

  state.reservationsChannel = supabase
    .channel('student-reservations-panel')
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

function wireReservacionesEvents(panel) {
  panel.addEventListener('change', async (e) => {
    if (e.target.id !== 'student-reservaciones-grade') return;
    hideReservacionesAlert();
    state.grade = e.target.value;
    renderReservacionesList();
  });
}

export async function mountStudentViews(profile) {
  if (profile.role !== 'student') return;

  cleanup();

  const reservacionesPanel = document.getElementById('panel-reservaciones');
  if (!reservacionesPanel) return;

  state.profile = profile;
  state.grade = '10mo';
  state.session = null;
  state.reservations = [];
  state.teacherNames = {};

  reservacionesPanel.innerHTML = buildReservacionesShell();

  document.getElementById('student-reservaciones-grade').value = state.grade;

  wireReservacionesEvents(reservacionesPanel);
  subscribeReservations();

  try {
    await refreshReservaciones();
  } catch (err) {
    showReservacionesAlert(err.message || 'No se pudo cargar las reservaciones.');
  }
}
