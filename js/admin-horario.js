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

/** @type {{ profile: object, grade: string, classes: object[], teachers: object[], slots: object[], editingSlotId: string | null }} */
const state = {
  profile: null,
  grade: '10mo',
  classes: [],
  teachers: [],
  slots: [],
  editingSlotId: null,
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
    .select('id, class_id, teacher_id, grade, day, start_time, end_time')
    .eq('grade', grade);
  if (error) throw error;
  return data ?? [];
}

function buildPanelShell() {
  return `
    <h2 class="panel-title">Editar horario</h2>
    <div id="horario-alert" class="alert alert-error" hidden></div>

    <section class="horario-section">
      <h3 class="horario-section-title">Clases</h3>
      <form id="horario-create-class" class="horario-inline-form">
        <div class="form-group horario-inline-field">
          <label for="horario-new-class">Nueva clase</label>
          <input class="input" id="horario-new-class" type="text" placeholder="Ej. Física, Matemáticas" required>
        </div>
        <button type="submit" class="btn btn-primary">Crear</button>
      </form>
      <ul id="horario-classes-list" class="horario-classes-list"></ul>
    </section>

    <section class="horario-section">
      <h3 class="horario-section-title">Grado</h3>
      <select class="input horario-grade-select" id="horario-grade">
        ${GRADES.map((g) => `<option value="${g}">${g}</option>`).join('')}
      </select>
    </section>

    <section class="horario-section">
      <h3 class="horario-section-title">Horario semanal</h3>
      <div id="horario-grid" class="horario-grid"></div>
    </section>

    <section class="horario-section">
      <h3 class="horario-section-title" id="horario-form-title">Agregar clase al horario</h3>
      <form id="horario-slot-form" class="horario-slot-form">
        <div class="horario-form-grid">
          <div class="form-group">
            <label for="horario-slot-class">Clase</label>
            <select class="input" id="horario-slot-class" required></select>
          </div>
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
          <div class="form-group">
            <label for="horario-slot-teacher">Maestra (opcional)</label>
            <select class="input" id="horario-slot-teacher">
              <option value="">Sin asignar</option>
            </select>
          </div>
        </div>
        <div class="horario-form-actions">
          <button type="submit" class="btn btn-primary" id="horario-slot-submit">Agregar</button>
          <button type="button" class="btn btn-ghost" id="horario-slot-cancel" hidden>Cancelar edición</button>
        </div>
      </form>
    </section>
  `;
}

function renderClassesList() {
  const list = document.getElementById('horario-classes-list');
  if (!list) return;

  if (!state.classes.length) {
    list.innerHTML = '<li class="horario-empty">No hay clases creadas.</li>';
    return;
  }

  list.innerHTML = state.classes.map((c) => `
    <li class="horario-class-item">
      <span>${escapeHtml(c.name)}</span>
      <button type="button" class="btn btn-ghost horario-btn-sm" data-delete-class="${c.id}">Eliminar</button>
    </li>
  `).join('');
}

function renderWeeklyGrid() {
  const grid = document.getElementById('horario-grid');
  if (!grid) return;

  grid.innerHTML = WEEKDAYS.map((day) => {
    const daySlots = state.slots
      .filter((s) => s.day === day)
      .sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time));

    const cards = daySlots.length
      ? daySlots.map((slot) => `
          <article class="horario-slot-card">
            <div class="horario-slot-main">
              <strong>${escapeHtml(classNameById(slot.class_id))}</strong>
              <span class="horario-slot-time">${formatTime(slot.start_time)} – ${formatTime(slot.end_time)}</span>
              <span class="horario-slot-teacher">${escapeHtml(teacherNameById(slot.teacher_id))}</span>
            </div>
            <div class="horario-slot-actions">
              <button type="button" class="btn btn-ghost horario-btn-sm" data-edit-slot="${slot.id}">Editar</button>
              <button type="button" class="btn btn-ghost horario-btn-sm" data-delete-slot="${slot.id}">Eliminar</button>
            </div>
          </article>
        `).join('')
      : '<p class="horario-day-empty">Sin franjas</p>';

    return `
      <div class="horario-day-col">
        <h4 class="horario-day-hd">${WEEKDAY_LABELS[day]}</h4>
        <div class="horario-day-slots">${cards}</div>
      </div>
    `;
  }).join('');
}

