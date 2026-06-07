import { supabase } from './supabase.js';

const STATUS_LABELS = {
  pending: 'Pendiente',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  cancelled: 'Cancelada',
};

const DURATION_LABELS = {
  30: '30 min',
  60: '1 h',
  120: '2 h',
};

const STUDENT_DAILY_CAP_MIN = 120;

/** @type {{
 *   profile: object | null,
 *   studySpaces: object[],
 *   ownBookings: object[],
 *   takenBookings: object[],
 *   channel: object | null,
 *   debounceTimer: ReturnType<typeof setTimeout> | null,
 * }} */
const state = {
  profile: null,
  studySpaces: [],
  ownBookings: [],
  takenBookings: [],
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

function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).split('-');
  if (!y || !m || !d) return dateStr;
  return `${d}/${m}/${y}`;
}

function durationLabel(minutes) {
  return DURATION_LABELS[minutes] || `${minutes} min`;
}

function linkedRoomName(space) {
  return space?.spaces?.name ?? null;
}

function spaceSelectLabel(space) {
  const linked = linkedRoomName(space);
  const suffix = linked ? ` (misma sala: ${linked})` : '';
  return `${space.name}${suffix}`;
}

function endTimeFromStart(start, durationMin) {
  const [h, m] = formatTime(start).split(':').map(Number);
  const total = h * 60 + m + durationMin;
  const eh = Math.floor(total / 60) % 24;
  const em = total % 60;
  return `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
}

function showAlert(message) {
  const el = document.getElementById('study-book-alert');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function hideAlert() {
  const el = document.getElementById('study-book-alert');
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

function getFormSelection() {
  const spaceId = document.getElementById('study-book-space')?.value || '';
  const date = document.getElementById('study-book-date')?.value || '';
  return { spaceId, date };
}

async function fetchActiveStudySpaces() {
  const { data, error } = await supabase
    .from('study_spaces')
    .select('id, name, space_id, spaces(name)')
    .eq('active', true)
    .order('name');
  if (error) throw error;
  return data ?? [];
}

async function fetchOwnBookings() {
  const { data, error } = await supabase
    .from('study_bookings')
    .select(`
      id, study_space_id, booking_date, start_time, duration_min, status, created_at,
      study_spaces ( name, space_id, spaces(name) )
    `)
    .eq('requester_id', state.profile.id)
    .order('booking_date', { ascending: false })
    .order('start_time', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

async function fetchTakenBookings(spaceId, date) {
  const { data, error } = await supabase
    .from('study_bookings')
    .select('id, start_time, duration_min, status')
    .eq('study_space_id', spaceId)
    .eq('booking_date', date)
    .in('status', ['pending', 'approved'])
    .order('start_time');
  if (error) throw error;
  return data ?? [];
}

function studentMinutesUsedOnDate(date) {
  return state.ownBookings
    .filter(
      (b) =>
        b.booking_date === date &&
        (b.status === 'pending' || b.status === 'approved')
    )
    .reduce((sum, b) => sum + b.duration_min, 0);
}

function buildPanelShell() {
  return `
    <h2 class="panel-title">Espacios de estudio</h2>
    <div id="study-book-alert" class="alert alert-error" hidden></div>

    <section class="study-book-section">
      <h3 class="study-book-section-title">Solicitar espacio</h3>
      <form id="study-book-form" class="study-book-form">
        <div class="form-group study-book-field">
          <label for="study-book-space">Espacio</label>
          <select class="input" id="study-book-space" required>
            <option value="">Selecciona un espacio</option>
          </select>
        </div>
        <div class="form-group study-book-field">
          <label for="study-book-date">Fecha</label>
          <input class="input" id="study-book-date" type="date" required>
        </div>
        <div class="form-group study-book-field">
          <label for="study-book-start">Hora de inicio</label>
          <input class="input" id="study-book-start" type="time" required>
        </div>
        <div class="form-group study-book-field">
          <label for="study-book-duration">Duración</label>
          <select class="input" id="study-book-duration" required>
            <option value="30">30 min</option>
            <option value="60">1 h</option>
            <option value="120">2 h</option>
          </select>
        </div>
        <div id="study-book-student-cap" class="study-book-student-cap" hidden></div>
        <div id="study-book-taken-wrap" class="study-book-taken-wrap" hidden>
          <p class="study-book-taken-title">Horarios ocupados en esta fecha</p>
          <ul id="study-book-taken-list" class="study-book-taken-list"></ul>
        </div>
        <button type="submit" class="btn btn-primary">Solicitar</button>
      </form>
    </section>

    <section class="study-book-section">
      <h3 class="study-book-section-title">Mis solicitudes</h3>
      <div id="study-book-own-list" class="study-book-own-list"></div>
    </section>
  `;
}

function populateSpaceSelect() {
  const select = document.getElementById('study-book-space');
  if (!select) return;
  const current = select.value;
  select.innerHTML = [
    '<option value="">Selecciona un espacio</option>',
    ...state.studySpaces.map(
      (s) => `<option value="${s.id}">${escapeHtml(spaceSelectLabel(s))}</option>`
    ),
  ].join('');
  if (current && state.studySpaces.some((s) => String(s.id) === current)) {
    select.value = current;
  }
}

function renderTakenTimes() {
  const wrap = document.getElementById('study-book-taken-wrap');
  const list = document.getElementById('study-book-taken-list');
  if (!wrap || !list) return;

  const { spaceId, date } = getFormSelection();
  if (!spaceId || !date) {
    wrap.hidden = true;
    list.innerHTML = '';
    return;
  }

  wrap.hidden = false;

  if (!state.takenBookings.length) {
    list.innerHTML = '<li class="study-book-taken-empty">No hay reservaciones en este espacio para esta fecha.</li>';
    return;
  }

  list.innerHTML = state.takenBookings.map((b) => {
    const start = formatTime(b.start_time);
    const end = endTimeFromStart(b.start_time, b.duration_min);
    const statusNote = b.status === 'pending' ? ' (pendiente)' : '';
    return `<li class="study-book-taken-item">${start} – ${end} · ${durationLabel(b.duration_min)}${statusNote}</li>`;
  }).join('');
}

function renderStudentCap() {
  const el = document.getElementById('study-book-student-cap');
  if (!el) return;

  if (state.profile?.role !== 'student') {
    el.hidden = true;
    el.textContent = '';
    return;
  }

  const { date } = getFormSelection();
  if (!date) {
    el.hidden = true;
    el.textContent = '';
    return;
  }

  const used = studentMinutesUsedOnDate(date);
  const remaining = Math.max(0, STUDENT_DAILY_CAP_MIN - used);
  el.textContent = `Te quedan ${remaining} min hoy`;
  el.hidden = false;
}

function bookingLinkedLine(booking) {
  const linked =
    booking.study_spaces?.spaces?.name ??
    (booking.study_spaces?.space_id ? `Sala #${booking.study_spaces.space_id}` : null);
  return linked
    ? `<span class="study-book-own-linked">Misma sala: ${escapeHtml(linked)}</span>`
    : '';
}

