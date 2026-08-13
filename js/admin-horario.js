import { supabase } from './supabase.js';

const GRADES = ['10mo', '11vo', '12vo'];
const WEEKDAYS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'];

// Multi (IB) slots: up to 5 classes per time slot, at least 2 required.
const MAX_MULTI_PARTS = 5;
const MIN_MULTI_PARTS = 2;
const MULTI_PART_INDEXES = Array.from({ length: MAX_MULTI_PARTS }, (_, i) => i + 1);
const MULTI_PART_LETTERS = ['A', 'B', 'C', 'D', 'E'];

function partLetter(partIndex) {
  return MULTI_PART_LETTERS[partIndex - 1] ?? String(partIndex);
}

const WEEKDAY_LABELS = {
  lunes: 'Lunes',
  martes: 'Martes',
  miercoles: 'Miércoles',
  jueves: 'Jueves',
  viernes: 'Viernes',
};

const SLOT_SELECT = `
  id, class_id, grade, day, start_time, end_time, teacher_id, is_multi,
  timetable_slot_teachers(teacher_id),
  timetable_slot_parts(
    id, part_index, class_id, classes(name),
    timetable_slot_part_teachers(teacher_id)
  )
`;

/** @type {{
 *   profile: object,
 *   grade: string,
 *   classes: object[],
 *   teachers: object[],
 *   slots: object[],
 *   slotCountByClass: Record<string, number>,
 *   editingSlotId: string | null,
 *   formMulti: boolean,
 * }} */
const state = {
  profile: null,
  grade: '10mo',
  classes: [],
  teachers: [],
  slots: [],
  slotCountByClass: {},
  editingSlotId: null,
  formMulti: false,
};

function formatTime(time) {
  if (!time) return '';
  return String(time).slice(0, 5);
}

function timeToMinutes(time) {
  const [h, m] = formatTime(time).split(':').map(Number);
  return h * 60 + m;
}

function showAlert(message) {
  const el = document.getElementById('horario-alert');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function hideAlert() {
  const el = document.getElementById('horario-alert');
  if (el) el.hidden = true;
}

function classNameById(id) {
  return state.classes.find((c) => c.id === id)?.name ?? '—';
}

function teacherNameById(id) {
  if (!id) return 'Sin asignar';
  return state.teachers.find((t) => t.id === id)?.full_name ?? 'Sin asignar';
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

function normalizeParts(slot) {
  return (slot.timetable_slot_parts ?? [])
    .slice()
    .sort((a, b) => a.part_index - b.part_index)
    .map((part) => ({
      id: part.id,
      part_index: part.part_index,
      class_id: part.class_id,
      class_name: part.classes?.name ?? classNameById(part.class_id),
      teacher_ids: partTeacherIds(part),
    }));
}

function normalizeSlot(slot) {
  const parts = normalizeParts(slot);
  const isMulti = Boolean(slot.is_multi) && parts.length > 0;
  return {
    ...slot,
    is_multi: isMulti,
    parts,
    teacher_ids: isMulti ? [] : slotTeacherIds(slot),
  };
}

function slotCountForClass(classId) {
  return state.slotCountByClass[classId] ?? 0;
}

function slotCountLabel(count) {
  if (count === 0) return '· Sin franjas en el horario';
  if (count === 1) return '· 1 franja en el horario';
  return `· ${count} franjas en el horario`;
}

function teacherNamesLabel(teacherIds) {
  if (!teacherIds.length) return 'Sin asignar';
  return teacherIds.map((id) => teacherNameById(id)).join(', ');
}

function classOptionsHtml(selectedId = '') {
  return state.classes
    .map((c) => {
      const selected = c.id === selectedId ? ' selected' : '';
      return `<option value="${c.id}"${selected}>${escapeHtml(c.name)}</option>`;
    })
    .join('');
}

async function fetchClasses() {
  const { data, error } = await supabase.from('classes').select('id, name').order('name');
  if (error) throw error;
  return data ?? [];
}

async function fetchTeachers() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'teacher')
    .order('full_name');
  if (error) throw error;
  return data ?? [];
}

async function fetchSlots(grade) {
  const { data, error } = await supabase
    .from('timetable_slots')
    .select(SLOT_SELECT)
    .eq('grade', grade);

  if (error) {
    const { data: legacy, error: legacyError } = await supabase
      .from('timetable_slots')
      .select('id, class_id, grade, day, start_time, end_time, teacher_id, is_multi')
      .eq('grade', grade);
    if (legacyError) throw legacyError;
    return (legacy ?? []).map((slot) => normalizeSlot({ ...slot, timetable_slot_parts: [] }));
  }

  return (data ?? []).map(normalizeSlot);
}

async function fetchSlotCountsByClass() {
  /** @type {Record<string, number>} */
  const counts = {};

  const { data: slots, error: slotsError } = await supabase
    .from('timetable_slots')
    .select('class_id, is_multi');
  if (slotsError) throw slotsError;

  for (const row of slots ?? []) {
    if (!row.is_multi) {
      counts[row.class_id] = (counts[row.class_id] ?? 0) + 1;
    }
  }

  const { data: parts, error: partsError } = await supabase
    .from('timetable_slot_parts')
    .select('class_id');
  if (!partsError) {
    for (const row of parts ?? []) {
      counts[row.class_id] = (counts[row.class_id] ?? 0) + 1;
    }
  }

  return counts;
}

