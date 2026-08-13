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

/* ---------- study timeline (additive) ---------- */
const TL_DAY_START_MIN = 7 * 60;   // 07:00
const TL_DAY_END_MIN = 18 * 60;    // 18:00
const TL_SEGMENT_MIN = 30;         // 30-min segments (22 total)

function tlTimeToMinutes(time) {
  const [h, m] = String(time).slice(0, 5).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function tlMinutesToLabel(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
/* ---------- end study timeline helpers ---------- */

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

    <section class="study-book-section app-form-section">
      <h3 class="study-book-section-title">Solicitar espacio</h3>
      <form id="study-book-form" class="study-book-form app-form-card">
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
        <div id="study-book-timeline" class="study-tl" hidden></div>
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

/* ---------- study timeline (additive) ---------- */
function renderTimeline() {
  const root = document.getElementById('study-book-timeline');
  if (!root) return;

  const { spaceId, date } = getFormSelection();
  if (!spaceId || !date) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }

  const totalMin = TL_DAY_END_MIN - TL_DAY_START_MIN;

  // Same data the text list uses: state.takenBookings (zero new queries).
  const busy = state.takenBookings
    .map((b) => {
      const s = tlTimeToMinutes(b.start_time);
      if (s === null) return null;
      return { id: b.id, status: b.status, start: s, end: s + b.duration_min };
    })
    .filter((iv) => iv && iv.end > TL_DAY_START_MIN && iv.start < TL_DAY_END_MIN);

  // Own-booking detection: intersect ids with the already-fetched own bookings.
  const ownIds = new Set(state.ownBookings.map((b) => String(b.id)));

  // 22 half-hour segments; free ones are click targets that prefill the start input.
  const segs = [];
  for (let m = TL_DAY_START_MIN; m < TL_DAY_END_MIN; m += TL_SEGMENT_MIN) {
    const isFree = !busy.some((iv) => iv.start < m + TL_SEGMENT_MIN && iv.end > m);
    const label = tlMinutesToLabel(m);
    if (isFree) {
      segs.push(
        `<button type="button" class="study-tl-seg study-tl-seg--free" data-tl-start="${label}" title="Libre · ${label}" aria-label="Elegir ${label} como hora de inicio"></button>`
      );
    } else {
      segs.push('<span class="study-tl-seg study-tl-seg--busy" aria-hidden="true"></span>');
    }
  }

  // Occupied blocks positioned by real (unsnapped) start/end, clamped to 07:00–18:00.
  const blocks = busy.map((iv) => {
    const cs = Math.max(iv.start, TL_DAY_START_MIN);
    const ce = Math.min(iv.end, TL_DAY_END_MIN);
    const left = (((cs - TL_DAY_START_MIN) / totalMin) * 100).toFixed(3);
    const width = (((ce - cs) / totalMin) * 100).toFixed(3);
    const own = ownIds.has(String(iv.id));
    const statusLabel = STATUS_LABELS[iv.status] || iv.status;
    const tip = `${tlMinutesToLabel(iv.start)} – ${tlMinutesToLabel(iv.end)} · ${statusLabel}${own ? ' · Tuya' : ''}`;
    const cls = `study-tl-block study-tl-block--${escapeHtml(iv.status)}${own ? ' study-tl-block--own' : ''}`;
    return `<span class="${cls}" style="left:${left}%;width:${width}%;" tabindex="0" role="img" title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}" data-tip="${escapeHtml(tip)}"></span>`;
  }).join('');

  // Hour ticks 07..18 under the track.
  const hours = [];
  for (let h = TL_DAY_START_MIN / 60; h <= TL_DAY_END_MIN / 60; h++) {
    const left = (((h * 60 - TL_DAY_START_MIN) / totalMin) * 100).toFixed(3);
    const edge =
      h * 60 === TL_DAY_START_MIN ? ' study-tl-hour--start'
      : h * 60 === TL_DAY_END_MIN ? ' study-tl-hour--end'
      : '';
    hours.push(`<span class="study-tl-hour${edge}" style="left:${left}%;">${String(h).padStart(2, '0')}</span>`);
  }

  root.hidden = false;
  root.innerHTML = `
    <div class="study-tl-scroll">
      <div class="study-tl-inner">
        <div class="study-tl-track">${segs.join('')}${blocks}</div>
        <div class="study-tl-hours">${hours.join('')}</div>
      </div>
    </div>
    <div class="study-tl-legend">
      <span class="study-tl-key"><i class="study-tl-swatch study-tl-swatch--free"></i>Libre</span>
      <span class="study-tl-key"><i class="study-tl-swatch study-tl-swatch--pending"></i>Pendiente</span>
      <span class="study-tl-key"><i class="study-tl-swatch study-tl-swatch--approved"></i>Aprobada</span>
      <span class="study-tl-key"><i class="study-tl-swatch study-tl-swatch--own"></i>Tuya</span>
    </div>
  `;
}

function prefillStartTime(label) {
  const input = document.getElementById('study-book-start');
  if (!input) return;
  input.value = label;
  // No existing listeners on this input today; dispatch standard events anyway
  // so any future/native listeners react as if the user typed it.
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.focus();
}
/* ---------- end study timeline (additive) ---------- */

function renderTakenTimes() {
  const wrap = document.getElementById('study-book-taken-wrap');
  const list = document.getElementById('study-book-taken-list');
  if (!wrap || !list) return;

  renderTimeline(); /* study timeline (additive): same render path as the text list */

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
          <span class="badge badge--${booking.status} study-book-badge study-book-status-badge ${statusClass}">${STATUS_LABELS[booking.status] || booking.status}</span>
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

    /* study timeline (additive): free segment click prefills the start input */
    const seg = e.target.closest('[data-tl-start]');
    if (seg) {
      prefillStartTime(seg.dataset.tlStart);
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