function renderOwnBookings() {
  const root = document.getElementById('study-book-own-list');
  if (!root) return;

  if (!state.ownBookings.length) {
    root.innerHTML = '<p class="study-book-empty">No tienes solicitudes.</p>';
    return;
  }

  root.innerHTML = state.ownBookings.map((booking) => {
    const spaceName = booking.study_spaces?.name || 'Espacio';
    const statusClass = `study-book-status-${booking.status}`;
    const canCancel = booking.status === 'pending' || booking.status === 'approved';
    const cancelBtn = canCancel
      ? `<button type="button" class="btn btn-ghost study-book-btn-sm" data-cancel-booking="${booking.id}">Cancelar</button>`
      : '';

    return `
      <article class="study-book-own-row">
        <div class="study-book-own-main">
          <strong class="study-book-own-space">${escapeHtml(spaceName)}</strong>
          ${bookingLinkedLine(booking)}
          <span class="study-book-own-when">
            ${formatDate(booking.booking_date)} · ${formatTime(booking.start_time)} · ${durationLabel(booking.duration_min)}
          </span>
          <span class="study-book-badge study-book-status-badge ${statusClass}">${STATUS_LABELS[booking.status] || booking.status}</span>
        </div>
        ${cancelBtn ? `<div class="study-book-own-actions">${cancelBtn}</div>` : ''}
      </article>
    `;
  }).join('');
}

