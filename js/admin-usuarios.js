import { supabase } from './supabase.js';

const ROLES = ['student', 'teacher', 'admin'];

const ROLE_LABELS = {
  student: 'Alumna',
  teacher: 'Maestra',
  admin: 'Administradora',
};

/** @type {{ profile: object, users: object[] }} */
const state = {
  profile: null,
  users: [],
};

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function idSuffix(id) {
  return String(id).slice(-8);
}

function showAlert(message) {
  const el = document.getElementById('usuarios-alert');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function hideAlert() {
  const el = document.getElementById('usuarios-alert');
  if (el) el.hidden = true;
}

async function fetchUsers() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role, teacher_code')
    .order('full_name');
  if (error) throw error;
  return data ?? [];
}

function buildPanelShell() {
  return `
    <h2 class="panel-title">Usuarios</h2>
    <p class="usuarios-lede">Gestiona roles de usuario. El correo no está disponible desde la app (solo en auth).</p>
    <div id="usuarios-alert" class="alert alert-error" hidden></div>
    <div id="usuarios-list" class="usuarios-list"></div>
  `;
}

function renderRoleOptions(user) {
  const isSelf = user.id === state.profile.id;
  return ROLES.map((role) => {
    const selected = user.role === role ? ' selected' : '';
    // Self-demotion guard: disable leaving admin on your own row so you cannot
    // accidentally lock yourself out without a second admin.
    const disabled = isSelf && role !== 'admin' ? ' disabled' : '';
    return `<option value="${role}"${selected}${disabled}>${ROLE_LABELS[role]}</option>`;
  }).join('');
}

function renderUserList() {
  const root = document.getElementById('usuarios-list');
  if (!root) return;

  if (!state.users.length) {
    root.innerHTML = '<p class="usuarios-empty">No hay usuarios.</p>';
    return;
  }

  root.innerHTML = state.users.map((user) => {
    const name = user.full_name?.trim() || 'Sin nombre';
    const code = user.teacher_code || '—';
    const isSelf = user.id === state.profile.id;

    return `
      <article class="usuarios-row" data-user-id="${user.id}">
        <div class="usuarios-row-main">
          <div class="usuarios-name-block">
            <strong class="usuarios-name">${escapeHtml(name)}</strong>
            <span class="usuarios-id">…${escapeHtml(idSuffix(user.id))}</span>
            ${isSelf ? '<span class="usuarios-you">(tú)</span>' : ''}
          </div>
          <span class="usuarios-badge usuarios-badge-${user.role}">${ROLE_LABELS[user.role] || user.role}</span>
          <span class="usuarios-code" title="Código de maestra">${escapeHtml(code)}</span>
        </div>
        <div class="usuarios-row-control">
          <label class="usuarios-role-label" for="usuarios-role-${user.id}">Rol</label>
          <select class="input usuarios-role-select" id="usuarios-role-${user.id}" data-user-id="${user.id}" data-current-role="${user.role}"${isSelf ? ' title="No puedes quitarte el rol de administradora desde aquí"' : ''}>
            ${renderRoleOptions(user)}
          </select>
        </div>
      </article>
    `;
  }).join('');
}

async function refreshAll() {
  state.users = await fetchUsers();
  renderUserList();
}

async function handleRoleChange(select) {
  const userId = select.dataset.userId;
  const oldRole = select.dataset.currentRole;
  const newRole = select.value;

  if (newRole === oldRole) return;

  hideAlert();

  const user = state.users.find((u) => u.id === userId);
  const displayName = user?.full_name?.trim() || 'Sin nombre';

  if (!confirm(`¿Cambiar el rol de «${displayName}» a ${ROLE_LABELS[newRole] || newRole}?`)) {
    select.value = oldRole;
    return;
  }

  // Belt-and-suspenders if options were tampered with in devtools.
  if (userId === state.profile.id && newRole !== 'admin') {
    if (!confirm('Perderás acceso de administradora. ¿Continuar de todos modos?')) {
      select.value = oldRole;
      return;
    }
  }

  select.disabled = true;

  try {
    const { error } = await supabase.rpc('set_user_role', {
      target_id: userId,
      new_role: newRole,
    });
    if (error) throw error;
    await refreshAll();
  } catch (err) {
    select.value = oldRole;
    select.disabled = false;
    showAlert(err.message || 'No se pudo cambiar el rol.');
    return;
  }

  select.disabled = false;
}

function wireEvents(panel) {
  panel.addEventListener('change', (e) => {
    const select = e.target.closest('.usuarios-role-select');
    if (!select) return;
    handleRoleChange(select);
  });
}

export async function mountUsuarios(profile) {
  if (profile.role !== 'admin') return;

  const panel = document.getElementById('panel-usuarios');
  if (!panel) return;

  state.profile = profile;
  state.users = [];

  panel.innerHTML = buildPanelShell();
  wireEvents(panel);

  try {
    await refreshAll();
  } catch (err) {
    showAlert(err.message || 'No se pudo cargar la lista de usuarios.');
  }
}
