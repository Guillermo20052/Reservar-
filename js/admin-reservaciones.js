import { supabase } from './supabase.js';
import {
  upcomingWeekStart,
  currentWeekStart,
  addWeeks,
  fromIsoDate,
  toIsoDate,
  mondayOf,
  formatWeekStart,
  weekRelation,
} from './week-utils.js';

const STATUS_LABELS = {
  pending: 'Pendiente',
  active: 'Activo',
  done: 'Hecho',
  skipped: 'Saltado',
};

const PHASE_LABELS = {
  setup: 'Preparación',
  live: 'En vivo',
  open: 'Abierto',
  closed: 'Cerrado',
};

const RELATION_LABELS = {
  pasada: 'Semana pasada',
  actual: 'Semana actual',
  futura: 'Semana futura',
};

const WEEKDAYS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'];

const WEEKDAY_LABELS = {
  lunes: 'Lunes',
  martes: 'Martes',
  miercoles: 'Miércoles',
  jueves: 'Jueves',
  viernes: 'Viernes',
};

/** @type {{
 *   profile: object | null,
 *   weekStart: string,
 *   view: 'draft' | 'historial',
 *   session: object | null,
 *   weekHasSession: boolean,
 *   turns: object[],
 *   reservations: object[],
 *   weekConfirmedCount: number,
 *   assignedTeachers: object[],
 *   teacherNames: Record<string, string>,
 *   orderMode: 'random' | 'ordenado' | 'open',
 *   orderedTeacherIds: string[],
 *   historyWeeks: object[],
 *   historyOpenWeek: string | null,
 *   historyRows: object[],
 *   draftChannel: object | null,
 *   countdownInterval: ReturnType<typeof setInterval> | null,
 *   debounceTimer: ReturnType<typeof setTimeout> | null,
 *   panel: HTMLElement | null,
 * }} */