async function syncSlotTeachers(slotId, teacherIds) {
  const { error: deleteError } = await supabase
    .from('timetable_slot_teachers')
    .delete()
    .eq('slot_id', slotId);
  if (deleteError) throw deleteError;

  if (!teacherIds.length) return;

  const { error: insertError } = await supabase.from('timetable_slot_teachers').insert(
    teacherIds.map((teacher_id) => ({ slot_id: slotId, teacher_id }))
  );
  if (insertError) throw insertError;
}

async function syncSlotParts(slotId, parts) {
  const { data: existingParts, error: fetchError } = await supabase
    .from('timetable_slot_parts')
    .select('id')
    .eq('slot_id', slotId);
  if (fetchError) throw fetchError;

  const existingIds = (existingParts ?? []).map((row) => row.id);

  if (existingIds.length) {
    const { error: deleteTeachersError } = await supabase
      .from('timetable_slot_part_teachers')
      .delete()
      .in('part_id', existingIds);
    if (deleteTeachersError) throw deleteTeachersError;
  }

  const { error: deletePartsError } = await supabase
    .from('timetable_slot_parts')
    .delete()
    .eq('slot_id', slotId);
  if (deletePartsError) throw deletePartsError;

  if (!parts?.length) return;

  for (const part of parts) {
    const { data: inserted, error: insertPartError } = await supabase
      .from('timetable_slot_parts')
      .insert({
        slot_id: slotId,
        class_id: part.class_id,
        part_index: part.part_index,
      })
      .select('id')
      .single();
    if (insertPartError) throw insertPartError;

    if (part.teacher_ids.length) {
      const { error: insertTeachersError } = await supabase
        .from('timetable_slot_part_teachers')
        .insert(
          part.teacher_ids.map((teacher_id) => ({
            part_id: inserted.id,
            teacher_id,
          }))
        );
      if (insertTeachersError) throw insertTeachersError;
    }
  }
}

function getSelectedDays() {
  return WEEKDAYS.filter((day) =>
    document.querySelector(`.horario-day-checkbox[data-day="${day}"]`)?.checked
  );
}

function setSelectedDays(days) {
  const set = new Set(days);
  document.querySelectorAll('.horario-day-checkbox').forEach((cb) => {
    cb.checked = set.has(cb.value);
  });
}

function updateDayEditLock() {
  const hint = document.getElementById('horario-day-hint');
  if (hint) hint.hidden = !state.editingSlotId;
}

const DEFAULT_TIME_PRESETS = [
  ['07:45', '09:00'],
  ['09:00', '10:15'],
  ['10:15', '11:30'],
  ['11:30', '12:45'],
  ['12:45', '14:00'],
];

function timePresetPairs() {
  /** @type {Map<string, [string, string]>} */
  const pairs = new Map();
  for (const slot of state.slots) {
    const start = formatTime(slot.start_time);
    const end = formatTime(slot.end_time);
    if (!start || !end) continue;
    pairs.set(`${start}|${end}`, [start, end]);
  }
  if (pairs.size < 3) {
    for (const [start, end] of DEFAULT_TIME_PRESETS) {
      pairs.set(`${start}|${end}`, [start, end]);
    }
  }
  return [...pairs.values()]
    .sort((a, b) => timeToMinutes(a[0]) - timeToMinutes(b[0]))
    .slice(0, 7);
}

function renderTimePresets() {
  const root = document.getElementById('horario-time-presets');
  if (!root) return;
  root.innerHTML = timePresetPairs()
    .map(
      ([start, end]) =>
        `<button type="button" class="horario-time-preset" data-start="${start}" data-end="${end}">${start} – ${end}</button>`
    )
    .join('');
  syncActiveTimePreset();
}

function syncActiveTimePreset() {
  const start = document.getElementById('horario-slot-start')?.value ?? '';
  const end = document.getElementById('horario-slot-end')?.value ?? '';
  document.querySelectorAll('.horario-time-preset').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.start === start && btn.dataset.end === end);
  });
}

let toastTimer = null;

function showToast(html) {
  const toast = document.getElementById('horario-toast');
  if (!toast) return;
  toast.innerHTML = html;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4200);
}

/**
 * Styled confirm dialog. Resolves true when the user accepts.
 * When `ackLabel` is given, an explicit acknowledgement checkbox must be
 * checked before the accept button becomes enabled.
 */
