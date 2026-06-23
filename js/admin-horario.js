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
  return [1, 2].map((partIndex) => ({
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
  for (const partIndex of [1, 2]) {
    const select = document.getElementById(`horario-part-class-${partIndex}`);
    const existing = parts.find((p) => p.part_index === partIndex);
    if (select) {
      select.innerHTML = classOptionsHtml(existing?.class_id ?? '');
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
      <h3 class="horario-step-title">1 · Materias</h3>
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
      <h3 class="horario-step-title">2 · Horario por grado</h3>
      <p class="horario-step-lede">Elige un grado, coloca cada materia en su día y hora, y asigna maestras. Usa <strong>Multi</strong> para franjas IB divididas (ej. Business + History, dos espacios).</p>

      <div id="horario-step2-gate" class="horario-step-gate" hidden>
        <p>Primero crea materias arriba.</p>
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
              <div class="horario-form-grid">
                <div class="form-group">
                  <label for="horario-slot-day">Día</label>
                  <select class="input" id="horario-slot-day" required>
                    ${WEEKDAYS.map((d) => `<option value="${d}">${WEEKDAY_LABELS[d]}</option>`).join('')}
                  </select>
                </div>
                <div class="form-group">
                  <label for="horario-slot-start">Inicio</label>
                  <input class="input" id="horario-slot-start" type="time" required>
                </div>
                <div class="form-group">
                  <label for="horario-slot-end">Fin</label>
                  <input class="input" id="horario-slot-end" type="time" required>
                </div>
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
                <p class="horario-multi-hint">Mitad de la generación a cada materia — cada una reserva su propio espacio.</p>
                <div class="horario-multi-parts">
                  <fieldset class="horario-multi-part">
                    <legend>Parte A</legend>
                    <div class="form-group">
                      <label for="horario-part-class-1">Materia</label>
                      <select class="input" id="horario-part-class-1"></select>
                    </div>
                    <div class="form-group">
                      <span class="horario-teacher-label">Maestras</span>
                      <div id="horario-part-teachers-1" class="horario-teacher-list"></div>
                    </div>
                  </fieldset>
                  <fieldset class="horario-multi-part">
                    <legend>Parte B</legend>
                    <div class="form-group">
                      <label for="horario-part-class-2">Materia</label>
                      <select class="input" id="horario-part-class-2"></select>
                    </div>
                    <div class="form-group">
                      <span class="horario-teacher-label">Maestras</span>
                      <div id="horario-part-teachers-2" class="horario-teacher-list"></div>
                    </div>
                  </fieldset>
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
    el.textContent = `Aún no hay clases en el horario de ${state.grade}. Usa el formulario para colocar una.`;
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
      <div class="horario-day-col">
        <h4 class="horario-day-hd">${WEEKDAY_LABELS[day]}</h4>
        <div class="horario-day-slots">${cards}</div>
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
  document.getElementById('horario-form-title').textContent = 'Colocar en el horario';
  document.getElementById('horario-slot-cancel').hidden = true;
  setFormMulti(false);
  renderTeacherCheckboxes();
  renderMultiPartSelects();
  updateFormChrome();
}

function prefillSlotForm(slot, { focusTeacher = false } = {}) {
  state.editingSlotId = slot.id;
  document.getElementById('horario-slot-day').value = slot.day;
  document.getElementById('horario-slot-start').value = formatTime(slot.start_time);
  document.getElementById('horario-slot-end').value = formatTime(slot.end_time);

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

async function refreshAll() {
  state.classes = await fetchClasses();
  state.teachers = await fetchTeachers();
  state.slots = await fetchSlots(state.grade);
  state.slotCountByClass = await fetchSlotCountsByClass();
  renderClassesList();
  renderStep2Gate();
  renderGradeEmptyHint();
  renderWeeklyGrid();
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
      updateFormChrome();
    } catch (err) {
      showAlert(err.message || 'No se pudo cargar el horario.');
    }
  });

  panel.querySelector('#horario-slot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();

    const day = document.getElementById('horario-slot-day').value;
    const startTime = document.getElementById('horario-slot-start').value;
    const endTime = document.getElementById('horario-slot-end').value;

    if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
      showAlert('La hora de fin debe ser posterior a la de inicio.');
      return;
    }

    const isMulti = state.formMulti;
    let classId;
    let teacherIds = [];
    let multiParts = [];

    if (isMulti) {
      multiParts = getMultiFormParts();
      if (!multiParts[0].class_id || !multiParts[1].class_id) {
        showAlert('Elige una materia para cada parte (A y B).');
        return;
      }
      if (multiParts[0].class_id === multiParts[1].class_id) {
        showAlert('Las dos partes deben ser materias distintas.');
        return;
      }
      classId = multiParts[0].class_id;
    } else {
      classId = document.getElementById('horario-slot-class').value;
      teacherIds = getSelectedTeacherIds();
      if (!classId) {
        showAlert('Crea al menos una materia antes de agregar al horario.');
        return;
      }
    }

    const payload = {
      class_id: classId,
      grade: state.grade,
      day,
      start_time: startTime,
      end_time: endTime,
      is_multi: isMulti,
    };

    try {
      let slotId = state.editingSlotId;

      if (slotId) {
        const { error } = await supabase.from('timetable_slots').update(payload).eq('id', slotId);
        if (error) throw error;
      } else {
        const { data: newSlot, error } = await supabase
          .from('timetable_slots')
          .insert(payload)
          .select('id')
          .single();
        if (error) throw error;
        slotId = newSlot.id;
      }

      if (isMulti) {
        await syncSlotParts(slotId, multiParts);
        await syncSlotTeachers(slotId, []);
      } else {
        await syncSlotParts(slotId, null);
        await syncSlotTeachers(slotId, teacherIds);
      }

      clearSlotForm();
      await refreshAll();
    } catch (err) {
      showAlert(err.message || 'No se pudo guardar la franja.');
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
    if (!confirm(`¿Eliminar la materia «${className}»? También se eliminarán sus franjas del horario.`)) {
      return;
    }

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

  try {
    await refreshAll();
  } catch (err) {
    showAlert(err.message || 'No se pudo cargar el editor de horario.');
  }
}
