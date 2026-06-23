import { supabase } from './supabase.js';

const WEEKDAY_LABELS = {
  lunes: 'Lunes',
  martes: 'Martes',
  miercoles: 'Miércoles',
  jueves: 'Jueves',
  viernes: 'Viernes',
};

const MAX_PICKS_PER_CLASS = 2;

const ERROR_MESSAGES = {
  'reservas cerradas': 'Las reservas están cerradas.',
  'not your turn': 'No es tu turno.',
  'not your slot': 'Esta franja no te corresponde.',
  'espacio no disponible': 'Ese espacio ya no está disponible.',
  'código incorrecto': 'Código incorrecto.',
  'slot not found': 'Franja no encontrada.',
  'part required for multi slot': 'Franja múltiple: falta identificar la parte.',
  'invalid slot part': 'Parte de franja no válida.',
  'part not allowed for single slot': 'Esta franja no admite partes.',
  'invalid pick index': 'Selección de espacio no válida.',
};

/** @type {{
 *   profile: object | null,
 *   session: object | null,
 *   turns: object[],
 *   bookingItems: object[],
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
  bookingItems: [],
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
  hideConfirmSuccess();
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

async function fetchBookingItems() {
  const teacherId = state.profile.id;
  /** @type {object[]} */
  const items = [];

  const { data: partRows, error: partError } = await supabase
    .from('timetable_slot_part_teachers')
    .select(`
      part_id,
      timetable_slot_parts(
        id, part_index, class_id,
        classes(name),
        timetable_slots(id, grade, day, start_time, end_time, is_multi)
      )
    `)
    .eq('teacher_id', teacherId);

  if (!partError) {
    for (const row of partRows ?? []) {
      const part = row.timetable_slot_parts;
      const slot = part?.timetable_slots;
      if (slot?.is_multi && part?.id) {
        items.push({
          slot_id: slot.id,
          part_id: part.id,
          part_index: part.part_index,
          grade: slot.grade,
          day: slot.day,
          start_time: slot.start_time,
          end_time: slot.end_time,
          class_name: part.classes?.name || 'Clase',
          is_multi: true,
        });
      }
    }
  }

  const { data: assigned, error: assignError } = await supabase
    .from('timetable_slot_teachers')
    .select('timetable_slots(id, class_id, grade, day, start_time, end_time, is_multi, classes(name))')
    .eq('teacher_id', teacherId);

  if (!assignError) {
    for (const row of assigned ?? []) {
      const slot = row.timetable_slots;
      if (slot?.id && !slot.is_multi) {
        items.push({
          slot_id: slot.id,
          part_id: null,
          part_index: null,
          grade: slot.grade,
          day: slot.day,
          start_time: slot.start_time,
          end_time: slot.end_time,
          class_name: slot.classes?.name || 'Clase',
          is_multi: false,
        });
      }
    }
  }

  const { data: legacy, error: legacyError } = await supabase
    .from('timetable_slots')
    .select('id, class_id, grade, day, start_time, end_time, is_multi, classes(name)')
    .eq('teacher_id', teacherId);

  if (legacyError && items.length === 0) throw legacyError;

  for (const slot of legacy ?? []) {
    if (slot.is_multi) continue;
    if (!items.some((item) => item.slot_id === slot.id && !item.part_id)) {
      items.push({
        slot_id: slot.id,
        part_id: null,
        part_index: null,
        grade: slot.grade,
        day: slot.day,
        start_time: slot.start_time,
        end_time: slot.end_time,
        class_name: slot.classes?.name || 'Clase',
        is_multi: false,
      });
    }
  }

  return items.sort((a, b) => {
    const dayOrder = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'];
    const dayDiff = dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day);
    if (dayDiff !== 0) return dayDiff;
    const timeDiff = String(a.start_time).localeCompare(String(b.start_time));
    if (timeDiff !== 0) return timeDiff;
    return (a.part_index ?? 0) - (b.part_index ?? 0);
  });
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
    .select('id, slot_id, slot_part_id, pick_index, space_id, teacher_id, day, start_time, confirmed')
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

function picksForItem(item) {
  return state.reservations
    .filter(
      (r) =>
        r.slot_id === item.slot_id &&
        r.teacher_id === state.profile.id &&
        (item.part_id ? r.slot_part_id === item.part_id : !r.slot_part_id)
    )
    .sort((a, b) => (a.pick_index ?? 1) - (b.pick_index ?? 1));
}

function pickForItemAtIndex(item, pickIndex) {
  return picksForItem(item).find((r) => (r.pick_index ?? 1) === pickIndex) ?? null;
}