function openConfirmDialog({ title, text, ackLabel = '', acceptLabel = 'Eliminar' }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('horario-confirm-overlay');
    const titleEl = document.getElementById('horario-confirm-title');
    const textEl = document.getElementById('horario-confirm-text');
    const ackRow = document.getElementById('horario-confirm-ack-row');
    const ackBox = document.getElementById('horario-confirm-ack');
    const ackLabelEl = document.getElementById('horario-confirm-ack-label');
    const cancelBtn = document.getElementById('horario-confirm-cancel');
    const acceptBtn = document.getElementById('horario-confirm-accept');

    if (!overlay || !titleEl || !textEl || !ackRow || !ackBox || !cancelBtn || !acceptBtn) {
      resolve(window.confirm(text));
      return;
    }

    titleEl.textContent = title;
    textEl.innerHTML = text;
    acceptBtn.textContent = acceptLabel;

    const needsAck = Boolean(ackLabel);
    ackRow.hidden = !needsAck;
    ackBox.checked = false;
    if (ackLabelEl) ackLabelEl.textContent = ackLabel;
    acceptBtn.disabled = needsAck;

    const close = (result) => {
      overlay.hidden = true;
      ackBox.removeEventListener('change', onAck);
      cancelBtn.removeEventListener('click', onCancel);
      acceptBtn.removeEventListener('click', onAccept);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    const onAck = () => {
      acceptBtn.disabled = needsAck && !ackBox.checked;
    };
    const onCancel = () => close(false);
    const onAccept = () => close(true);
    const onBackdrop = (e) => {
      if (e.target === overlay) close(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
    };

    ackBox.addEventListener('change', onAck);
    cancelBtn.addEventListener('click', onCancel);
    acceptBtn.addEventListener('click', onAccept);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);

    overlay.hidden = false;
    (needsAck ? ackBox : cancelBtn).focus();
  });
}

function getSelectedTeacherIds() {
  return [...document.querySelectorAll('.horario-teacher-checkbox:checked')].map(
    (input) => input.dataset.teacherId
  );
}

function getPartTeacherIds(partIndex) {
  return [
    ...document.querySelectorAll(
      `.horario-part-teacher-checkbox[data-part="${partIndex}"]:checked`
    ),
  ].map((input) => input.dataset.teacherId);
}

function getMultiFormParts() {
  return MULTI_PART_INDEXES.map((partIndex) => ({
    part_index: partIndex,
    class_id: document.getElementById(`horario-part-class-${partIndex}`)?.value ?? '',
    teacher_ids: getPartTeacherIds(partIndex),
  }));
}

function setFormMulti(isMulti) {
  state.formMulti = isMulti;

  const toggle = document.getElementById('horario-toggle-multi');
  const singleFields = document.getElementById('horario-single-fields');
  const multiFields = document.getElementById('horario-multi-fields');
  const classSelect = document.getElementById('horario-slot-class');

  if (toggle) {
    toggle.classList.toggle('btn-primary', isMulti);
    toggle.classList.toggle('btn-ghost', !isMulti);
  }
  if (singleFields) singleFields.hidden = isMulti;
  if (multiFields) multiFields.hidden = !isMulti;
  if (classSelect) classSelect.required = !isMulti;
}

function renderPartTeacherCheckboxes(partIndex, selectedIds = []) {
  const root = document.getElementById(`horario-part-teachers-${partIndex}`);
  if (!root) return;

  const selected = new Set(selectedIds);

  if (!state.teachers.length) {
    root.innerHTML = '<p class="horario-teacher-empty">No hay maestras registradas.</p>';
    return;
  }

  root.innerHTML = state.teachers
    .map((teacher) => {
      const checked = selected.has(teacher.id) ? ' checked' : '';
      return `
        <label class="horario-teacher-toggle">
          <input type="checkbox" class="horario-part-teacher-checkbox" data-part="${partIndex}" data-teacher-id="${teacher.id}"${checked}>
          <span>${escapeHtml(teacher.full_name || 'Sin nombre')}</span>
        </label>
      `;
    })
    .join('');
}

function renderMultiPartSelects(parts = []) {
  for (const partIndex of MULTI_PART_INDEXES) {
    const select = document.getElementById(`horario-part-class-${partIndex}`);
    const existing = parts.find((p) => p.part_index === partIndex);
    if (select) {
      // Parts beyond the required minimum are optional and may be left empty.
      const emptyOption =
        partIndex > MIN_MULTI_PARTS
          ? `<option value=""${existing?.class_id ? '' : ' selected'}>— Sin materia (opcional) —</option>`
          : '';
      select.innerHTML = emptyOption + classOptionsHtml(existing?.class_id ?? '');
    }
    renderPartTeacherCheckboxes(partIndex, existing?.teacher_ids ?? []);
  }
}