function populateFormSelects() {
  const classSelect = document.getElementById('horario-slot-class');
  const teacherSelect = document.getElementById('horario-slot-teacher');
  if (!classSelect || !teacherSelect) return;

  const prevClass = classSelect.value;
  const prevTeacher = teacherSelect.value;

  classSelect.innerHTML = state.classes.length
    ? state.classes.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')
    : '<option value="" disabled selected>No hay clases</option>';

  teacherSelect.innerHTML = [
    '<option value="">Sin asignar</option>',
    ...state.teachers.map((t) => `<option value="${t.id}">${escapeHtml(t.full_name || 'Sin nombre')}</option>`),
  ].join('');

  if (prevClass && state.classes.some((c) => c.id === prevClass)) {
    classSelect.value = prevClass;
  }
  if (prevTeacher && state.teachers.some((t) => t.id === prevTeacher)) {
    teacherSelect.value = prevTeacher;
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
  const form = document.getElementById('horario-slot-form');
  form?.reset();
  document.getElementById('horario-form-title').textContent = 'Agregar clase al horario';
  document.getElementById('horario-slot-submit').textContent = 'Agregar';
  document.getElementById('horario-slot-cancel').hidden = true;
}

function prefillSlotForm(slot) {
  state.editingSlotId = slot.id;
  document.getElementById('horario-slot-class').value = slot.class_id;
  document.getElementById('horario-slot-day').value = slot.day;
  document.getElementById('horario-slot-start').value = formatTime(slot.start_time);
  document.getElementById('horario-slot-end').value = formatTime(slot.end_time);
  document.getElementById('horario-slot-teacher').value = slot.teacher_id ?? '';
  document.getElementById('horario-form-title').textContent = 'Editar franja del horario';
  document.getElementById('horario-slot-submit').textContent = 'Guardar cambios';
  document.getElementById('horario-slot-cancel').hidden = false;
  document.getElementById('horario-slot-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function refreshAll() {
  state.classes = await fetchClasses();
  state.teachers = await fetchTeachers();
  state.slots = await fetchSlots(state.grade);
  renderClassesList();
  renderWeeklyGrid();
  populateFormSelects();
}

function wireEvents(panel) {
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
      showAlert(err.message || 'No se pudo crear la clase.');
    }
  });

  panel.querySelector('#horario-grade').addEventListener('change', async (e) => {
    hideAlert();
    state.grade = e.target.value;
    clearSlotForm();
    try {
      state.slots = await fetchSlots(state.grade);
      renderWeeklyGrid();
    } catch (err) {
      showAlert(err.message || 'No se pudo cargar el horario.');
    }
  });

  panel.querySelector('#horario-slot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();

    const classId = document.getElementById('horario-slot-class').value;
    const day = document.getElementById('horario-slot-day').value;
    const startTime = document.getElementById('horario-slot-start').value;
    const endTime = document.getElementById('horario-slot-end').value;
    const teacherVal = document.getElementById('horario-slot-teacher').value;

    if (!classId) {
      showAlert('Crea al menos una clase antes de agregar al horario.');
      return;
    }
    if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
      showAlert('La hora de fin debe ser posterior a la de inicio.');
      return;
    }

    const payload = {
      class_id: classId,
      teacher_id: teacherVal || null,
      grade: state.grade,
      day,
      start_time: startTime,
      end_time: endTime,
    };

    try {
      if (state.editingSlotId) {
        const { error } = await supabase
          .from('timetable_slots')
          .update(payload)
          .eq('id', state.editingSlotId);
        if (error) throw error;
        clearSlotForm();
      } else {
        const { error } = await supabase.from('timetable_slots').insert(payload);
        if (error) throw error;
        document.getElementById('horario-slot-form').reset();
      }
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
    if (!confirm(`¿Eliminar la clase «${className}»? También se eliminarán sus franjas del horario.`)) {
      return;
    }

    try {
      const { error } = await supabase.from('classes').delete().eq('id', classId);
      if (error) throw error;
      if (state.editingSlotId) {
        const editing = state.slots.find((s) => s.id === state.editingSlotId);
        if (editing?.class_id === classId) clearSlotForm();
      }
      await refreshAll();
    } catch (err) {
      showAlert(err.message || 'No se pudo eliminar la clase.');
    }
  });

  panel.querySelector('#horario-grid').addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-edit-slot]');
    const deleteBtn = e.target.closest('[data-delete-slot]');

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

  panel.innerHTML = buildPanelShell();
  document.getElementById('horario-grade').value = state.grade;

  wireEvents(panel);

  try {
    await refreshAll();
  } catch (err) {
    showAlert(err.message || 'No se pudo cargar el editor de horario.');
  }
}
