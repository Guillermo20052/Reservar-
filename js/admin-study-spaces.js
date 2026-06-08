import { supabase } from './supabase.js';

const ROLE_LABELS = {
  student: 'Alumna',
  teacher: 'Maestra',
  admin: 'Administradora',
};

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

/** @type {{
 *   profile: object | null,
 *   studySpaces: object[],
 *   teachingSpaces: object[],
 *   pendingBookings: object[],
 *   decidedBookings: object[],
 *   requesterById: Record<string, { full_name: string | null, role: string }>,
 *   channel: object | null,
 *   debounceTimer: ReturnType<typeof setTimeout> | null,
 * }} */
const state = {
  profile: null,
  studySpaces: [],
  teachingSpaces: [],
  pendingBookings: [],
  decidedBookings: [],
  requesterById: {},
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

function teachingSpaceNameById(id) {
  if (id == null) return null;
  return state.teachingSpaces.find((s) => s.id == id)?.name ?? null;
}

function showAlert(message) {
  const el = document.getElementById('study-admin-alert');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function hideAlert() {
  const el = document.getElementById('study-admin-alert');
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

async function fetchTeachingSpaces() {
  const { data, error } = await supabase
    .from('spaces')
    .select('id, name, sort_order')
    .order('sort_order');
  if (error) throw error;
  return data ?? [];
}

async function fetchStudySpaces() {
  const { data, error } = await supabase
    .from('study_spaces')
    .select('id, name, space_id, active, created_at')
    .order('name');
  if (error) throw error;
  return data ?? [];
}

async function fetchBookings(statusFilter) {
  let query = supabase
    .from('study_bookings')
    .select(`
      id, study_space_id, requester_id, booking_date, start_time,
      duration_min, status, decided_by, decided_at, created_at,
      study_spaces ( name, space_id )
    `);

  if (statusFilter === 'pending') {
    query = query.eq('status', 'pending').order('booking_date').order('start_time');
  } else {
    query = query
      .in('status', ['approved', 'rejected', 'cancelled'])
      .order('decided_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(30);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

async function fetchProfileNameMap(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const { data, error } = await supabase
    .from('profile_names')
    .select('id, full_name, role')
    .in('id', unique);
  if (error) throw error;
  /** @type {Record<string, { full_name: string | null, role: string }>} */
  const map = {};
  for (const row of data ?? []) {
    map[row.id] = { full_name: row.full_name, role: row.role };
  }
  return map;
}

function buildPanelShell() {
  return `
    <h2 class="panel-title">Espacios de estudio</h2>
    <div id="study-admin-alert" class="alert alert-error" hidden></div>

    <section class="study-admin-section">
      <h3 class="study-admin-section-title">Crear espacio de estudio</h3>
      <form id="study-admin-create-form" class="study-admin-create-form">
        <div class="form-group study-admin-field">
          <label for="study-admin-name">Nombre</label>
          <input class="input" id="study-admin-name" type="text" required placeholder="Ej. Sala silenciosa A">
        </div>
        <div class="form-group study-admin-field">
          <label for="study-admin-linked-space">Misma sala que (opcional)</label>
          <select class="input" id="study-admin-linked-space">
            <option value="">Independiente</option>
          </select>
        </div>
        <button type="submit" class="btn btn-primary">Crear</button>
      </form>
      <div id="study-admin-spaces-list" class="study-admin-spaces-list"></div>
    </section>

    <section class="study-admin-section">
      <h3 class="study-admin-section-title">Solicitudes</h3>
      <div id="study-admin-pending-list" class="study-admin-bookings-list"></div>
      <details class="study-admin-decided-wrap">
        <summary class="study-admin-decided-summary">Solicitudes recientes (decididas)</summary>
        <div id="study-admin-decided-list" class="study-admin-bookings-list"></div>
      </details>
    </section>
  `;
}

function populateTeachingSpaceSelect() {
  const select = document.getElementById('study-admin-linked-space');
  if (!select) return;
  const current = select.value;
  select.innerHTML = [
    '<option value="">Independiente</option>',
    ...state.teachingSpaces.map(
      (s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`
    ),
  ].join('');
  if (current && state.teachingSpaces.some((s) => String(s.id) === current)) {
    select.value = current;
  }
}

function renderSpacesList() {
  const root = document.getElementById('study-admin-spaces-list');
  if (!root) return;

  if (!state.studySpaces.length) {
    root.innerHTML = '<p class="study-admin-empty">No hay espacios de estudio creados.</p>';
    return;
  }

  root.innerHTML = state.studySpaces.map((space) => {
    const linked = space.space_id
      ? teachingSpaceNameById(space.space_id) || `Sala #${space.space_id}`
      : 'Independiente';
    const activeLabel = space.active ? 'Activo' : 'Inactivo';
    const activeClass = space.active ? 'study-admin-badge-active' : 'study-admin-badge-inactive';

    return `
      <article class="study-admin-space-row" data-space-id="${space.id}">
        <div class="study-admin-space-main">
          <strong class="study-admin-space-name">${escapeHtml(space.name)}</strong>
          <span class="study-admin-space-meta">Misma sala: ${escapeHtml(linked)}</span>
          <span class="study-admin-badge ${activeClass}">${activeLabel}</span>
        </div>
        <div class="study-admin-space-actions">
          <button type="button" class="btn btn-ghost study-admin-btn-sm" data-toggle-active="${space.id}">
            ${space.active ? 'Desactivar' : 'Activar'}
          </button>
          <button type="button" class="btn btn-ghost study-admin-btn-sm" data-delete-space="${space.id}">Eliminar</button>
        </div>
      </article>
    `;
  }).join('');
}

function renderBookingRow(booking, { showActions = false, allowCancel = false }) {
  const requester = state.requesterById[booking.requester_id];
  const requesterName = requester?.full_name?.trim() || 'Sin nombre';
  const requesterRole = ROLE_LABELS[requester?.role] || requester?.role || '—';
  const spaceName = booking.study_spaces?.name || 'Espacio';
  const linkedId = booking.study_spaces?.space_id;
  const linkedName = linkedId ? teachingSpaceNameById(linkedId) : null;
  const linkedLine = linkedName
    ? `<span class="study-admin-booking-linked">Misma sala: ${escapeHtml(linkedName)}</span>`
    : '';
  const statusClass = `study-admin-status-${booking.status}`;

  const actions = showActions
    ? `
      <div class="study-admin-booking-actions">
        <button type="button" class="btn btn-primary study-admin-btn-sm" data-approve-booking="${booking.id}">Aprobar</button>
        <button type="button" class="btn btn-ghost study-admin-btn-sm" data-reject-booking="${booking.id}">Rechazar</button>
      </div>
    `
    : allowCancel && booking.status === 'approved'
      ? `
      <div class="study-admin-booking-actions">
        <button type="button" class="btn btn-ghost study-admin-btn-sm" data-cancel-booking="${booking.id}">Cancelar</button>
      </div>
    `
      : '';

  return `
    <article class="study-admin-booking-row">
      <div class="study-admin-booking-main">
        <strong class="study-admin-booking-requester">${escapeHtml(requesterName)}</strong>
        <span class="study-admin-booking-role">${escapeHtml(requesterRole)}</span>
        <span class="study-admin-booking-space">${escapeHtml(spaceName)}</span>
        ${linkedLine}
        <span class="study-admin-booking-when">
          ${formatDate(booking.booking_date)} · ${formatTime(booking.start_time)} · ${durationLabel(booking.duration_min)}
        </span>
        <span class="study-admin-badge study-admin-status-badge ${statusClass}">${STATUS_LABELS[booking.status] || booking.status}</span>
      </div>
      ${actions}
    </article>
  `;
}

function renderBookingsLists() {
  const pendingRoot = document.getElementById('study-admin-pending-list');
  const decidedRoot = document.getElementById('study-admin-decided-list');
  if (!pendingRoot || !decidedRoot) return;

  pendingRoot.innerHTML = state.pendingBookings.length
    ? state.pendingBookings.map((b) => renderBookingRow(b, { showActions: true })).join('')
    : '<p class="study-admin-empty">No hay solicitudes pendientes.</p>';

  decidedRoot.innerHTML = state.decidedBookings.length
    ? state.decidedBookings.map((b) => renderBookingRow(b, { allowCancel: true })).join('')
    : '<p class="study-admin-empty">No hay solicitudes decididas recientes.</p>';
}

async function refreshAll() {
  hideAlert();
  const [teachingSpaces, studySpaces, pendingBookings, decidedBookings] = await Promise.all([
    fetchTeachingSpaces(),
    fetchStudySpaces(),
    fetchBookings('pending'),
    fetchBookings('decided'),
  ]);

  state.teachingSpaces = teachingSpaces;
  state.studySpaces = studySpaces;
  state.pendingBookings = pendingBookings;
  state.decidedBookings = decidedBookings;

  const requesterIds = [
    ...pendingBookings.map((b) => b.requester_id),
    ...decidedBookings.map((b) => b.requester_id),
  ];
  state.requesterById = await fetchProfileNameMap(requesterIds);

  populateTeachingSpaceSelect();
  renderSpacesList();
  renderBookingsLists();
}

async function handleCreate(e) {
  e.preventDefault();
  hideAlert();

  const nameInput = document.getElementById('study-admin-name');
  const linkSelect = document.getElementById('study-admin-linked-space');
  const name = nameInput?.value.trim();
  if (!name) return;

  const spaceIdVal = linkSelect?.value;
  const payload = {
    name,
    space_id: spaceIdVal ? Number(spaceIdVal) : null,
    active: true,
    created_by: state.profile.id,
  };

  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;

  try {
    const { error } = await supabase.from('study_spaces').insert(payload);
    if (error) throw error;
    nameInput.value = '';
    if (linkSelect) linkSelect.value = '';
    await refreshAll();
  } catch (err) {
    showAlert(err.message || 'No se pudo crear el espacio de estudio.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleToggleActive(spaceId) {
  hideAlert();
  const space = state.studySpaces.find((s) => String(s.id) === String(spaceId));
  if (!space) return;

  try {
    const { error } = await supabase
      .from('study_spaces')
      .update({ active: !space.active })
      .eq('id', spaceId);
    if (error) throw error;
    await refreshAll();
  } catch (err) {
    showAlert(err.message || 'No se pudo actualizar el espacio.');
  }
}

async function handleDeleteSpace(spaceId) {
  hideAlert();
  const space = state.studySpaces.find((s) => String(s.id) === String(spaceId));
  if (!space) return;

  if (!confirm(`¿Eliminar «${space.name}»? Las reservaciones asociadas también se eliminarán.`)) {
    return;
  }

  try {
    const { error } = await supabase.from('study_spaces').delete().eq('id', spaceId);
    if (error) throw error;
    await refreshAll();
  } catch (err) {
    showAlert(err.message || 'No se pudo eliminar el espacio.');
  }
}

async function handleDecide(bookingId, approve) {
  hideAlert();

  const verb = approve ? 'aprobar' : 'rechazar';
  if (!confirm(`¿${approve ? 'Aprobar' : 'Rechazar'} esta solicitud?`)) return;

  try {
    const { error } = await supabase.rpc('decide_study_booking', {
      p_booking_id: bookingId,
      p_approve: approve,
    });
    if (error) throw error;
    await refreshAll();
  } catch (err) {
    showAlert(err.message || `No se pudo ${verb} la solicitud.`);
  }
}

async function handleCancel(bookingId) {
  hideAlert();
  if (!confirm('¿Cancelar esta reservación aprobada?')) return;

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
      showAlert(err.message || 'No se pudo actualizar las solicitudes.');
    });
  }, 150);
}

function subscribe() {
  unsubscribeChannel();

  state.channel = supabase
    .channel('admin-study-spaces')
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
  panel.querySelector('#study-admin-create-form')?.addEventListener('submit', handleCreate);

  panel.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('[data-toggle-active]');
    if (toggleBtn) {
      handleToggleActive(toggleBtn.dataset.toggleActive);
      return;
    }

    const deleteBtn = e.target.closest('[data-delete-space]');
    if (deleteBtn) {
      handleDeleteSpace(deleteBtn.dataset.deleteSpace);
      return;
    }

    const approveBtn = e.target.closest('[data-approve-booking]');
    if (approveBtn) {
      handleDecide(approveBtn.dataset.approveBooking, true);
      return;
    }

    const rejectBtn = e.target.closest('[data-reject-booking]');
    if (rejectBtn) {
      handleDecide(rejectBtn.dataset.rejectBooking, false);
      return;
    }

    const cancelBtn = e.target.closest('[data-cancel-booking]');
    if (cancelBtn) {
      handleCancel(cancelBtn.dataset.cancelBooking);
    }
  });
}

export async function mountAdminStudySpaces(profile) {
  if (profile.role !== 'admin') return;

  cleanup();

  const panel = document.getElementById('panel-espacios-de-estudio');
  if (!panel) return;

  state.profile = profile;
  state.studySpaces = [];
  state.teachingSpaces = [];
  state.pendingBookings = [];
  state.decidedBookings = [];
  state.requesterById = {};

  panel.innerHTML = buildPanelShell();
  wireEvents(panel);
  subscribe();

  try {
    await refreshAll();
  } catch (err) {
    showAlert(err.message || 'No se pudo cargar espacios de estudio.');
  }
}
