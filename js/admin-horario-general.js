import { GRADES, mountHorarioGrid } from './horario-view.js';

/**
 * "Horario general" — the 10mo, 11vo and 12vo grids on one screen.
 *
 * This adds no queries and no rendering logic of its own: it mounts
 * horario-view.js's grid three times, once per grade, with the grade selector
 * hidden. Each instance runs the same slot query, the same week-scoped
 * reservations query and the same markup as the Horario tab, so the styling and
 * the Realtime behaviour are identical.
 */
export async function mountHorarioGeneral(profile) {
  if (profile.role !== 'admin') return;

  const panel = document.getElementById('panel-horario-general');
  if (!panel) return;

  panel.innerHTML = `
    <h2 class="panel-title">Horario general</h2>
    <p class="draft-lede">Los tres grados de la semana en curso. Los espacios aparecen conforme se confirman.</p>
    <div class="horario-general-stack">
      ${GRADES.map((grade) => `
        <section class="horario-general-grade card" data-grade="${grade}">
          <h3 class="horario-general-grade-title">${grade}</h3>
          <div id="horario-general-${grade}-root"></div>
        </section>
      `).join('')}
    </div>
  `;

  for (const grade of GRADES) {
    const root = document.getElementById(`horario-general-${grade}-root`);
    if (!root) continue;
    await mountHorarioGrid({
      root,
      prefix: `horario-general-${grade}`,
      channelName: `horario-general-${grade}`,
      grade,
      showGradeSelect: false,
      showPlanoLink: false,
      title: null,
    });
  }
}