function buildPanelShell() {
  return `
    <h2 class="panel-title">Editar horario</h2>

    <div id="horario-info" class="horario-info">
      <p class="horario-info-text">
        El horario es fijo para el semestre. Cada semana solo se reasignan los espacios
        (pestaña <strong>Reservaciones semanales</strong>).
      </p>
      <button type="button" class="horario-info-dismiss" id="horario-info-dismiss" aria-label="Cerrar">×</button>
    </div>

    <div id="horario-alert" class="alert alert-error" hidden></div>

    <section class="horario-section horario-step">
      <h3 class="horario-step-title"><span class="horario-step-num">1</span> Materias</h3>
      <p class="horario-step-lede">Define las materias que existen. Luego colócalas en el horario.</p>
      <form id="horario-create-class" class="horario-inline-form">
        <div class="form-group horario-inline-field">
          <label for="horario-new-class">Nueva materia</label>
          <input class="input" id="horario-new-class" type="text" placeholder="Ej. Física, Business IB" required>
        </div>
        <button type="submit" class="btn btn-primary">Crear</button>
      </form>
      <ul id="horario-classes-list" class="horario-classes-list"></ul>
    </section>

    <section class="horario-section horario-step">
      <h3 class="horario-step-title"><span class="horario-step-num">2</span> Horario por grado</h3>
      <p class="horario-step-lede">Elige un grado, coloca cada materia en sus días y hora, y asigna maestras. Usa <strong>Multi</strong> para franjas IB divididas (ej. Business + History): hasta 5 clases, cada una con su propio espacio.</p>

      <div id="horario-step2-gate" class="horario-step-gate" hidden>
        <p class="horario-gate-title">Aún no hay materias — así se arma el horario:</p>
        <ol class="horario-gate-steps">
          <li>Crea tus materias en el paso 1 (ej. Física, Business IB).</li>
          <li>Marca los días de la semana y la hora en el formulario de abajo.</li>
          <li>Agrega la clase: se colocará en todos los días marcados y aparecerá en la vista semanal.</li>
        </ol>
      </div>

      <div id="horario-step2-content" class="horario-step2-content">
        <div class="horario-grade-bar">
          <label class="horario-grade-label" for="horario-grade">Grado</label>
          <select class="input horario-grade-select" id="horario-grade">
            ${GRADES.map((g) => `<option value="${g}">${g}</option>`).join('')}
          </select>
        </div>

        <div class="horario-schedule-unit">
          <div class="horario-placement-block" id="horario-placement-block">
            <div class="horario-form-header">
              <div>
                <h4 class="horario-form-heading" id="horario-form-title">Colocar en el horario</h4>
                <p id="horario-form-grade" class="horario-form-grade">Grado: <strong>10mo</strong></p>
              </div>
              <button type="button" class="btn btn-ghost" id="horario-toggle-multi">Multi</button>
            </div>
            <form id="horario-slot-form" class="horario-slot-form">
              <div class="form-group horario-day-field">
                <span class="horario-teacher-label">Días</span>
                <div class="horario-day-checks" id="horario-slot-days">
                  ${WEEKDAYS.map((d) => `
                    <label class="horario-day-check">
                      <input type="checkbox" class="horario-day-checkbox" value="${d}" data-day="${d}">
                      <span>${WEEKDAY_LABELS[d]}</span>
                    </label>
                  `).join('')}
                </div>
                <p class="horario-day-hint" id="horario-day-hint" hidden>Estás editando una franja existente: pertenece a un solo día.</p>
              </div>
              <div class="horario-form-grid">
                <div class="form-group">
                  <label for="horario-slot-start">Inicio</label>
                  <input class="input" id="horario-slot-start" type="time" required>
                </div>
                <div class="form-group">
                  <label for="horario-slot-end">Fin</label>
                  <input class="input" id="horario-slot-end" type="time" required>
                </div>
              </div>
              <div class="horario-time-presets-row">
                <span class="horario-presets-label">Horarios comunes</span>
                <div id="horario-time-presets" class="horario-time-presets"></div>
              </div>

              <div id="horario-single-fields">
                <div class="horario-form-grid">
                  <div class="form-group">
                    <label for="horario-slot-class">Materia</label>
                    <select class="input" id="horario-slot-class" required></select>
                  </div>
                  <div class="form-group horario-teacher-field">
                    <span class="horario-teacher-label">Maestras a cargo</span>
                    <div id="horario-slot-teachers" class="horario-teacher-list"></div>
                  </div>
                </div>
              </div>

              <div id="horario-multi-fields" class="horario-multi-fields" hidden>
                <p class="horario-multi-hint">Divide la franja entre hasta 5 clases — cada una reserva su propio espacio. Las partes A y B son obligatorias; C, D y E son opcionales.</p>
                <div class="horario-multi-parts">
                  ${MULTI_PART_INDEXES.map((partIndex) => `
                  <fieldset class="horario-multi-part">
                    <legend>Parte ${partLetter(partIndex)}${partIndex > MIN_MULTI_PARTS ? ' (opcional)' : ''}</legend>
                    <div class="form-group">
                      <label for="horario-part-class-${partIndex}">Materia</label>
                      <select class="input" id="horario-part-class-${partIndex}"></select>
                    </div>
                    <div class="form-group">
                      <span class="horario-teacher-label">Maestras</span>
                      <div id="horario-part-teachers-${partIndex}" class="horario-teacher-list"></div>
                    </div>
                  </fieldset>
                  `).join('')}
                </div>
              </div>

              <div class="horario-form-actions">
                <button type="submit" class="btn btn-primary" id="horario-slot-submit">Agregar a 10mo</button>
                <button type="button" class="btn btn-ghost" id="horario-slot-cancel" hidden>Cancelar edición</button>
              </div>
            </form>
          </div>

          <div id="horario-grade-empty" class="horario-grade-empty" hidden></div>

          <div class="horario-grid-wrap">
            <h4 class="horario-grid-title">Vista semanal</h4>
            <div id="horario-grid" class="horario-grid"></div>
          </div>
        </div>
      </div>
    </section>

    <div id="horario-toast" class="horario-toast" role="status" aria-live="polite"></div>

    <div id="horario-confirm-overlay" class="horario-confirm-overlay" hidden>
      <div class="horario-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="horario-confirm-title">
        <h4 class="horario-confirm-title" id="horario-confirm-title"></h4>
        <p class="horario-confirm-text" id="horario-confirm-text"></p>
        <label class="horario-confirm-ack" id="horario-confirm-ack-row" hidden>
          <input type="checkbox" id="horario-confirm-ack">
          <span id="horario-confirm-ack-label"></span>
        </label>
        <div class="horario-confirm-actions">
          <button type="button" class="btn btn-ghost" id="horario-confirm-cancel">Cancelar</button>
          <button type="button" class="btn btn-danger" id="horario-confirm-accept">Eliminar</button>
        </div>
      </div>
    </div>
  `;
}