const state = {
  profile: null,
  weekStart: upcomingWeekStart(),
  view: 'draft',
  session: null,
  weekHasSession: false,
  turns: [],
  reservations: [],
  weekConfirmedCount: 0,
  assignedTeachers: [],
  teacherNames: {},
  orderMode: 'random',
  orderedTeacherIds: [],
  historyWeeks: [],
  historyOpenWeek: null,
  historyRows: [],
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

function formatTime(time) {
  if (!time) return '';
  return String(time).slice(0, 5);
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

/**
 * The newest session for the selected week, whatever its phase. A draft for a
 * different week (past history, or a future week prepared in advance) is never
 * returned — that is the whole point of week scoping.
 */
async function fetchSession(weekStart) {
  const { data, error } = await supabase
    .from('draft_sessions')
    .select('id, phase, order_mode, current_position, turn_ends_at, started_at, created_at, week_start')
    .eq('week_start', weekStart)
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

/** Confirmed rows already banked for a week — what start_draft will PRESERVE. */
async function fetchWeekConfirmedCount(weekStart) {
  const { count, error } = await supabase
    .from('reservations')
    .select('id', { count: 'exact', head: true })
    .eq('week_start', weekStart)
    .eq('confirmed', true);
  if (error) throw error;
  return count ?? 0;
}

async function fetchAssignedTeachers() {
  /** @type {Set<string>} */
  const ids = new Set();

  const { data: assigned, error: assignError } = await supabase
    .from('timetable_slot_teachers')
    .select('teacher_id');

  if (!assignError) {
    for (const row of assigned ?? []) {
      if (row.teacher_id) ids.add(row.teacher_id);
    }
  }

  const { data: partTeachers, error: partError } = await supabase
    .from('timetable_slot_part_teachers')
    .select('teacher_id');

  if (!partError) {
    for (const row of partTeachers ?? []) {
      if (row.teacher_id) ids.add(row.teacher_id);
    }
  }

  const { data: legacy, error: legacyError } = await supabase
    .from('timetable_slots')
    .select('teacher_id')
    .not('teacher_id', 'is', null);

  if (legacyError && ids.size === 0) throw legacyError;

  for (const row of legacy ?? []) {
    if (row.teacher_id) ids.add(row.teacher_id);
  }

  const nameMap = await fetchProfileNameMap([...ids]);

  return [...ids]
    .map((id) => ({ id, full_name: nameMap[id] ?? null }))
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '', 'es'));
}

function pickCountsForTeacher(teacherId) {
  const picks = state.reservations.filter((r) => r.teacher_id === teacherId);
  const confirmed = picks.filter((r) => r.confirmed).length;
  return { total: picks.length, confirmed };
}

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------

/** Every week that ever had a draft, newest first, with its confirmed total. */
async function fetchHistoryWeeks() {
  const { data: sessions, error: sessionError } = await supabase
    .from('draft_sessions')
    .select('id, week_start, phase, order_mode, started_at, created_at')
    .order('week_start', { ascending: false })
    .order('created_at', { ascending: false });
  if (sessionError) throw sessionError;

  const { data: confirmed, error: confirmedError } = await supabase
    .from('reservations')
    .select('week_start')
    .eq('confirmed', true);
  if (confirmedError) throw confirmedError;

  /** @type {Record<string, number>} */
  const counts = {};
  for (const row of confirmed ?? []) {
    counts[row.week_start] = (counts[row.week_start] ?? 0) + 1;
  }

  /** @type {Map<string, object>} */
  const byWeek = new Map();
  for (const s of sessions ?? []) {
    if (!byWeek.has(s.week_start)) {
      byWeek.set(s.week_start, {
        week_start: s.week_start,
        phase: s.phase,
        order_mode: s.order_mode,
        started_at: s.started_at,
        sessions: 0,
        confirmed: counts[s.week_start] ?? 0,
      });
    }
    byWeek.get(s.week_start).sessions += 1;
  }

  // A week can hold reservations without a surviving session row (legacy rows
  // backfilled by sql/draft_weeks.sql) — list it anyway so nothing is hidden.
  for (const week of Object.keys(counts)) {
    if (!byWeek.has(week)) {
      byWeek.set(week, {
        week_start: week,
        phase: null,
        order_mode: null,
        started_at: null,
        sessions: 0,
        confirmed: counts[week],
      });
    }
  }

  return [...byWeek.values()].sort((a, b) => (a.week_start < b.week_start ? 1 : -1));
}

/** Read-only confirmed assignments for one past week. */
async function fetchHistoryRows(weekStart) {
  const { data, error } = await supabase
    .from('reservations')
    .select(`
      id, day, start_time, teacher_id, space_id, week_start,
      spaces(name),
      timetable_slots(grade, classes(name)),
      timetable_slot_parts(classes(name))
    `)
    .eq('week_start', weekStart)
    .eq('confirmed', true)
    .order('day')
    .order('start_time');
  if (error) throw error;

  const rows = data ?? [];
  const names = await fetchProfileNameMap(rows.map((r) => r.teacher_id));
  return rows.map((r) => ({
    id: r.id,
    day: r.day,
    start_time: r.start_time,
    grade: r.timetable_slots?.grade || '—',
    class_name: r.timetable_slot_parts?.classes?.name
      || r.timetable_slots?.classes?.name
      || 'Clase',
    space_name: r.spaces?.name || '—',
    teacher_name: names[r.teacher_id] || 'Sin nombre',
  }));
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function buildPanelShell() {
  return `
    <h2 class="panel-title">Reservaciones semanales</h2>
    <div id="draft-alert" class="alert alert-error" hidden></div>
    <div class="draft-viewbar">
      <button type="button" class="tab draft-viewtab" data-view="draft">Draft</button>
      <button type="button" class="tab draft-viewtab" data-view="historial">Historial</button>
    </div>
    <div id="draft-weekbar"></div>
    <div id="draft-content"></div>
  `;
}

function renderViewTabs() {
  const panel = state.panel;
  if (!panel) return;
  panel.querySelectorAll('.draft-viewtab').forEach((btn) => {
    const active = btn.dataset.view === state.view;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
}

function renderWeekBar() {
  const bar = document.getElementById('draft-weekbar');
  if (!bar) return;

  if (state.view !== 'draft') {
    bar.innerHTML = '';
    return;
  }

  const relation = weekRelation(state.weekStart);

  bar.innerHTML = `
    <section class="draft-weekbar">
      <div class="draft-weekbar-nav">
        <button type="button" class="btn btn-ghost draft-btn-sm" id="draft-week-prev" aria-label="Semana anterior">◀</button>
        <div class="draft-weekbar-main">
          <span class="draft-weekbar-label">${escapeHtml(formatWeekStart(state.weekStart))}</span>
          <span class="badge draft-week-chip draft-week-chip-${relation}">${RELATION_LABELS[relation]}</span>
        </div>
        <button type="button" class="btn btn-ghost draft-btn-sm" id="draft-week-next" aria-label="Semana siguiente">▶</button>
      </div>
      <div class="draft-weekbar-controls">
        <label class="draft-week-input-label" for="draft-week-input">Semana (lunes)</label>
        <input type="date" class="input draft-week-input" id="draft-week-input" value="${state.weekStart}">
        <button type="button" class="btn btn-ghost draft-btn-sm" data-week-jump="current">Semana actual</button>
        <button type="button" class="btn btn-ghost draft-btn-sm" data-week-jump="upcoming">Próxima semana</button>
      </div>
    </section>
  `;
}

function renderSetup() {
  const root = document.getElementById('draft-content');
  if (!root) return;

  clearCountdown();

  const hasTeachers = state.assignedTeachers.length > 0;
  const isOrdenado = state.orderMode === 'ordenado';
  const isOpen = state.orderMode === 'open';
  const weekLabel = formatWeekStart(state.weekStart);

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

  // The scope sentence has to be exact: start_draft only ever touches the
  // selected week, and it keeps that week's already-confirmed rows when the
  // week has run before.
  const scopeText = state.weekHasSession
    ? `Solo afecta a <strong>${escapeHtml(weekLabel.toLowerCase())}</strong>: se conservan sus ${state.weekConfirmedCount} reservacion${state.weekConfirmedCount === 1 ? '' : 'es'} confirmada${state.weekConfirmedCount === 1 ? '' : 's'} y se borran las pendientes. Las demás semanas no se tocan.`
    : `Solo afecta a <strong>${escapeHtml(weekLabel.toLowerCase())}</strong>. Las reservaciones de otras semanas no se tocan.`;

  const ledeText = isOpen
    ? 'Todas las maestras podrán reservar sus espacios al mismo tiempo, sin turnos ni límite de tiempo.'
    : 'Elige el orden de turnos e inicia la ronda de reservaciones.';

  const teacherBlockTitle = isOpen
    ? 'Maestras en el horario (registro libre simultáneo)'
    : isOrdenado
      ? 'Orden de turnos (usa ↑ ↓)'
      : 'Maestras en el horario (el servidor elegirá el orden)';

  const closedNote = state.session && state.session.phase === 'closed'
    ? `<p class="draft-lede">Esta semana ya tuvo un draft (cerrado). Sus reservaciones confirmadas siguen en el <strong>Historial</strong>.</p>`
    : '';

  root.innerHTML = `
    <section class="draft-section">
      <h3 class="draft-section-title">${isOpen ? 'Iniciar registro abierto' : 'Iniciar draft semanal'}</h3>
      <p class="draft-lede">
        ${ledeText}
        ${scopeText}
        Las maestras deben estar asignadas en el horario antes de comenzar (pestaña <strong>Editar horario</strong>).
      </p>
      ${closedNote}

      ${hasTeachers ? '' : `
        <p class="draft-empty">No hay maestras asignadas a franjas del horario. Asigna maestras en <strong>Editar horario</strong> antes de iniciar.</p>
      `}

      <div class="draft-order-mode">
        <span class="draft-order-label">Modo</span>
        <div class="draft-order-buttons">
          <button type="button" class="btn${state.orderMode === 'random' ? ' btn-primary' : ' btn-ghost'}" data-order-mode="random">Aleatorio</button>
          <button type="button" class="btn${state.orderMode === 'ordenado' ? ' btn-primary' : ' btn-ghost'}" data-order-mode="ordenado">Ordenado</button>
          <button type="button" class="btn${state.orderMode === 'open' ? ' btn-primary' : ' btn-ghost'}" data-order-mode="open">Open</button>
        </div>
      </div>

      ${hasTeachers ? `
        <div class="draft-teacher-block">
          <h4 class="draft-subtitle">${teacherBlockTitle}</h4>
          <ul class="draft-reorder-list">${teacherList}</ul>
        </div>
      ` : ''}

      <div class="draft-actions">
        <button type="button" class="btn btn-primary" id="draft-iniciar"${hasTeachers ? '' : ' disabled'}>${isOpen ? 'Iniciar registro abierto' : 'Iniciar draft'}</button>
      </div>
    </section>
  `;
}

function renderLive() {
  const root = document.getElementById('draft-content');
  if (!root) return;

  const session = state.session;
  if (session.phase === 'open') {
    renderOpenSession();
    return;
  }

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
        <span class="badge badge--${turn.status} draft-badge draft-badge-${turn.status}">${STATUS_LABELS[turn.status] || turn.status}</span>
        <span class="draft-turn-picks">${counts.confirmed}/${counts.total} confirmadas</span>
      </li>
    `;
  }).join('');

  root.innerHTML = `
    <section class="draft-section">
      <div class="draft-live-header">
        <span class="badge badge--phase badge--phase-${session.phase} draft-phase-badge draft-phase-${session.phase}">${escapeHtml(phaseLabel)}</span>
        <span class="draft-live-week">${escapeHtml(formatWeekStart(session.week_start))}</span>
        ${isLive ? `
          <div class="draft-countdown-panel">
            <div class="draft-countdown-wrap">
              <span class="draft-countdown-label">Tiempo restante</span>
              <span class="draft-countdown" id="draft-countdown">--:--</span>
            </div>
          </div>
        ` : ''}
      </div>

      <h3 class="draft-section-title">Turnos</h3>
      <ul class="draft-turn-board">${turnRows || '<li class="draft-empty">Sin turnos</li>'}</ul>

      <div class="draft-actions">
        ${isLive ? '<button type="button" class="btn btn-primary" id="draft-advance">Avanzar turno</button>' : ''}
        <button type="button" class="btn btn-ghost" id="draft-reset">Reiniciar esta semana</button>
      </div>
    </section>
  `;

  if (isLive && session.turn_ends_at) {
    startCountdown(session.turn_ends_at);
  } else {
    clearCountdown();
  }
}

function renderOpenSession() {
  const root = document.getElementById('draft-content');
  if (!root) return;

  clearCountdown();

  const session = state.session;
  const startedDirectly = session.order_mode === 'open';

  const teacherRows = state.assignedTeachers.map((t) => {
    const counts = pickCountsForTeacher(t.id);
    return `
      <li class="draft-turn-row">
        <span class="draft-turn-name">${escapeHtml(t.full_name || 'Sin nombre')}</span>
        <span class="draft-turn-picks">${counts.confirmed}/${counts.total} confirmadas</span>
      </li>
    `;
  }).join('');

  const turnHistory = !startedDirectly && state.turns.length
    ? `
      <h3 class="draft-section-title">Turnos completados</h3>
      <ul class="draft-turn-board">
        ${state.turns.map((turn) => {
          const name = teacherNameById(turn.teacher_id);
          return `
            <li class="draft-turn-row">
              <span class="draft-turn-pos">${turn.position}</span>
              <span class="draft-turn-name">${escapeHtml(name)}</span>
              <span class="badge badge--${turn.status} draft-badge draft-badge-${turn.status}">${STATUS_LABELS[turn.status] || turn.status}</span>
            </li>
          `;
        }).join('')}
      </ul>
    `
    : '';

  root.innerHTML = `
    <section class="draft-section">
      <div class="draft-live-header">
        <span class="badge badge--phase badge--phase-open draft-phase-badge draft-phase-open">Abierto</span>
        <span class="draft-live-week">${escapeHtml(formatWeekStart(session.week_start))}</span>
      </div>

      <p class="draft-lede">
        ${startedDirectly
          ? 'Registro libre activo — todas las maestras pueden reservar sus espacios sin turnos.'
          : 'Fase abierta — las maestras que no terminaron en su turno pueden completar sus reservas.'}
      </p>

      <h3 class="draft-section-title">Progreso de reservas</h3>
      <ul class="draft-turn-board">${teacherRows || '<li class="draft-empty">Sin maestras</li>'}</ul>

      ${turnHistory}

      <div class="draft-actions">
        <button type="button" class="btn btn-ghost" id="draft-reset">Reiniciar esta semana</button>
      </div>
    </section>
  `;
}

function renderHistorial() {
  const root = document.getElementById('draft-content');
  if (!root) return;

  clearCountdown();

  if (!state.historyWeeks.length) {
    root.innerHTML = `
      <section class="draft-section">
        <h3 class="draft-section-title">Historial</h3>
        <p class="draft-empty">Todavía no hay semanas registradas.</p>
      </section>
    `;
    return;
  }

  const weekRows = state.historyWeeks.map((w) => {
    const relation = weekRelation(w.week_start);
    const isOpenRow = state.historyOpenWeek === w.week_start;
    const phaseLabel = w.phase ? (PHASE_LABELS[w.phase] || w.phase) : 'Sin sesión';

    return `
      <li class="draft-history-week${isOpenRow ? ' draft-history-week-open' : ''}">
        <div class="draft-history-head">
          <span class="draft-history-label">${escapeHtml(formatWeekStart(w.week_start))}</span>
          <span class="badge draft-week-chip draft-week-chip-${relation}">${RELATION_LABELS[relation]}</span>
          <span class="badge badge--phase draft-phase-badge draft-phase-${w.phase || 'closed'}">${escapeHtml(phaseLabel)}</span>
          <span class="draft-history-count">${w.confirmed} confirmada${w.confirmed === 1 ? '' : 's'}</span>
          <button type="button" class="btn btn-ghost draft-btn-sm" data-history-week="${w.week_start}">
            ${isOpenRow ? 'Ocultar' : 'Ver asignaciones'}
          </button>
        </div>
        ${isOpenRow ? renderHistoryDetail() : ''}
      </li>
    `;
  }).join('');

  root.innerHTML = `
    <section class="draft-section">
      <h3 class="draft-section-title">Historial por semana</h3>
      <p class="draft-lede">Asignaciones confirmadas de cada semana. Solo lectura — para modificar una semana usa la pestaña <strong>Draft</strong>.</p>
      <ul class="draft-history-list">${weekRows}</ul>
    </section>
  `;
}

function renderHistoryDetail() {
  if (!state.historyRows.length) {
    return '<p class="draft-empty">Sin asignaciones confirmadas en esta semana.</p>';
  }

  const byDay = WEEKDAYS.map((day) => {
    const rows = state.historyRows.filter((r) => r.day === day);
    if (!rows.length) return '';
    const items = rows.map((r) => `
      <li class="draft-history-row">
        <span class="draft-history-time">${formatTime(r.start_time)}</span>
        <span class="draft-history-grade">${escapeHtml(r.grade)}</span>
        <span class="draft-history-class">${escapeHtml(r.class_name)}</span>
        <span class="draft-history-teacher">${escapeHtml(r.teacher_name)}</span>
        <span class="chip horario-view-space-chip">${escapeHtml(r.space_name)}</span>
      </li>
    `).join('');
    return `
      <div class="draft-history-day">
        <h4 class="draft-subtitle">${WEEKDAY_LABELS[day]}</h4>
        <ul class="draft-history-rows">${items}</ul>
      </div>
    `;
  }).join('');

  return `<div class="draft-history-detail">${byDay}</div>`;
}

function renderContent() {
  renderViewTabs();
  renderWeekBar();

  if (state.view === 'historial') {
    renderHistorial();
    return;
  }

  if (state.session && state.session.phase !== 'closed') {
    renderLive();
    return;
  }

  renderSetup();
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

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function handleIniciar() {
  hideAlert();

  if (!state.assignedTeachers.length) {
    showAlert('Asigna maestras en el horario antes de iniciar.');
    return;
  }

  const weekLabel = formatWeekStart(state.weekStart).toLowerCase();
  const scope = state.weekHasSession
    ? `Se conservarán las reservaciones confirmadas de esa semana y se borrarán las pendientes.`
    : `No se tocarán las reservaciones de otras semanas.`;

  if (!confirm(
    state.orderMode === 'open'
      ? `¿Iniciar registro abierto para la ${weekLabel}? Todas las maestras podrán reservar al mismo tiempo. ${scope}`
      : `¿Iniciar el draft para la ${weekLabel}? ${scope}`
  )) {
    return;
  }

  const btn = document.getElementById('draft-iniciar');
  if (btn) btn.disabled = true;

  try {
    const payload = {
      p_week_start: state.weekStart,
      p_order_mode: state.orderMode,
    };
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
    // Target the session this panel is showing: a draft prepared for another
    // week can also be non-closed, and the no-arg form would advance that one.
    const { error } = await supabase.rpc('advance_turn', {
      p_session_id: state.session?.id ?? null,
    });
    if (error) throw error;
    await refreshDraft();
  } catch (err) {
    showAlert(err.message || 'No se pudo avanzar el turno.');
  }
}

async function handleReset() {
  hideAlert();
  const weekLabel = formatWeekStart(state.weekStart).toLowerCase();
  if (!confirm(`¿Reiniciar la ${weekLabel}? Se borrarán TODAS sus reservaciones (incluidas las confirmadas) y se cerrará su sesión. Las demás semanas no se tocan.`)) {
    return;
  }

  try {
    const { error } = await supabase.rpc('reset_draft', { p_week_start: state.weekStart });
    if (error) throw error;
    await refreshDraft();
  } catch (err) {
    showAlert(err.message || 'No se pudo reiniciar el draft.');
  }
}

function setWeek(weekStartIso) {
  const monday = toIsoDate(mondayOf(fromIsoDate(weekStartIso)));
  if (monday === state.weekStart) {
    // Typing any day of the already-selected week: snap the input back to Monday.
    renderWeekBar();
    return;
  }
  state.weekStart = monday;
  hideAlert();
  refreshDraft().catch((err) => {
    showAlert(err.message || 'No se pudo cargar la semana.');
  });
}

async function setView(view) {
  if (state.view === view) return;
  state.view = view;
  hideAlert();
  clearCountdown();
  if (view === 'historial') {
    await refreshHistorial();
  } else {
    await refreshDraft();
  }
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

async function refreshDraft() {
  state.session = await fetchSession(state.weekStart);
  state.weekHasSession = Boolean(state.session);
  state.weekConfirmedCount = await fetchWeekConfirmedCount(state.weekStart);
  state.assignedTeachers = await fetchAssignedTeachers();

  if (state.session) {
    state.turns = await fetchTurns(state.session.id);
    state.reservations = await fetchReservations(state.session.id);
  } else {
    state.turns = [];
    state.reservations = [];
  }

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

  renderContent();
}

async function refreshHistorial() {
  state.historyWeeks = await fetchHistoryWeeks();
  if (state.historyOpenWeek) {
    state.historyRows = await fetchHistoryRows(state.historyOpenWeek);
  } else {
    state.historyRows = [];
  }
  renderContent();
}

async function refreshCurrentView() {
  if (state.view === 'historial') {
    await refreshHistorial();
    return;
  }
  await refreshDraft();
}

function onRealtimeChange() {
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    refreshCurrentView().catch((err) => {
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
  panel.addEventListener('change', (e) => {
    if (e.target.id !== 'draft-week-input') return;
    if (!e.target.value) return;
    setWeek(e.target.value);
  });

  panel.addEventListener('click', (e) => {
    const viewBtn = e.target.closest('[data-view]');
    if (viewBtn) {
      hideAlert();
      setView(viewBtn.dataset.view).catch((err) => {
        showAlert(err.message || 'No se pudo cambiar de vista.');
      });
      return;
    }

    if (e.target.closest('#draft-week-prev')) {
      setWeek(addWeeks(state.weekStart, -1));
      return;
    }

    if (e.target.closest('#draft-week-next')) {
      setWeek(addWeeks(state.weekStart, 1));
      return;
    }

    const jumpBtn = e.target.closest('[data-week-jump]');
    if (jumpBtn) {
      setWeek(jumpBtn.dataset.weekJump === 'current' ? currentWeekStart() : upcomingWeekStart());
      return;
    }

    const historyBtn = e.target.closest('[data-history-week]');
    if (historyBtn) {
      hideAlert();
      const week = historyBtn.dataset.historyWeek;
      state.historyOpenWeek = state.historyOpenWeek === week ? null : week;
      refreshHistorial().catch((err) => {
        showAlert(err.message || 'No se pudo cargar el historial.');
      });
      return;
    }

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
  state.weekStart = upcomingWeekStart();
  state.view = 'draft';
  state.session = null;
  state.weekHasSession = false;
  state.turns = [];
  state.reservations = [];
  state.weekConfirmedCount = 0;
  state.assignedTeachers = [];
  state.orderMode = 'random';
  state.orderedTeacherIds = [];
  state.historyWeeks = [];
  state.historyOpenWeek = null;
  state.historyRows = [];
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
