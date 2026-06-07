import { supabase } from './supabase.js';

/** @type {{ profile: object, teacherCode: string | null, classes: object[], declaredClassIds: Set<string> }} */
const state = {
  profile: null,
  teacherCode: null,
  classes: [],
  declaredClassIds: new Set(),
};

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showAlert(message) {
  const el = document.getElementById('teacher-profile-alert');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function hideAlert() {
  const el = document.getElementById('teacher-profile-alert');
  if (el) el.hidden = true;
}

async function fetchTeacherProfile() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role, teacher_code')
    .eq('id', state.profile.id)
    .single();
  if (error) throw error;
  return data;
}

async function fetchClasses() {
  const { data, error } = await supabase.from('classes').select('id, name').order('name');
  if (error) throw error;
  return data ?? [];
}

async function fetchDeclaredClasses() {
  const { data, error } = await supabase
    .from('teacher_classes')
    .select('class_id')
    .eq('teacher_id', state.profile.id);
  if (error) throw error;
  return (data ?? []).map((row) => row.class_id);
}

function buildPanelShell() {
  return `
    <h2 class="panel-title">Mi perfil</h2>
    <p class="teacher-profile-lede">
      Aquí declaras qué clases impartes. El horario que asigna la administradora es el que usarás al reservar espacios.
    </p>
    <div id="teacher-profile-alert" class="alert alert-error" hidden></div>

    <section class="teacher-profile-section">
      <h3 class="teacher-profile-section-title">Mi código</h3>
      <div id="teacher-code-display"></div>
    </section>

    <section class="teacher-profile-section">
      <h3 class="teacher-profile-section-title">Mis clases</h3>
      <div id="teacher-classes-list" class="teacher-classes-list"></div>
    </section>
  `;
}

function renderCodeDisplay() {
  const root = document.getElementById('teacher-code-display');
  if (!root) return;

  if (state.teacherCode) {
    root.innerHTML = `
      <div class="teacher-code-box">
        <span class="teacher-code-value" id="teacher-code-value">${escapeHtml(state.teacherCode)}</span>
        <button type="button" class="btn btn-ghost teacher-code-copy" id="teacher-code-copy">Copiar</button>
      </div>
      <p class="teacher-code-hint">Código personal para confirmar reservaciones. No se puede editar desde aquí.</p>
    `;
    document.getElementById('teacher-code-copy')?.addEventListener('click', copyCode);
    return;
  }

  root.innerHTML = `
    <p class="teacher-code-missing">Tu código se asigna automáticamente cuando una administradora te promueve a maestra.</p>
  `;
}

async function copyCode() {
  if (!state.teacherCode) return;
  hideAlert();
  try {
    await navigator.clipboard.writeText(state.teacherCode);
  } catch {
    showAlert('No se pudo copiar el código.');
  }
}

function renderClassList() {
  const root = document.getElementById('teacher-classes-list');
  if (!root) return;

  if (!state.classes.length) {
    root.innerHTML = '<p class="teacher-classes-empty">Aún no hay clases creadas en el sistema.</p>';
    return;
  }

  root.innerHTML = state.classes.map((cls) => {
    const checked = state.declaredClassIds.has(cls.id) ? ' checked' : '';
    return `
      <label class="teacher-class-toggle">
        <input type="checkbox" class="teacher-class-checkbox" data-class-id="${cls.id}"${checked}>
        <span>${escapeHtml(cls.name)}</span>
      </label>
    `;
  }).join('');
}

function syncCheckboxesToState() {
  document.querySelectorAll('.teacher-class-checkbox').forEach((input) => {
    input.checked = state.declaredClassIds.has(input.dataset.classId);
  });
}

async function refreshDeclaredClasses() {
  const ids = await fetchDeclaredClasses();
  state.declaredClassIds = new Set(ids);
  syncCheckboxesToState();
}

async function handleClassToggle(checkbox) {
  const classId = checkbox.dataset.classId;
  const shouldDeclare = checkbox.checked;
  const previousChecked = !shouldDeclare;

  hideAlert();
  checkbox.disabled = true;

  try {
    if (shouldDeclare) {
      const { error } = await supabase.from('teacher_classes').insert({
        teacher_id: state.profile.id,
        class_id: classId,
      });
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('teacher_classes')
        .delete()
        .eq('teacher_id', state.profile.id)
        .eq('class_id', classId);
      if (error) throw error;
    }
    await refreshDeclaredClasses();
  } catch (err) {
    checkbox.checked = previousChecked;
    showAlert(err.message || 'No se pudo actualizar tus clases.');
  } finally {
    checkbox.disabled = false;
  }
}

function wireEvents(panel) {
  panel.addEventListener('change', (e) => {
    const checkbox = e.target.closest('.teacher-class-checkbox');
    if (!checkbox) return;
    handleClassToggle(checkbox);
  });
}

async function refreshAll() {
  const profileRow = await fetchTeacherProfile();
  state.teacherCode = profileRow.teacher_code ?? null;
  state.classes = await fetchClasses();
  state.declaredClassIds = new Set(await fetchDeclaredClasses());
  renderCodeDisplay();
  renderClassList();
}

export async function mountTeacherProfile(profile) {
  if (profile.role !== 'teacher') return;

  const panel = document.getElementById('panel-mi-perfil');
  if (!panel) return;

  state.profile = profile;
  state.teacherCode = null;
  state.classes = [];
  state.declaredClassIds = new Set();

  panel.innerHTML = buildPanelShell();
  wireEvents(panel);

  try {
    await refreshAll();
  } catch (err) {
    showAlert(err.message || 'No se pudo cargar tu perfil.');
  }
}
