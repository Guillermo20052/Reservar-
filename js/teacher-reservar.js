import { supabase } from './supabase.js';

const WEEKDAY_LABELS = {
  lunes: 'Lunes',
  martes: 'Martes',
  miercoles: 'Miércoles',
  jueves: 'Jueves',
  viernes: 'Viernes',
};

const ERROR_MESSAGES = {
  'reservas cerradas': 'Las reservas están cerradas.',
  'not your turn': 'No es tu turno.',
  'not your slot': 'Esta franja no te corresponde.',
  'espacio no disponible': 'Ese espacio ya no está disponible.',
  'código incorrecto': 'Código incorrecto.',
  'slot not found': 'Franja no encontrada.',
};

/** @type {{
 *   profile: object | null,
 *   session: object | null,
 *   turns: object[],
 *   slots: object[],
 *   spaces: object[],
 *   reservations: object[],
 *   teacherNames: Record<string, string>,
 *   draftChannel: object | null,
 *   countdownInterval: ReturnType<typeof setInterval> | null,
 *   debounceTimer: ReturnType<typeof setTimeout> | null,
 *   advanceAttemptedFor: string | null,
 * }} */
const state = {
  profile: null,
  session: null,
  turns: [],
  slots: [],
  spaces: [],
  reservations: [],
  teacherNames: {},
  draftChannel: null,
  countdownInterval: null,
  debounceTimer: null,
  advanceAttemptedFor: null,
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

function friendlyError(message) {
  return ERROR_MESSAGES[message] || message || 'Ocurrió un error.';
}

function showAlert(message) {
  const el = document.getElementById('reservar-alert');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function hideAlert() {
  const el = document.getElementById('reservar-alert');
  if (el) el.hidden = true;
}

function clearCountdown() {
  if (state.countdownInterval) {
    clearInterval(state.countdownInterval);
    state.countdownInterval = null;
  }
}

function unsubscribeDraft() {
  if (state.draftChannel) {
    supabase.removeChannel(state.draftChannel);
    state.draftChannel = null;
  }
}

function cleanup() {
  clearCountdown();
  unsubscribeDraft();
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
  const { data, error } = await supabase
    .from('draft_sessions')
    .select('id, phase, current_position, turn_ends_at, started_at')
    .neq('phase', 'closed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function fetchTurns(sessionId) {
  const { data, error } = await supabase
    .from('draft_turns')
    .select('id, position, status, teacher_id')
    .eq('session_id', sessionId)
    .order('position');
  if (error) throw error;
  return data ?? [];
}

async function fetchSlots() {
  const { data, error } = await supabase
    .from('timetable_slots')
    .select('id, class_id, grade, day, start_time, end_time, classes(name)')
    .eq('teacher_id', state.profile.id)
    .order('day')
    .order('start_time');
  if (error) throw error;
  return data ?? [];
}

async function fetchSpaces() {
  const { data, error } = await supabase
    .from('spaces')
    .select('id, name, sort_order')
    .order('sort_order');
  if (error) throw error;
  return data ?? [];
}

async function fetchSessionReservations(sessionId) {
  const { data, error } = await supabase
    .from('reservations')
    .select('id, slot_id, space_id, teacher_id, day, start_time, confirmed')
    .eq('session_id', sessionId);
  if (error) throw error;
  return data ?? [];
}

function computeUiState() {
  const session = state.session;
  if (!session) {
    return {
      kind: 'none',
      activeTurn: null,
      myTurn: null,
      isMyTurn: false,
      canEditPicks: false,
    };
  }

  const activeTurn = state.turns.find((t) => t.status === 'active') ?? null;
  const myTurn = state.turns.find((t) => t.teacher_id === state.profile.id) ?? null;
  const isMyTurn = session.phase === 'live' && activeTurn?.teacher_id === state.profile.id;
  const canEditPicks = session.phase === 'open' || isMyTurn;

  if (session.phase === 'live' && !isMyTurn) {
    return { kind: 'waiting', activeTurn, myTurn, isMyTurn, canEditPicks };
  }
  if (session.phase === 'live' && isMyTurn) {
    return { kind: 'your-turn', activeTurn, myTurn, isMyTurn, canEditPicks };
  }
  if (session.phase === 'open') {
    return { kind: 'open', activeTurn, myTurn, isMyTurn, canEditPicks };
  }

  return { kind: 'none', activeTurn, myTurn, isMyTurn, canEditPicks: false };
}

function pickForSlot(slotId) {
  return state.reservations.find(
    (r) => r.slot_id === slotId && r.teacher_id === state.profile.id
  );
}

function takenSpaceIds(day, startTime, excludeSlotId) {
  return new Set(
    state.reservations
      .filter(
        (r) =>
          r.day === day &&
          r.start_time === startTime &&
          r.slot_id !== excludeSlotId
      )
      .map((r) => r.space_id)
  );
}

function spaceNameById(spaceId) {
  return state.spaces.find((s) => s.id === spaceId)?.name ?? '—';
}

function buildPanelShell() {
  return `
    <h2 class="panel-title">Reservar mi espacio</h2>
    <div id="reservar-alert" class="alert alert-error" hidden></div>
    <div id="reservar-content"></div>
  `;
}

function renderSpaceSelect(slot, pick) {
  const taken = takenSpaceIds(slot.day, slot.start_time, slot.id);
  const currentSpaceId = pick?.space_id ?? null;

  const options = [
    '<option value="">— Sin espacio —</option>',
    ...state.spaces
      .filter((s) => !taken.has(s.id) || s.id === currentSpaceId)
      .map((s) => {
        const selected = s.id === currentSpaceId ? ' selected' : '';
        return `<option value="${s.id}"${selected}>${escapeHtml(s.name)}</option>`;
      }),
  ].join('');

  return `
    <select class="input reservar-space-select" data-slot-id="${slot.id}" aria-label="Espacio para ${escapeHtml(slot.classes?.name || 'clase')}">
      ${options}
    </select>
  `;
}

function renderSlotRow(slot, ui) {
  const pick = pickForSlot(slot.id);
  const className = slot.classes?.name || 'Clase';
  const dayLabel = WEEKDAY_LABELS[slot.day] || slot.day;
  const timeRange = `${formatTime(slot.start_time)} – ${formatTime(slot.end_time)}`;

  let pickDisplay = '';
  if (pick) {
    const status = pick.confirmed ? 'Confirmada' : 'Sin confirmar';
    pickDisplay = `
      <span class="reservar-pick-space">${escapeHtml(spaceNameById(pick.space_id))}</span>
      <span class="reservar-pick-status${pick.confirmed ? ' reservar-pick-confirmed' : ''}">${status}</span>
    `;
  } else {
    pickDisplay = '<span class="reservar-pick-empty">Sin reservar</span>';
  }

  const spaceControl = ui.canEditPicks
    ? renderSpaceSelect(slot, pick)
    : pickDisplay;

  return `
    <li class="reservar-slot-row">
      <div class="reservar-slot-main">
        <strong class="reservar-slot-class">${escapeHtml(className)}</strong>
        <span class="reservar-slot-meta">${escapeHtml(slot.grade)} · ${dayLabel} · ${timeRange}</span>
      </div>
      <div class="reservar-slot-pick">${spaceControl}</div>
    </li>
  `;
}

function renderBanner(ui) {
  if (ui.kind === 'waiting') {
    const activeName = ui.activeTurn?.teacher_id
      ? (state.teacherNames[ui.activeTurn.teacher_id] || 'Otra maestra')
      : 'Otra maestra';
    const posLine = ui.myTurn
      ? `<p class="reservar-queue">Tu turno: posición ${ui.myTurn.position} (${ui.myTurn.status === 'done' ? 'hecho' : ui.myTurn.status === 'skipped' ? 'saltado' : 'pendiente'})</p>`
      : '';
    return `
      <div class="reservar-banner reservar-banner-waiting">
        <p class="reservar-banner-title">Esperando tu turno</p>
        <p class="reservar-banner-text">Turno actual: <strong>${escapeHtml(activeName)}</strong></p>
        ${posLine}
        <div class="reservar-countdown-wrap">
          <span class="reservar-countdown-label">Tiempo restante del turno</span>
          <span class="reservar-countdown" id="reservar-countdown">--:--</span>
        </div>
      </div>
    `;
  }

  if (ui.kind === 'your-turn') {
    return `
      <div class="reservar-banner reservar-banner-active">
        <p class="reservar-banner-title">¡Es tu turno!</p>
        <p class="reservar-banner-text">Elige un espacio para cada franja y confirma con tu código personal.</p>
        <div class="reservar-countdown-wrap">
          <span class="reservar-countdown-label">Tiempo restante</span>
          <span class="reservar-countdown" id="reservar-countdown">--:--</span>
        </div>
      </div>
    `;
  }

  if (ui.kind === 'open') {
    return `
      <div class="reservar-banner reservar-banner-open">
        <p class="reservar-banner-title">Fase abierta</p>
        <p class="reservar-banner-text">Puedes completar o confirmar tus franjas restantes sin límite de turno.</p>
      </div>
    `;
  }

  return `
    <p class="reservar-empty">No hay un draft de reservaciones activo. Espera a que la administradora inicie la ronda semanal.</p>
  `;
}

function renderConfirmRow(ui) {
  if (!ui.canEditPicks) return '';

  return `
    <section class="reservar-confirm-section">
      <h3 class="reservar-section-title">Confirmar reservas</h3>
      <p class="reservar-hint">Ingresa tu código personal (lo ves en la pestaña <strong>Mi perfil</strong>) para confirmar tus elecciones.</p>
      <form id="reservar-confirm-form" class="reservar-confirm-form">
        <input class="input reservar-code-input" id="reservar-code" type="text" placeholder="Tu código" autocomplete="off" required>
        <button type="submit" class="btn btn-primary">Confirmar</button>
      </form>
    </section>
  `;
}

function renderContent() {
  const root = document.getElementById('reservar-content');
  if (!root) return;

  clearCountdown();

  const ui = computeUiState();

  if (ui.kind === 'none') {
    root.innerHTML = renderBanner(ui);
    return;
  }

  const slotRows = state.slots.length
    ? state.slots.map((slot) => renderSlotRow(slot, ui)).join('')
    : '<p class="reservar-empty">No tienes franjas asignadas en el horario.</p>';

  root.innerHTML = `
    ${renderBanner(ui)}
    <section class="reservar-slots-section">
      <h3 class="reservar-section-title">Tus franjas</h3>
      <ul class="reservar-slot-list">${slotRows}</ul>
    </section>
    ${renderConfirmRow(ui)}
  `;

  if (state.session?.phase === 'live' && state.session.turn_ends_at) {
    startCountdown(state.session.turn_ends_at);
  }
}

function tryAdvanceOnExpiry(turnEndsAt) {
  if (state.advanceAttemptedFor === turnEndsAt) return;
  state.advanceAttemptedFor = turnEndsAt;
  supabase.rpc('advance_turn').then(() => {}).catch(() => {});
}

function startCountdown(turnEndsAt) {
  clearCountdown();
  const el = document.getElementById('reservar-countdown');
  if (!el) return;

  function tick() {
    const diff = new Date(turnEndsAt).getTime() - Date.now();
    if (diff <= 0) {
      el.textContent = 'Tiempo agotado';
      el.classList.add('reservar-countdown-expired');
      tryAdvanceOnExpiry(turnEndsAt);
      return;
    }
    el.classList.remove('reservar-countdown-expired');
    const mm = Math.floor(diff / 60000);
    const ss = Math.floor((diff % 60000) / 1000);
    el.textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  tick();
  state.countdownInterval = setInterval(tick, 1000);
}

async function handleSpaceChange(select) {
  const slotId = select.dataset.slotId;
  const spaceVal = select.value;
  const prevValue = select.dataset.prevValue ?? '';

  hideAlert();
  select.disabled = true;

  try {
    if (!spaceVal) {
      const { error } = await supabase.rpc('remove_pick', { p_slot_id: slotId });
      if (error) throw error;
    } else {
      const { error } = await supabase.rpc('place_pick', {
        p_slot_id: slotId,
        p_space_id: Number(spaceVal),
      });
      if (error) throw error;
    }
    await refresh();
  } catch (err) {
    select.value = prevValue;
    const msg = friendlyError(err.message);
    showAlert(msg);
    if (err.message === 'espacio no disponible') {
      await refresh();
    }
  } finally {
    select.disabled = false;
  }
}

async function handleConfirm(e) {
  e.preventDefault();
  hideAlert();

  const input = document.getElementById('reservar-code');
  const code = input?.value.trim();
  if (!code) {
    showAlert('Ingresa tu código personal.');
    return;
  }

  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;

  try {
    const { error } = await supabase.rpc('confirm_turn', { p_code: code });
    if (error) throw error;
    input.value = '';
    await refresh();
  } catch (err) {
    showAlert(friendlyError(err.message));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function refresh() {
  const prevTurnEnds = state.session?.turn_ends_at;

  state.session = await fetchSession();

  if (state.session?.turn_ends_at !== prevTurnEnds) {
    state.advanceAttemptedFor = null;
  }

  if (!state.session) {
    state.turns = [];
    state.reservations = [];
    state.teacherNames = {};
    state.slots = await fetchSlots();
    state.spaces = await fetchSpaces();
    renderContent();
    return;
  }

  const [turns, slots, spaces, reservations] = await Promise.all([
    fetchTurns(state.session.id),
    fetchSlots(),
    fetchSpaces(),
    fetchSessionReservations(state.session.id),
  ]);

  state.turns = turns;
  state.slots = slots;
  state.spaces = spaces;
  state.reservations = reservations;
  state.teacherNames = await fetchProfileNameMap(turns.map((t) => t.teacher_id));
  renderContent();
}

function onRealtimeChange() {
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    refresh().catch((err) => {
      showAlert(friendlyError(err.message));
    });
  }, 150);
}

function subscribeDraft() {
  unsubscribeDraft();

  state.draftChannel = supabase
    .channel('teacher-draft-panel')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'draft_sessions' },
      onRealtimeChange
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'draft_turns' },
      onRealtimeChange
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'reservations' },
      onRealtimeChange
    )
    .subscribe();
}

function wireEvents(panel) {
  panel.addEventListener('change', (e) => {
    const select = e.target.closest('.reservar-space-select');
    if (!select) return;
    if (!select.dataset.prevValue) {
      select.dataset.prevValue = select.value;
    }
    handleSpaceChange(select);
  });

  panel.addEventListener('focusin', (e) => {
    const select = e.target.closest('.reservar-space-select');
    if (select) {
      select.dataset.prevValue = select.value;
    }
  });

  panel.addEventListener('submit', (e) => {
    if (e.target.id === 'reservar-confirm-form') {
      handleConfirm(e);
    }
  });
}

export async function mountReservarEspacio(profile) {
  if (profile.role !== 'teacher') return;

  cleanup();

  const panel = document.getElementById('panel-reservar-mi-espacio');
  if (!panel) return;

  state.profile = profile;
  state.session = null;
  state.turns = [];
  state.slots = [];
  state.spaces = [];
  state.reservations = [];
  state.advanceAttemptedFor = null;
  state.teacherNames = {};

  panel.innerHTML = buildPanelShell();
  wireEvents(panel);
  subscribeDraft();

  try {
    await refresh();
  } catch (err) {
    showAlert(friendlyError(err.message) || 'No se pudo cargar la reserva.');
  }
}