async function refreshTakenAndCap() {
  const { spaceId, date } = getFormSelection();

  if (spaceId && date) {
    state.takenBookings = await fetchTakenBookings(spaceId, date);
  } else {
    state.takenBookings = [];
  }

  renderTakenTimes();
  renderStudentCap();
}

async function refreshAll() {
  hideAlert();
  state.studySpaces = await fetchActiveStudySpaces();
  state.ownBookings = await fetchOwnBookings();

  populateSpaceSelect();
  await refreshTakenAndCap();
  renderOwnBookings();
}

async function handleFormChange() {
  try {
    await refreshTakenAndCap();
  } catch (err) {
    showAlert(err.message || 'No se pudo cargar los horarios ocupados.');
  }
}

async function handleSubmit(e) {
  e.preventDefault();
  hideAlert();

  const spaceId = document.getElementById('study-book-space')?.value;
  const date = document.getElementById('study-book-date')?.value;
  const start = document.getElementById('study-book-start')?.value;
  const durationRaw = document.getElementById('study-book-duration')?.value;

  if (!spaceId || !date || !start || !durationRaw) return;

  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;

  try {
    const { error } = await supabase.rpc('request_study_booking', {
      p_study_space_id: spaceId,
      p_date: date,
      p_start: start,
      p_duration_min: Number(durationRaw),
    });
    if (error) throw error;

    document.getElementById('study-book-start').value = '';
    await refreshAll();
  } catch (err) {
    showAlert(err.message || 'No se pudo crear la solicitud.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleCancel(bookingId) {
  hideAlert();
  if (!confirm('¿Cancelar esta solicitud?')) return;

  try {
    const { error } = await supabase.rpc('cancel_study_booking', {
      p_booking_id: bookingId,
    });
    if (error) throw error;
    await refreshAll();
  } catch (err) {
    showAlert(err.message || 'No se pudo cancelar la solicitud.');
  }
}

function onRealtimeChange() {
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    refreshAll().catch((err) => {
      showAlert(err.message || 'No se pudo actualizar.');
    });
  }, 150);
}

function subscribe() {
  unsubscribeChannel();

  state.channel = supabase
    .channel('study-booking-panel')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'study_spaces' },
      onRealtimeChange
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'study_bookings' },
      onRealtimeChange
    )
    .subscribe();
}

function wireEvents(panel) {
  panel.querySelector('#study-book-form')?.addEventListener('submit', handleSubmit);
  panel.querySelector('#study-book-space')?.addEventListener('change', handleFormChange);
  panel.querySelector('#study-book-date')?.addEventListener('change', handleFormChange);

  panel.addEventListener('click', (e) => {
    const cancelBtn = e.target.closest('[data-cancel-booking]');
    if (cancelBtn) {
      handleCancel(cancelBtn.dataset.cancelBooking);
    }
  });
}

export async function mountStudyBooking(profile) {
  if (profile.role !== 'student' && profile.role !== 'teacher') return;

  cleanup();

  const panel = document.getElementById('panel-espacios-de-estudio');
  if (!panel) return;

  state.profile = profile;
  state.studySpaces = [];
  state.ownBookings = [];
  state.takenBookings = [];

  panel.innerHTML = buildPanelShell();
  wireEvents(panel);
  subscribe();

  try {
    await refreshAll();
  } catch (err) {
    showAlert(err.message || 'No se pudo cargar espacios de estudio.');
  }
}