function renderSlotCard(slot) {
  const timeLine = `<span class="horario-slot-time">${formatTime(slot.start_time)} – ${formatTime(slot.end_time)}</span>`;

  if (slot.is_multi && slot.parts.length) {
    const partsHtml = slot.parts
      .map(
        (part) => `
        <div class="horario-multi-part-display">
          <strong>${escapeHtml(part.class_name || classNameById(part.class_id))}</strong>
          <span class="horario-slot-teacher">${escapeHtml(teacherNamesLabel(part.teacher_ids))}</span>
        </div>
      `
      )
      .join('');

    const allAssigned = slot.parts.every((p) => p.teacher_ids.length > 0);

    return `
      <article class="horario-slot-card horario-slot-card-multi${allAssigned ? '' : ' horario-slot-card-unassigned'}">
        <span class="badge horario-multi-badge">Multi</span>
        <div class="horario-slot-main">
          <div class="horario-multi-split">${partsHtml}</div>
          ${timeLine}
        </div>
        <div class="horario-slot-actions">
          <button type="button" class="btn btn-ghost horario-btn-sm" data-edit-slot="${slot.id}">Editar</button>
          <button type="button" class="btn btn-ghost horario-btn-sm" data-delete-slot="${slot.id}">Eliminar</button>
        </div>
      </article>
    `;
  }

  const hasTeachers = slot.teacher_ids.length > 0;
  const teacherBlock = hasTeachers
    ? `<span class="horario-slot-teacher">${escapeHtml(teacherNamesLabel(slot.teacher_ids))}</span>`
    : `
      <span class="horario-slot-teacher horario-slot-unassigned">Sin asignar</span>
      <button type="button" class="btn btn-ghost horario-btn-sm horario-assign-btn" data-assign-teacher="${slot.id}">Asignar maestras</button>
    `;

  return `
    <article class="horario-slot-card${hasTeachers ? '' : ' horario-slot-card-unassigned'}">
      <div class="horario-slot-main">
        <strong>${escapeHtml(classNameById(slot.class_id))}</strong>
        ${timeLine}
        ${teacherBlock}
      </div>
      <div class="horario-slot-actions">
        <button type="button" class="btn btn-ghost horario-btn-sm" data-edit-slot="${slot.id}">Editar</button>
        <button type="button" class="btn btn-ghost horario-btn-sm" data-delete-slot="${slot.id}">Eliminar</button>
      </div>
    </article>
  `;
}

function renderClassesList() {
  const list = document.getElementById('horario-classes-list');
  if (!list) return;

  if (!state.classes.length) {
    list.innerHTML = '<li class="horario-empty">No hay materias creadas.</li>';
    return;
  }

  list.innerHTML = state.classes.map((c) => {
    const count = slotCountForClass(c.id);
    return `
      <li class="horario-class-item">
        <div class="horario-class-main">
          <span class="horario-class-name">${escapeHtml(c.name)}</span>
          <span class="horario-class-meta">${slotCountLabel(count)}</span>
        </div>
        <button type="button" class="btn btn-ghost horario-btn-sm" data-delete-class="${c.id}">Eliminar</button>
      </li>
    `;
  }).join('');
}

function renderStep2Gate() {
  const gate = document.getElementById('horario-step2-gate');
  const content = document.getElementById('horario-step2-content');
  if (!gate || !content) return;

  const hasClasses = state.classes.length > 0;
  gate.hidden = hasClasses;
  content.hidden = !hasClasses;
}

function renderGradeEmptyHint() {
  const el = document.getElementById('horario-grade-empty');
  if (!el) return;

  if (state.classes.length && !state.slots.length) {
    el.textContent = `Aún no hay clases en el horario de ${state.grade}. Marca los días y la hora en el formulario, o haz clic en «+ Agregar clase» dentro de un día de la vista semanal.`;
    el.hidden = false;
  } else {
    el.hidden = true;
    el.textContent = '';
  }
}

function renderWeeklyGrid() {
  const grid = document.getElementById('horario-grid');
  if (!grid) return;

  grid.innerHTML = WEEKDAYS.map((day) => {
    const daySlots = state.slots
      .filter((s) => s.day === day)
      .sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time));

    const cards = daySlots.length
      ? daySlots.map((slot) => renderSlotCard(slot)).join('')
      : '<p class="horario-day-empty">Sin franjas</p>';

    return `
      <div class="horario-day-col horario-day-col-clickable" data-day-col="${day}">
        <h4 class="horario-day-hd">${WEEKDAY_LABELS[day]}</h4>
        <div class="horario-day-slots">${cards}</div>
        <button type="button" class="horario-day-add" data-add-day="${day}">+ Agregar clase</button>
      </div>
    `;
  }).join('');
}

function renderTeacherCheckboxes(selectedIds = []) {
  const root = document.getElementById('horario-slot-teachers');
  if (!root) return;

  const selected = new Set(selectedIds);

  if (!state.teachers.length) {
    root.innerHTML = '<p class="horario-teacher-empty">No hay maestras registradas.</p>';
    return;
  }

  root.innerHTML = state.teachers
    .map((teacher) => {
      const checked = selected.has(teacher.id) ? ' checked' : '';
      return `
        <label class="horario-teacher-toggle">
          <input type="checkbox" class="horario-teacher-checkbox" data-teacher-id="${teacher.id}"${checked}>
          <span>${escapeHtml(teacher.full_name || 'Sin nombre')}</span>
        </label>
      `;
    })
    .join('');
}