function takenSpaceIds(day, startTime, excludeSlotId, excludePartId = null, excludePickIndex = null) {
  return new Set(
    state.reservations
      .filter((r) => {
        if (r.day !== day || r.start_time !== startTime) return false;
        if (r.slot_id !== excludeSlotId) return true;
        const partMatch = excludePartId ? r.slot_part_id === excludePartId : !r.slot_part_id;
        if (!partMatch) return true;
        if (excludePickIndex != null && (r.pick_index ?? 1) === excludePickIndex) return false;
        return true;
      })
      .map((r) => r.space_id)
  );
}

function spaceNameById(spaceId) {
  return state.spaces.find((s) => s.id === spaceId)?.name ?? '—';
}

function teacherDisplayName(teacherId) {
  if (teacherId === state.profile?.id) return 'Tú';
  return state.teacherNames[teacherId] || 'Otra maestra';
}

function turnStatusLabel(status) {
  switch (status) {
    case 'done':
      return 'hecho';
    case 'skipped':
      return 'saltado';
    case 'active':
      return 'en turno';
    default:
      return 'pendiente';
  }
}

function renderDraftQueueInfo(ui) {
  if (state.session?.phase !== 'live') return '';

  const total = state.turns.length;
  const lines = [];

  if (ui.myTurn) {
    lines.push(
      `<p class="reservar-queue-line"><strong>Tu posición:</strong> ${ui.myTurn.position} de ${total} <span class="reservar-queue-status">(${turnStatusLabel(ui.myTurn.status)})</span></p>`
    );
  }

  if (ui.activeTurn) {
    const name = teacherDisplayName(ui.activeTurn.teacher_id);
    lines.push(
      `<p class="reservar-queue-line"><strong>Eligiendo ahora:</strong> posición ${ui.activeTurn.position} — ${escapeHtml(name)}</p>`
    );
  }

  if (!lines.length) return '';
  return `<div class="reservar-queue-panel">${lines.join('')}</div>`;
}

