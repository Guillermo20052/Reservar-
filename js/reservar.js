import { requireAuth, getProfile, signOut } from './auth.js';

const TABS_BY_ROLE = {
  student: ['Horario', 'Espacios de estudio'],
  teacher: ['Horario', 'Reservar mi espacio', 'Espacios de estudio', 'Mi perfil'],
  admin: ['Horario', 'Editar horario', 'Reservaciones semanales', 'Usuarios', 'Espacios de estudio'],
};

const ROLE_LABELS = {
  student: 'Alumna',
  teacher: 'Maestra',
  admin: 'Administradora',
};

function slugify(label) {
  return label.toLowerCase().replace(/\s+/g, '-');
}

function renderHeader(profile) {
  document.getElementById('user-name').textContent = profile.full_name || 'Usuario';
  document.getElementById('user-role').textContent = ROLE_LABELS[profile.role] || profile.role;
}

function renderTabs(role) {
  const tabs = TABS_BY_ROLE[role] || TABS_BY_ROLE.student;
  const tabBar = document.getElementById('reserva-tabs');
  const panelsRoot = document.getElementById('reserva-panels');

  tabBar.innerHTML = tabs.map((label, i) =>
    `<button type="button" class="tab${i === 0 ? ' active' : ''}" role="tab" aria-selected="${i === 0}" data-tab="${slugify(label)}">${label}</button>`
  ).join('');

  panelsRoot.innerHTML = tabs.map((label, i) =>
    `<section class="panel card${i === 0 ? ' active' : ''}" id="panel-${slugify(label)}" role="tabpanel">
      <h2 class="panel-title">${label}</h2>
      <p class="panel-placeholder">Próximamente.</p>
    </section>`
  ).join('');

  tabBar.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tabId) {
  document.querySelectorAll('#reserva-tabs .tab').forEach((btn) => {
    const active = btn.dataset.tab === tabId;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('#reserva-panels .panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `panel-${tabId}`);
  });
}

function wireLogout() {
  document.getElementById('logout-btn').addEventListener('click', () => signOut());
}

async function init() {
  const user = await requireAuth();
  if (!user) return;

  const profile = await getProfile();
  if (!profile) {
    window.location.href = 'index.html';
    return;
  }

  renderHeader(profile);
  renderTabs(profile.role);
  wireLogout();

  const { mountHorario } = await import('./horario-view.js');
  await mountHorario(profile);

  if (profile.role === 'student' || profile.role === 'teacher') {
    const { mountStudyBooking } = await import('./study-booking.js');
    await mountStudyBooking(profile);
  }

  if (profile.role === 'admin') {
    const { mountEditarHorario } = await import('./admin-horario.js');
    await mountEditarHorario(profile);
    const { mountUsuarios } = await import('./admin-usuarios.js');
    await mountUsuarios(profile);
    const { mountReservacionesSemanales } = await import('./admin-reservaciones.js');
    await mountReservacionesSemanales(profile);
    const { mountAdminStudySpaces } = await import('./admin-study-spaces.js');
    await mountAdminStudySpaces(profile);
  }

  if (profile.role === 'teacher') {
    const { mountTeacherProfile } = await import('./teacher-profile.js');
    await mountTeacherProfile(profile);
    const { mountReservarEspacio } = await import('./teacher-reservar.js');
    await mountReservarEspacio(profile);
  }
}

init();