function populateFormSelects() {
  const classSelect = document.getElementById('horario-slot-class');
  if (!classSelect) return;

  const prevClass = classSelect.value;

  classSelect.innerHTML = state.classes.length
    ? classOptionsHtml()
    : '<option value="" disabled selected>No hay materias</option>';

  if (prevClass && state.classes.some((c) => c.id === prevClass)) {
    classSelect.value = prevClass;
  }

  if (!state.editingSlotId) {
    renderTeacherCheckboxes();
    renderMultiPartSelects();
  }
}

function updateFormChrome() {
  const gradeEl = document.getElementById('horario-form-grade');
  if (gradeEl) {
    gradeEl.innerHTML = `Grado: <strong>${escapeHtml(state.grade)}</strong>`;
  }

  const submit = document.getElementById('horario-slot-submit');
  if (!submit) return;

  if (state.editingSlotId) {
    submit.textContent = `Guardar cambios en ${state.grade}`;
  } else {
    submit.textContent = state.formMulti
      ? `Agregar multi a ${state.grade}`
      : `Agregar a ${state.grade}`;
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clearSlotForm() {
  state.editingSlotId = null;
  state.formMulti = false;
  const form = document.getElementById('horario-slot-form');
  form?.reset();
  setSelectedDays([]);
  updateDayEditLock();
  syncActiveTimePreset();
  document.getElementById('horario-form-title').textContent = 'Colocar en el horario';
  document.getElementById('horario-slot-cancel').hidden = true;
  setFormMulti(false);
  renderTeacherCheckboxes();
  renderMultiPartSelects();
  updateFormChrome();
}

/** Click-to-add: prefill the placement form for a new slot on a given day. */
function prefillDayForAdd(day) {
  if (state.editingSlotId) clearSlotForm();
  setSelectedDays([day]);
  updateDayEditLock();

  document.getElementById('horario-placement-block')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const focusTarget = state.formMulti
    ? document.getElementById('horario-part-class-1')
    : document.getElementById('horario-slot-class');
  window.setTimeout(() => {
    (focusTarget ?? document.getElementById('horario-slot-start'))?.focus();
  }, 200);
}

function prefillSlotForm(slot, { focusTeacher = false } = {}) {
  state.editingSlotId = slot.id;
  setSelectedDays([slot.day]);
  updateDayEditLock();
  document.getElementById('horario-slot-start').value = formatTime(slot.start_time);
  document.getElementById('horario-slot-end').value = formatTime(slot.end_time);
  syncActiveTimePreset();

  if (slot.is_multi) {
    setFormMulti(true);
    renderMultiPartSelects(slot.parts);
  } else {
    setFormMulti(false);
    document.getElementById('horario-slot-class').value = slot.class_id;
    renderTeacherCheckboxes(slot.teacher_ids);
  }

  document.getElementById('horario-form-title').textContent = 'Editar franja';
  document.getElementById('horario-slot-cancel').hidden = false;
  updateFormChrome();

  document.getElementById('horario-placement-block')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  if (focusTeacher) {
    window.setTimeout(() => {
      document.querySelector('.horario-teacher-checkbox, .horario-part-teacher-checkbox')?.focus();
    }, 200);
  }
}

// Teachers can appear/vanish while this tab sits mounted (e.g. an admin
// deletes a user in Usuarios). Refetch and re-render the pickers, preserving
// whatever the admin currently has checked.
async function refreshTeachers() {
  try {
    state.teachers = await fetchTeachers();
  } catch (_) {
    return; // keep the current list if the refetch fails
  }
  renderTeacherCheckboxes(getSelectedTeacherIds());
  for (const partIndex of MULTI_PART_INDEXES) {
    renderPartTeacherCheckboxes(partIndex, getPartTeacherIds(partIndex));
  }
  renderWeeklyGrid();
}

async function refreshAll() {
  state.classes = await fetchClasses();
  state.teachers = await fetchTeachers();
  state.slots = await fetchSlots(state.grade);
  state.slotCountByClass = await fetchSlotCountsByClass();
  renderClassesList();
  renderStep2Gate();
  renderGradeEmptyHint();
  renderWeeklyGrid();
  renderTimePresets();
  populateFormSelects();
  updateFormChrome();
}

function wireEvents(panel) {
  panel.querySelector('#horario-info-dismiss')?.addEventListener('click', () => {
    document.getElementById('horario-info')?.remove();
  });

  panel.querySelector('#horario-toggle-multi')?.addEventListener('click', () => {
    hideAlert();
    setFormMulti(!state.formMulti);
    updateFormChrome();
  });

  panel.querySelector('#horario-create-class').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();
    const input = document.getElementById('horario-new-class');
    const name = input.value.trim();
    if (!name) return;

    try {
      const { error } = await supabase.from('classes').insert({
        name,
        created_by: state.profile.id,
      });
      if (error) throw error;
      input.value = '';
      await refreshAll();
    } catch (err) {
      showAlert(err.message || 'No se pudo crear la materia.');
    }
  });

  panel.querySelector('#horario-grade').addEventListener('change', async (e) => {
    hideAlert();
    state.grade = e.target.value;
    clearSlotForm();
    try {
      state.slots = await fetchSlots(state.grade);
      renderGradeEmptyHint();
      renderWeeklyGrid();
      renderTimePresets();
      updateFormChrome();
    } catch (err) {
      showAlert(err.message || 'No se pudo cargar el horario.');
    }
  });

  panel.querySelector('#horario-slot-days')?.addEventListener('change', (e) => {
    const cb = e.target.closest('.horario-day-checkbox');
    if (!cb) return;
    if (state.editingSlotId) {
      // Editing stays single-day: behave like a radio group locked to one selection.
      if (cb.checked) {
        document.querySelectorAll('.horario-day-checkbox').forEach((other) => {
          if (other !== cb) other.checked = false;
        });
      } else {
        cb.checked = true;
      }
    }
  });

  panel.querySelector('#horario-time-presets')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.horario-time-preset');
    if (!btn) return;
    hideAlert();
    document.getElementById('horario-slot-start').value = btn.dataset.start;
    document.getElementById('horario-slot-end').value = btn.dataset.end;
    syncActiveTimePreset();
  });

  panel.querySelector('#horario-slot-form')?.addEventListener('input', (e) => {
    if (e.target.id === 'horario-slot-start' || e.target.id === 'horario-slot-end') {
      syncActiveTimePreset();
    }
  });

  panel.querySelector('#horario-slot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();

    const selectedDays = getSelectedDays();
    const startTime = document.getElementById('horario-slot-start').value;
    const endTime = document.getElementById('horario-slot-end').value;

    if (!selectedDays.length) {
      showAlert('Marca al menos un día (Lun–Vie).');
      return;
    }

    if (state.editingSlotId && selectedDays.length > 1) {
      showAlert('Al editar una franja existente solo puedes elegir un día.');
      return;
    }

    if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
      showAlert('La hora de fin debe ser posterior a la de inicio.');
      return;
    }

    const isMulti = state.formMulti;
    let classId;
    let teacherIds = [];
    let multiParts = [];

    if (isMulti) {
      if (!state.teachers.length) {
        showAlert('Las maestras aún no han cargado; espera un momento y vuelve a intentar. Guardar ahora borraría las asignaciones de maestras.');
        return;
      }
      const formParts = getMultiFormParts();
      if (!formParts[0].class_id || !formParts[1].class_id) {
        showAlert('Elige una materia para cada parte obligatoria (A y B).');
        return;
      }
      const filledParts = formParts.filter((p) => p.class_id);
      if (filledParts.length < MIN_MULTI_PARTS) {
        showAlert(`Una franja multi necesita al menos ${MIN_MULTI_PARTS} materias.`);
        return;
      }
      if (filledParts.length > MAX_MULTI_PARTS) {
        showAlert(`Una franja multi admite hasta ${MAX_MULTI_PARTS} clases.`);
        return;
      }
      const uniqueClassIds = new Set(filledParts.map((p) => p.class_id));
      if (uniqueClassIds.size !== filledParts.length) {
        showAlert('Cada parte debe ser una materia distinta.');
        return;
      }
      // Re-number filled parts contiguously (1..n) so gaps left by empty
      // optional fieldsets never reach the database.
      multiParts = filledParts.map((part, i) => ({ ...part, part_index: i + 1 }));
      classId = multiParts[0].class_id;
    } else {
      classId = document.getElementById('horario-slot-class').value;
      teacherIds = getSelectedTeacherIds();
      if (!classId) {
        showAlert('Crea al menos una materia antes de agregar al horario.');
        return;
      }
    }

    /** Per-slot payload — same shape as always, one per day. */
    const buildPayload = (day) => ({
      class_id: classId,
      grade: state.grade,
      day,
      start_time: startTime,
      end_time: endTime,
      is_multi: isMulti,
    });

    try {
      const wasEditing = Boolean(state.editingSlotId);

      if (wasEditing) {
        const slotId = state.editingSlotId;
        const payload = buildPayload(selectedDays[0]);
        const { error } = await supabase.from('timetable_slots').update(payload).eq('id', slotId);
        if (error) throw error;

        if (isMulti) {
          await syncSlotParts(slotId, multiParts);
          await syncSlotTeachers(slotId, []);
        } else {
          await syncSlotParts(slotId, null);
          await syncSlotTeachers(slotId, teacherIds);
        }
      } else {
        // Multi-day placement: one INSERT per selected day, each with the
        // exact same per-slot payload shape as a single add.
        for (const day of selectedDays) {
          const payload = buildPayload(day);
          const { data: newSlot, error } = await supabase
            .from('timetable_slots')
            .insert(payload)
            .select('id')
            .single();
          if (error) throw error;
          const slotId = newSlot.id;

          if (isMulti) {
            await syncSlotParts(slotId, multiParts);
            await syncSlotTeachers(slotId, []);
          } else {
            await syncSlotParts(slotId, null);
            await syncSlotTeachers(slotId, teacherIds);
          }
        }
      }

      const classLabel = isMulti
        ? multiParts.map((p) => classNameById(p.class_id)).join(' + ')
        : classNameById(classId);
      const daysLabel = selectedDays.map((d) => WEEKDAY_LABELS[d]).join(', ');
      const gradeLabel = state.grade;

      clearSlotForm();
      await refreshAll();

      showToast(
        wasEditing
          ? `Franja actualizada: <strong>${escapeHtml(classLabel)}</strong> · ${daysLabel} · ${startTime}–${endTime} · ${escapeHtml(gradeLabel)}`
          : `<strong>${escapeHtml(classLabel)}</strong> agregada · ${daysLabel} · ${startTime}–${endTime} · ${escapeHtml(gradeLabel)}`
      );
    } catch (err) {
      showAlert(err.message || 'No se pudo guardar la franja.');
      // A failed sync may have partially applied (delete-recreate is not
      // transactional) — reload so the grid shows what actually persisted.
      try {
        await refreshAll();
      } catch (_) { /* keep the original error visible */ }
    }
  });

  panel.querySelector('#horario-slot-cancel').addEventListener('click', () => {
    hideAlert();
    clearSlotForm();
  });

  panel.querySelector('#horario-classes-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-delete-class]');
    if (!btn) return;
    hideAlert();

    const classId = btn.dataset.deleteClass;
    const className = classNameById(classId);
    const slotCount = slotCountForClass(classId);

    let confirmed;
    if (slotCount > 0) {
      const franjas = slotCount === 1 ? '1 franja' : `${slotCount} franjas`;
      confirmed = await openConfirmDialog({
        title: `Eliminar «${className}»`,
        text: `Esta materia tiene <strong>${franjas}</strong> en el horario. Al eliminarla, también se eliminarán esas franjas y dejarán de verse para alumnas y maestras.`,
        ackLabel: `Entiendo que se eliminarán ${franjas} del horario.`,
        acceptLabel: `Eliminar materia y ${franjas}`,
      });
    } else {
      confirmed = await openConfirmDialog({
        title: `Eliminar «${className}»`,
        text: 'Esta materia no tiene franjas en el horario. ¿Quieres eliminarla?',
        acceptLabel: 'Eliminar materia',
      });
    }
    if (!confirmed) return;

    try {
      const { error } = await supabase.from('classes').delete().eq('id', classId);
      if (error) throw error;
      if (state.editingSlotId) {
        const editing = state.slots.find((s) => s.id === state.editingSlotId);
        if (editing?.class_id === classId || editing?.parts?.some((p) => p.class_id === classId)) {
          clearSlotForm();
        }
      }
      await refreshAll();
    } catch (err) {
      showAlert(err.message || 'No se pudo eliminar la materia.');
    }
  });

  panel.querySelector('#horario-grid').addEventListener('click', async (e) => {
    const assignBtn = e.target.closest('[data-assign-teacher]');
    const editBtn = e.target.closest('[data-edit-slot]');
    const deleteBtn = e.target.closest('[data-delete-slot]');
    const addDayBtn = e.target.closest('[data-add-day]');

    if (addDayBtn) {
      hideAlert();
      prefillDayForAdd(addDayBtn.dataset.addDay);
      return;
    }

    if (assignBtn) {
      hideAlert();
      const slot = state.slots.find((s) => s.id === assignBtn.dataset.assignTeacher);
      if (slot) prefillSlotForm(slot, { focusTeacher: true });
      return;
    }

    if (editBtn) {
      hideAlert();
      const slot = state.slots.find((s) => s.id === editBtn.dataset.editSlot);
      if (slot) prefillSlotForm(slot);
      return;
    }

    if (deleteBtn) {
      hideAlert();
      const slotId = deleteBtn.dataset.deleteSlot;
      if (!confirm('¿Eliminar esta franja del horario?')) return;

      try {
        const { error } = await supabase.from('timetable_slots').delete().eq('id', slotId);
        if (error) throw error;
        if (state.editingSlotId === slotId) clearSlotForm();
        await refreshAll();
      } catch (err) {
        showAlert(err.message || 'No se pudo eliminar la franja.');
      }
      return;
    }

    // Click-to-add: clicking an empty area of a day column prefills the form
    // with that day and focuses it.
    const dayCol = e.target.closest('[data-day-col]');
    if (dayCol && !e.target.closest('.horario-slot-card')) {
      hideAlert();
      prefillDayForAdd(dayCol.dataset.dayCol);
    }
  });
}

export async function mountEditarHorario(profile) {
  if (profile.role !== 'admin') return;

  const panel = document.getElementById('panel-editar-horario');
  if (!panel) return;

  state.profile = profile;
  state.grade = '10mo';
  state.editingSlotId = null;
  state.formMulti = false;
  state.slotCountByClass = {};

  panel.innerHTML = buildPanelShell();
  document.getElementById('horario-grade').value = state.grade;

  wireEvents(panel);

  // Keep the teacher pickers fresh: refetch whenever this tab is activated and
  // whenever another admin module announces a profiles change (user deleted or
  // role changed). Mount runs once per page load, so no duplicate listeners.
  document
    .querySelector('#reserva-tabs [data-tab="editar-horario"]')
    ?.addEventListener('click', () => { refreshTeachers(); });
  document.addEventListener('rw:profiles-changed', () => { refreshTeachers(); });

  try {
    await refreshAll();
  } catch (err) {
    showAlert(err.message || 'No se pudo cargar el editor de horario.');
  }
}