function ensureConfirmSuccessModal() {
  let overlay = document.getElementById('reservar-success-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'reservar-success-overlay';
  overlay.className = 'reservar-success-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="reservar-success-dialog" role="dialog" aria-labelledby="reservar-success-title" aria-modal="true">
      <p class="reservar-success-title" id="reservar-success-title">¡Listo!</p>
      <p class="reservar-success-text">Tus clases han sido registradas correctamente.</p>
      <button type="button" class="btn btn-primary reservar-success-ok" id="reservar-success-ok">OK</button>
    </div>
  `;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideConfirmSuccess();
  });
  overlay.querySelector('#reservar-success-ok')?.addEventListener('click', hideConfirmSuccess);

  document.body.appendChild(overlay);
  return overlay;
}

function showConfirmSuccess() {
  ensureConfirmSuccessModal().hidden = false;
}

function hideConfirmSuccess() {
  const overlay = document.getElementById('reservar-success-overlay');
  if (overlay) overlay.hidden = true;
}

function buildPanelShell() {
  return `
    <h2 class="panel-title">Reservar mi espacio</h2>
    <div id="reservar-alert" class="alert alert-error" hidden></div>
    <div id="reservar-content"></div>
  `;
}

function renderSpaceSelect(item, pickIndex, pick) {
  const taken = takenSpaceIds(
    item.day,
    item.start_time,
    item.slot_id,
    item.part_id,
    pickIndex
  );
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

  const partAttr = item.part_id ? ` data-part-id="${item.part_id}"` : '';

  return `
    <label class="reservar-space-pick-label">
      <span class="reservar-space-pick-hd">Espacio ${pickIndex}</span>
      <select class="input reservar-space-select" data-slot-id="${item.slot_id}" data-pick-index="${pickIndex}"${partAttr} aria-label="Espacio ${pickIndex} para ${escapeHtml(item.class_name)}">
        ${options}
      </select>
    </label>
  `;
}

function renderItemRow(item, ui) {
  const picks = picksForItem(item);
  const className = item.class_name;
  const dayLabel = WEEKDAY_LABELS[item.day] || item.day;
  const timeRange = `${formatTime(item.start_time)} – ${formatTime(item.end_time)}`;
  const partLabel = item.is_multi ? `<span class="reservar-part-badge">Parte ${item.part_index === 1 ? 'A' : 'B'}</span>` : '';

  let pickDisplay = '';
  if (picks.length) {
    pickDisplay = picks
      .map((pick) => {
        const status = pick.confirmed ? 'Confirmada' : 'Sin confirmar';
        return `
          <span class="reservar-pick-entry">
            <span class="reservar-pick-space">${escapeHtml(spaceNameById(pick.space_id))}</span>
            <span class="reservar-pick-status${pick.confirmed ? ' reservar-pick-confirmed' : ''}">${status}</span>
          </span>
        `;
      })
      .join('');
  } else {
    pickDisplay = '<span class="reservar-pick-empty">Sin reservar</span>';
  }

  const spaceControl = ui.canEditPicks
    ? `<div class="reservar-space-picks">${Array.from({ length: MAX_PICKS_PER_CLASS }, (_, i) => renderSpaceSelect(item, i + 1, pickForItemAtIndex(item, i + 1))).join('')}</div>`
    : pickDisplay;

  return `
    <li class="reservar-slot-row${item.is_multi ? ' reservar-slot-row-multi' : ''}">
      <div class="reservar-slot-main">
        <strong class="reservar-slot-class">${escapeHtml(className)}</strong>
        ${partLabel}
        <span class="reservar-slot-meta">${escapeHtml(item.grade)} · ${dayLabel} · ${timeRange}</span>
      </div>
      <div class="reservar-slot-pick">${spaceControl}</div>
    </li>
  `;
}

function renderBanner(ui) {
  if (ui.kind === 'waiting') {
    return `
      <div class="reservar-banner reservar-banner-waiting reservar-state reservar-state-waiting">
        <span class="badge badge--state badge--state-waiting reservar-state-badge">Esperando</span>
        <p class="reservar-banner-title">Esperando tu turno</p>
        <p class="reservar-banner-text">Sigue el draft en vivo abajo. Cuando llegue tu posición podrás elegir espacios.</p>
        ${renderDraftQueueInfo(ui)}
        <div class="reservar-countdown-panel">
          <div class="reservar-countdown-wrap">
            <span class="reservar-countdown-label">Tiempo restante del turno</span>
            <span class="reservar-countdown" id="reservar-countdown">--:--</span>
          </div>
        </div>
      </div>
    `;
  }

  if (ui.kind === 'your-turn') {
    return `
      <div class="reservar-banner reservar-banner-active reservar-state reservar-state-your-turn">
        <span class="badge badge--state badge--state-your-turn reservar-state-badge">Tu turno</span>
        <p class="reservar-banner-title">¡Es tu turno!</p>
        <p class="reservar-banner-text">Elige hasta 2 espacios por franja y confirma con tu código personal.</p>
        ${renderDraftQueueInfo(ui)}
        <div class="reservar-countdown-panel reservar-countdown-panel--active">
          <div class="reservar-countdown-wrap">
            <span class="reservar-countdown-label">Tiempo restante</span>
            <span class="reservar-countdown" id="reservar-countdown">--:--</span>
          </div>
        </div>
      </div>
    `;
  }

  if (ui.kind === 'open') {
    return `
      <div class="reservar-banner reservar-banner-open reservar-state reservar-state-open">
        <span class="badge badge--state badge--state-open reservar-state-badge">Registro abierto</span>
        <p class="reservar-banner-title">Registro abierto</p>
        <p class="reservar-banner-text">Elige hasta 2 espacios por franja y confirma con tu código personal cuando termines.</p>
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

  const itemRows = state.bookingItems.length
    ? state.bookingItems.map((item) => renderItemRow(item, ui)).join('')
    : '<p class="reservar-empty">No tienes franjas asignadas en el horario.</p>';

  root.innerHTML = `
    ${renderBanner(ui)}
    <section class="reservar-slots-section">
      <h3 class="reservar-section-title">Tus franjas</h3>
      <ul class="reservar-slot-list">${itemRows}</ul>
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
  const partId = select.dataset.partId || null;
  const pickIndex = Number(select.dataset.pickIndex || 1);
  const spaceVal = select.value;
  const prevValue = select.dataset.prevValue ?? '';

  hideAlert();
  select.disabled = true;

  try {
    const rpcArgs = { p_slot_id: slotId, p_pick_index: pickIndex };
    if (partId) rpcArgs.p_slot_part_id = partId;

    if (!spaceVal) {
      const { error } = await supabase.rpc('remove_pick', rpcArgs);
      if (error) throw error;
    } else {
      const { error } = await supabase.rpc('place_pick', {
        ...rpcArgs,
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
    showConfirmSuccess();
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
    state.bookingItems = await fetchBookingItems();
    state.spaces = await fetchSpaces();
    renderContent();
    return;
  }

  const [turns, bookingItems, spaces, reservations] = await Promise.all([
    fetchTurns(state.session.id),
    fetchBookingItems(),
    fetchSpaces(),
    fetchSessionReservations(state.session.id),
  ]);

  state.turns = turns;
  state.bookingItems = bookingItems;
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
  state.bookingItems = [];
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
