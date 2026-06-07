import { supabase } from './supabase.js';

const STATUS_LABELS = {
  pending: 'Pendiente',
  active: 'Activo',
  done: 'Hecho',
  skipped: 'Saltado',
};

const PHASE_LABELS = {
  live: 'En vivo',
  open: 'Abierto',
};

/** @type {{
 *   profile: object | null,
 *   session: object | null,
 *   turns: object[],
 *   reservations: object[],
 *   assignedTeachers: object[],
 *   teacherNames: Record<string, string>,
 *   orderMode: 'random' | 'ordenado',
 *   orderedTeacherIds: string[],
 *   draftChannel: object | null,
 *   countdownInterval: ReturnType<typeof setInterval> | null,
 *   debounceTimer: ReturnType<typeof setTimeout> | null,
 *   panel: HTMLElement | null,
 * }} */
const state = {
  profile: null,
  session: null,
  turns: [],
  reservations: [],
  assignedTeachers: [],
  teacherNames: {},
  orderMode: 'random',
  orderedTeacherIds: [],
  draftChannel: null,
  countdownInterval: null,
  debounceTimer: null,
  panel: null,
};

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showAlert(message) {
  const el = document.getElementById('draft-alert');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function hideAlert() {
  const el = document.getElementById('draft-alert');
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

function teacherNameById(id) {
  if (!id) return 'Sin nombre';
  return state.teacherNames[id] || 'Sin nombre';
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

async function loadTeacherNames() {
  const ids = [
    ...state.turns.map((t) => t.teacher_id),
    ...state.assignedTeachers.map((t) => t.id),
  ];
  state.teacherNames = await fetchProfileNameMap(ids);
}

async function fetchSession() {
  const { data, error } = await supabase
    .from('draft_sessions')
    .select('id, phase, order_mode, current_position, turn_ends_at, started_at, created_at')
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

async function fetchReservations(sessionId) {
  const { data, error } = await supabase
    .from('reservations')
    .select('id, teacher_id, confirmed')
    .eq('session_id', sessionId);
  if (error) throw error;
  return data ?? [];
}

async function fetchAssignedTeachers() {
  const { data, error } = await supabase
    .from('timetable_slots')
    .select('teacher_id')
    .not('teacher_id', 'is', null);
  if (error) throw error;

  const ids = [...new Set((data ?? []).map((row) => row.teacher_id).filter(Boolean))];
  const nameMap = await fetchProfileNameMap(ids);

  return ids
    .map((id) => ({ id, full_name: nameMap[id] ?? null }))
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '', 'es'));
}

function pickCountsForTeacher(teacherId) {
  const picks = state.reservations.filter((r) => r.teacher_id === teacherId);
  const confirmed = picks.filter((r) => r.confirmed).length;
  return { total: picks.length, confirmed };
}

function buildPanelShell() {
  return `
    <h2 class="panel-title">Reservaciones semanales</h2>
    <div id="draft-alert" class="alert alert-error" hidden></div>
    <div id="draft-content"></div>
  `;
}

function renderSetup() {
  const root = document.getElementById('draft-content');
  if (!root) return;

  clearCountdown();

  const hasTeachers = state.assignedTeachers.length > 0;
  const isOrdenado = state.orderMode === 'ordenado';

  const teacherList = isOrdenado
    ? state.orderedTeacherIds.map((id, index) => {
        const name = teacherNameById(id) || 'Sin nombre';
        return `
          <li class="draft-reorder-item" data-teacher-id="${id}">
            <span class="draft-reorder-pos">${index + 1}</span>
            <span class="draft-reorder-name">${escapeHtml(name)}</span>
            <span class="draft-reorder-actions">
              <button type="button" class="btn btn-ghost draft-btn-sm" data-move-up="${id}"${index === 0 ? ' disabled' : ''}>↑</button>
              <button type="button" class="btn btn-ghost draft-btn-sm" data-move-down="${id}"${index === state.orderedTeacherIds.length - 1 ? ' disabled' : ''}>↓</button>
            </span>
          </li>
        `;
      }).join('')
    : state.assignedTeachers.map((t) =>
        `<li class="draft-teacher-preview">${escapeHtml(t.full_name || 'Sin nombre')}</li>`
      ).join('');

  root.innerHTML = `
    <section class="draft-section">
      <h3 class="draft-section-title">Iniciar draft semanal</h3>
      <p class="draft-lede">
        Elige el orden de turnos e inicia la ronda de reservaciones. Al iniciar se borran todas las reservaciones actuales.
        Las maestras deben estar asignadas en el horario antes de comenzar (pestaña <strong>Editar horario</strong>).
      </p>

      ${hasTeachers ? '' : `
        <p class="draft-empty">No hay maestras asignadas a franjas del horario. Asigna maestras en <strong>Editar horario</strong> antes de iniciar.</p>
      `}

      <div class="draft-order-mode">
        <span class="draft-order-label">Orden de turnos</span>
        <div class="draft-order-buttons">
          <button type="button" class="btn${state.orderMode === 'random' ? ' btn-primary' : ' btn-ghost'}" data-order-mode="random">Aleatorio</button>
          <button type="button" class="btn${state.orderMode === 'ordenado' ? ' btn-primary' : ' btn-ghost'}" data-order-mode="ordenado">Ordenado</button>
        </div>
      </div>

      ${hasTeachers ? `
        <div class="draft-teacher-block">
          <h4 class="draft-subtitle">${isOrdenado ? 'Orden de turnos (usa ↑ ↓)' : 'Maestras en el horario (el servidor elegirá el orden)'}</h4>
          <ul class="draft-reorder-list">${teacherList}</ul>
        </div>
      ` : ''}

      <div class="draft-actions">
        <button type="button" class="btn btn-primary" id="draft-iniciar"${hasTeachers ? '' : ' disabled'}>Iniciar draft</button>
      </div>
    </section>
  `;
}

function renderLive() {
  const root = document.getElementById('draft-content');
  if (!root) return;

  const session = state.session;
  const phaseLabel = PHASE_LABELS[session.phase] || session.phase;
  const isLive = session.phase === 'live';

  const turnRows = state.turns.map((turn) => {
    const name = teacherNameById(turn.teacher_id);
    const counts = pickCountsForTeacher(turn.teacher_id);
    const isActive = turn.status === 'active';
    return `
      <li class="draft-turn-row${isActive ? ' draft-turn-row-active' : ''}">
        <span class="draft-turn-pos">${turn.position}</span>
        <span class="draft-turn-name">${escapeHtml(name)}</span>
        <span class="draft-badge draft-badge-${turn.status}">${STATUS_LABELS[turn.status] || turn.status}</span>
        <span class="draft-turn-picks">${counts.confirmed}/${counts.total} confirmadas</span>
      </li>
    `;
  }).join('');

  root.innerHTML = `
    <section class="draft-section">
      <div class="draft-live-header">
        <span class="draft-phase-badge draft-phase-${session.phase}">${escapeHtml(phaseLabel)}</span>
        ${isLive ? `
          <div class="draft-countdown-wrap">
            <span class="draft-countdown-label">Tiempo restante</span>
            <span class="draft-countdown" id="draft-countdown">--:--</span>
          </div>
        ` : ''}
      </div>

      <h3 class="draft-section-title">Turnos</h3>
      <ul class="draft-turn-board">${turnRows || '<li class="draft-empty">Sin turnos</li>'}</ul>

      <div class="draft-actions">
        ${isLive ? '<button type="button" class="btn btn-primary" id="draft-advance">Avanzar turno</button>' : ''}
        <button type="button" class="btn btn-ghost" id="draft-reset">Reiniciar</button>
      </div>
    </section>
  `;

  if (isLive && session.turn_ends_at) {
    startCountdown(session.turn_ends_at);
  } else {
    clearCountdown();
  }
}

function startCountdown(turnEndsAt) {
  clearCountdown();
  const el = document.getElementById('draft-countdown');
  if (!el) return;

  function tick() {
    const endMs = new Date(turnEndsAt).getTime();
    const diff = endMs - Date.now();
    if (diff <= 0) {
      el.textContent = 'Tiempo agotado';
      el.classList.add('draft-countdown-expired');
      return;
    }
    el.classList.remove('draft-countdown-expired');
    const mm = Math.floor(diff / 60000);
    const ss = Math.floor((diff % 60000) / 1000);
    el.textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  tick();
  state.countdownInterval = setInterval(tick, 1000);
}

function moveTeacher(id, direction) {
  const idx = state.orderedTeacherIds.indexOf(id);
  if (idx === -1) return;
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= state.orderedTeacherIds.length) return;
  const next = [...state.orderedTeacherIds];
  [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
  state.orderedTeacherIds = next;
  renderSetup();
}

async function handleIniciar() {
  hideAlert();

  if (!state.assignedTeachers.length) {
    showAlert('Asigna maestras en el horario antes de iniciar.');
    return;
  }

  if (!confirm('¿Iniciar el draft? Esto borrará todas las reservaciones actuales y comenzará una ronda nueva.')) {
    return;
  }

  const btn = document.getElementById('draft-iniciar');
  if (btn) btn.disabled = true;

  try {
    const payload = { p_order_mode: state.orderMode };
    if (state.orderMode === 'ordenado') {
      payload.p_ordered_ids = state.orderedTeacherIds;
    }

    const { error } = await supabase.rpc('start_draft', payload);
    if (error) throw error;
    await refreshDraft();
  } catch (err) {
    showAlert(err.message || 'No se pudo iniciar el draft.');
    if (btn) btn.disabled = false;
  }
}

async function handleAdvance() {
  hideAlert();
  if (!confirm('¿Avanzar al siguiente turno? Las reservas no confirmadas de la maestra actual se descartarán.')) {
    return;
  }

  try {
    const { error } = await supabase.rpc('advance_turn');
    if (error) throw error;
    await refreshDraft();
  } catch (err) {
    showAlert(err.message || 'No se pudo avanzar el turno.');
  }
}

async function handleReset() {
  hideAlert();
  if (!confirm('¿Reiniciar por completo? Se borrarán todas las reservaciones y se cerrará la sesión actual.')) {
    return;
  }

  try {
    const { error } = await supabase.rpc('reset_draft');
    if (error) throw error;
    await refreshDraft();
  } catch (err) {
    showAlert(err.message || 'No se pudo reiniciar el draft.');
  }
}

async function refreshDraft() {
  state.session = await fetchSession();

  if (state.session) {
    state.turns = await fetchTurns(state.session.id);
    state.reservations = await fetchReservations(state.session.id);
    await loadTeacherNames();
    renderLive();
    return;
  }

  state.turns = [];
  state.reservations = [];
  state.assignedTeachers = await fetchAssignedTeachers();
  await loadTeacherNames();
  if (!state.orderedTeacherIds.length ||
    state.orderedTeacherIds.length !== state.assignedTeachers.length) {
    state.orderedTeacherIds = state.assignedTeachers.map((t) => t.id);
  } else {
    const valid = new Set(state.assignedTeachers.map((t) => t.id));
    state.orderedTeacherIds = state.orderedTeacherIds.filter((id) => valid.has(id));
    for (const t of state.assignedTeachers) {
      if (!state.orderedTeacherIds.includes(t.id)) {
        state.orderedTeacherIds.push(t.id);
      }
    }
  }
  renderSetup();
}

function onRealtimeChange() {
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    refreshDraft().catch((err) => {
      showAlert(err.message || 'No se pudo actualizar el draft.');
    });
  }, 150);
}

function subscribeDraft() {
  unsubscribeDraft();

  state.draftChannel = supabase
    .channel('admin-draft-panel')
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
  panel.addEventListener('click', (e) => {
    const modeBtn = e.target.closest('[data-order-mode]');
    if (modeBtn) {
      hideAlert();
      state.orderMode = modeBtn.dataset.orderMode;
      renderSetup();
      return;
    }

    const upBtn = e.target.closest('[data-move-up]');
    if (upBtn) {
      hideAlert();
      moveTeacher(upBtn.dataset.moveUp, 'up');
      return;
    }

    const downBtn = e.target.closest('[data-move-down]');
    if (downBtn) {
      hideAlert();
      moveTeacher(downBtn.dataset.moveDown, 'down');
      return;
    }

    if (e.target.closest('#draft-iniciar')) {
      handleIniciar();
      return;
    }

    if (e.target.closest('#draft-advance')) {
      handleAdvance();
      return;
    }

    if (e.target.closest('#draft-reset')) {
      handleReset();
    }
  });
}

export async function mountReservacionesSemanales(profile) {
  if (profile.role !== 'admin') return;

  cleanup();

  const panel = document.getElementById('panel-reservaciones-semanales');
  if (!panel) return;

  state.profile = profile;
  state.session = null;
  state.turns = [];
  state.reservations = [];
  state.assignedTeachers = [];
  state.orderMode = 'random';
  state.orderedTeacherIds = [];
  state.panel = panel;

  panel.innerHTML = buildPanelShell();
  wireEvents(panel);
  subscribeDraft();

  try {
    await refreshDraft();
  } catch (err) {
    showAlert(err.message || 'No se pudo cargar el panel de reservaciones.');
  }
}
