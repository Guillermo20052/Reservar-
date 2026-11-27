/**
 * Space-usage + learning-modality dashboards.
 *
 *   mountUsoEspacios(profile)    admin tab "Uso de espacios": group view
 *                                (all teachers) or individual view (one teacher).
 *   mountMisModalidades(profile) teacher tab "Mis modalidades": individual view,
 *                                locked to the signed-in teacher.
 *
 * Data: reservations (one row per space pick, week-scoped) + class_modalities
 * (one row per teacher + class + week, 1–20 modality ids). A "class" is the
 * tuple (week_start, slot_id, slot_part_id, teacher_id); it may have 0–2
 * space picks and 0 or 1 modality set. Modality names come from
 * public.modalities (seeded verbatim from the guide's DATA.modalidades).
 */
import { supabase } from './supabase.js';
import { addWeeks, currentWeekStart, fromIsoDate } from './week-utils.js';

const GRADES = ['10mo', '11vo', '12vo'];
const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const PAGE = 1000;
const DEFAULT_WEEKS = 4;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function minutes(time) {
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
}

function shortWeek(iso) {
  const d = fromIsoDate(iso);
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

function longWeek(iso) {
  const d = fromIsoDate(iso);
  return `Semana del ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function fmtHours(h) {
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

function pct(n, d) {
  return d ? Math.round((n / d) * 100) : 0;
}

/** Page through PostgREST's 1000-row cap. `build` returns a fresh query. */
async function fetchAll(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadCatalog() {
  const [mods, spaces, sessions] = await Promise.all([
    supabase.from('modalities').select('id, name').order('id'),
    supabase.from('spaces').select('id, name, sort_order').order('sort_order'),
    supabase.from('draft_sessions').select('week_start').order('week_start'),
  ]);
  if (mods.error) throw mods.error;
  if (spaces.error) throw spaces.error;
  if (sessions.error) throw sessions.error;

  const sessionWeeks = [...new Set((sessions.data ?? []).map((s) => s.week_start))].sort();
  return { modalities: mods.data ?? [], spaces: spaces.data ?? [], sessionWeeks };
}

async function loadTeachers() {
  const { data, error } = await supabase
    .from('profile_names')
    .select('id, full_name, role')
    .eq('role', 'teacher')
    .order('full_name');
  if (error) throw error;
  return data ?? [];
}

async function loadRange(fromWeek, toWeek, teacherId) {
  const [reservations, classMods] = await Promise.all([
    fetchAll(() => {
      let q = supabase
        .from('reservations')
        .select('id, week_start, slot_id, slot_part_id, teacher_id, space_id, timetable_slots(grade, start_time, end_time)')
        .gte('week_start', fromWeek)
        .lte('week_start', toWeek)
        .order('id');
      if (teacherId) q = q.eq('teacher_id', teacherId);
      return q;
    }),
    fetchAll(() => {
      let q = supabase
        .from('class_modalities')
        .select('id, week_start, slot_id, slot_part_id, teacher_id, modality_ids, timetable_slots(grade)')
        .gte('week_start', fromWeek)
        .lte('week_start', toWeek)
        .order('id');
      if (teacherId) q = q.eq('teacher_id', teacherId);
      return q;
    }),
  ]);
  return { reservations, classMods };
}

/** Merge picks + modality rows into one record per class. */
function buildClasses({ reservations, classMods }) {
  /** @type {Map<string, {week: string, teacher: string, grade: string|null, spaces: Map<number, number>, mods: number[]|null}>} */
  const classes = new Map();
  const keyOf = (r) => `${r.week_start}|${r.slot_id}|${r.slot_part_id || ''}|${r.teacher_id}`;
  const get = (r, grade) => {
    const k = keyOf(r);
    let c = classes.get(k);
    if (!c) {
      c = { week: r.week_start, teacher: r.teacher_id, grade: grade ?? null, spaces: new Map(), mods: null };
      classes.set(k, c);
    }
    if (!c.grade && grade) c.grade = grade;
    return c;
  };

  for (const r of reservations) {
    const slot = r.timetable_slots;
    const c = get(r, slot?.grade);
    const hours = slot ? Math.max(0, minutes(slot.end_time) - minutes(slot.start_time)) / 60 : 0;
    c.spaces.set(r.space_id, (c.spaces.get(r.space_id) ?? 0) + hours);
  }
  for (const m of classMods) {
    const c = get(m, m.timetable_slots?.grade);
    c.mods = (m.modality_ids ?? []).map(Number);
  }
  return [...classes.values()];
}

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

function summarize(classes, catalog, weeks) {
  const modCount = new Map(catalog.modalities.map((m) => [m.id, 0]));
  const spaceHours = new Map();
  const spaceClasses = new Map();
  const matrix = new Map(); // spaceId -> Map(modId -> count)
  const modByWeek = new Map(); // modId -> Map(week -> count)
  let withMods = 0;

  for (const c of classes) {
    for (const [spaceId, h] of c.spaces) {
      spaceHours.set(spaceId, (spaceHours.get(spaceId) ?? 0) + h);
      spaceClasses.set(spaceId, (spaceClasses.get(spaceId) ?? 0) + 1);
    }
    if (!c.mods) continue;
    withMods += 1;
    for (const id of c.mods) {
      modCount.set(id, (modCount.get(id) ?? 0) + 1);
      if (!modByWeek.has(id)) modByWeek.set(id, new Map());
      const wk = modByWeek.get(id);
      wk.set(c.week, (wk.get(c.week) ?? 0) + 1);
      for (const spaceId of c.spaces.keys()) {
        if (!matrix.has(spaceId)) matrix.set(spaceId, new Map());
        const row = matrix.get(spaceId);
        row.set(id, (row.get(id) ?? 0) + 1);
      }
    }
  }

  const distinct = [...modCount.values()].filter((n) => n > 0).length;
  return { total: classes.length, withMods, modCount, spaceHours, spaceClasses, matrix, modByWeek, distinct, weeks };
}

// ---------------------------------------------------------------------------
// Rendering primitives (plain HTML/CSS, theme.css tokens)
// ---------------------------------------------------------------------------

function statTiles(tiles) {
  return `<div class="uso-tiles">${tiles
    .map((t) => `
      <div class="uso-tile">
        <span class="uso-tile-label">${escapeHtml(t.label)}</span>
        <span class="uso-tile-value">${escapeHtml(t.value)}</span>
        ${t.note ? `<span class="uso-tile-note">${escapeHtml(t.note)}</span>` : ''}
      </div>`)
    .join('')}</div>`;
}

/** Horizontal single-series bar list; rows: {label, value, display, tip}. */
function barList(rows, { emptyText = 'Sin datos en este rango.' } = {}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length || max === 0) return `<p class="uso-empty">${escapeHtml(emptyText)}</p>`;
  return `<ul class="uso-bars">${rows
    .map((r) => {
      const w = max ? (r.value / max) * 100 : 0;
      return `
        <li class="uso-bar-row" data-tip="${escapeHtml(r.tip)}">
          <span class="uso-bar-label">${r.labelHtml ?? escapeHtml(r.label)}</span>
          <span class="uso-bar-track"><span class="uso-bar-fill" style="width:${w.toFixed(2)}%"></span></span>
          <span class="uso-bar-value">${escapeHtml(r.display ?? String(r.value))}</span>
        </li>`;
    })
    .join('')}</ul>`;
}

/** Sequential single-hue cell: 0 = surface, max = deep navy-red. */
function heatCell(value, max, tip) {
  if (!value) return `<td class="uso-heat-cell uso-heat-zero" data-tip="${escapeHtml(tip)}">·</td>`;
  const t = max ? value / max : 0;
  const mix = Math.round(12 + t * 88); // keep the lowest non-zero visible
  const dark = mix > 55 ? ' uso-heat-dark' : '';
  return `<td class="uso-heat-cell${dark}" style="background:color-mix(in oklab, var(--navy) ${mix}%, #fff)" data-tip="${escapeHtml(tip)}">${value}</td>`;
}

function modLabelHtml(m) {
  return `<span class="uso-mod-num">${m.id}</span>${escapeHtml(m.name)}`;
}

function modalityKey(modalities) {
  return `<details class="uso-key"><summary>Ver las 20 modalidades</summary><ol class="uso-key-list">${modalities
    .map((m) => `<li><span class="uso-mod-num">${m.id}</span>${escapeHtml(m.name)}</li>`)
    .join('')}</ol></details>`;
}

function section(title, sub, body) {
  return `
    <section class="uso-section">
      <h3 class="uso-section-title">${escapeHtml(title)}</h3>
      ${sub ? `<p class="uso-section-sub">${escapeHtml(sub)}</p>` : ''}
      ${body}
    </section>`;
}

function modalityBars(sum, catalog) {
  const rows = catalog.modalities
    .map((m) => ({
      label: `${m.id} · ${m.name}`,
      labelHtml: modLabelHtml(m),
      value: sum.modCount.get(m.id) ?? 0,
      tip: `${m.id} · ${m.name}: ${sum.modCount.get(m.id) ?? 0} clases (${pct(sum.modCount.get(m.id) ?? 0, sum.withMods)}% de las clases con modalidades)`,
    }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'es', { numeric: true }));
  return barList(rows, { emptyText: 'Aún no hay modalidades registradas en este rango.' });
}

function spaceBars(sum, catalog, { onlyUsed = false } = {}) {
  const rows = catalog.spaces
    .map((s) => {
      const h = sum.spaceHours.get(s.id) ?? 0;
      const n = sum.spaceClasses.get(s.id) ?? 0;
      return {
        label: s.name,
        value: h,
        display: `${fmtHours(h)} h`,
        tip: `${s.name}: ${fmtHours(h)} horas-clase en ${n} ${n === 1 ? 'clase' : 'clases'}`,
      };
    })
    .filter((r) => !onlyUsed || r.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'es'));
  return barList(rows, { emptyText: 'No hay reservas de espacios en este rango.' });
}

function spaceModalityMatrix(sum, catalog) {
  const max = Math.max(0, ...[...sum.matrix.values()].flatMap((row) => [...row.values()]));
  if (!max) return '<p class="uso-empty">Aún no hay clases con espacio y modalidades en este rango.</p>';
  const head = catalog.modalities
    .map((m) => `<th scope="col" class="uso-heat-col" data-tip="${escapeHtml(`${m.id} · ${m.name}`)}">${m.id}</th>`)
    .join('');
  const body = catalog.spaces
    .map((s) => {
      const row = sum.matrix.get(s.id) ?? new Map();
      const total = [...row.values()].reduce((a, b) => a + b, 0);
      const cells = catalog.modalities
        .map((m) => heatCell(row.get(m.id) ?? 0, max, `${s.name} × ${m.id} · ${m.name}: ${row.get(m.id) ?? 0} clases`))
        .join('');
      return `<tr${total ? '' : ' class="uso-heat-row-empty"'}><th scope="row" class="uso-heat-rowhd">${escapeHtml(s.name)}</th>${cells}</tr>`;
    })
    .join('');
  return `
    <div class="uso-heat-wrap">
      <table class="uso-heat">
        <thead><tr><th scope="col" class="uso-heat-corner">Espacio \\ Modalidad</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    ${heatLegend(max)}`;
}

function modalityTimeline(sum, catalog) {
  const weeks = sum.weeks;
  let max = 0;
  for (const wk of sum.modByWeek.values()) for (const v of wk.values()) max = Math.max(max, v);
  if (!max) return '<p class="uso-empty">Aún no hay modalidades registradas en este rango.</p>';
  const head = weeks.map((w) => `<th scope="col" class="uso-heat-col uso-heat-col-week" data-tip="${escapeHtml(longWeek(w))}">${escapeHtml(shortWeek(w))}</th>`).join('');
  const body = catalog.modalities
    .map((m) => {
      const wk = sum.modByWeek.get(m.id) ?? new Map();
      const total = sum.modCount.get(m.id) ?? 0;
      const cells = weeks
        .map((w) => heatCell(wk.get(w) ?? 0, max, `${m.id} · ${m.name} — ${longWeek(w)}: ${wk.get(w) ?? 0} clases`))
        .join('');
      return `<tr${total ? '' : ' class="uso-heat-row-empty"'}><th scope="row" class="uso-heat-rowhd">${modLabelHtml(m)}</th>${cells}<td class="uso-heat-total">${total}</td></tr>`;
    })
    .join('');
  return `
    <div class="uso-heat-wrap">
      <table class="uso-heat uso-heat-timeline">
        <thead><tr><th scope="col" class="uso-heat-corner">Modalidad</th>${head}<th scope="col" class="uso-heat-col">Total</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    ${heatLegend(max)}`;
}

function heatLegend(max) {
  const steps = [1, Math.max(1, Math.round(max / 2)), max].filter((v, i, a) => a.indexOf(v) === i);
  return `<div class="uso-heat-legend"><span>Clases:</span>${steps
    .map((v) => {
      const mix = Math.round(12 + (v / max) * 88);
      return `<span class="uso-heat-legend-item"><span class="uso-heat-swatch" style="background:color-mix(in oklab, var(--navy) ${mix}%, #fff)"></span>${v}</span>`;
    })
    .join('')}<span class="uso-heat-legend-item"><span class="uso-heat-swatch uso-heat-swatch-zero">·</span>0</span></div>`;
}

function renderGroupView(sum, catalog) {
  return `
    ${statTiles([
      { label: 'Clases en el rango', value: String(sum.total) },
      { label: 'Con modalidades registradas', value: `${pct(sum.withMods, sum.total)}%`, note: `${sum.withMods} de ${sum.total} clases` },
      { label: 'Modalidades distintas usadas', value: `${sum.distinct} / ${catalog.modalities.length}` },
    ])}
    <div class="uso-grid">
      ${section('Modalidades más usadas', 'Número de clases que registraron cada modalidad.', modalityBars(sum, catalog))}
      ${section('Uso de espacios', 'Horas-clase reservadas por espacio.', spaceBars(sum, catalog))}
    </div>
    ${section('Modalidades por espacio', 'Clases por combinación espacio × modalidad. Una clase con dos espacios cuenta en ambos.', spaceModalityMatrix(sum, catalog) + modalityKey(catalog.modalities))}
  `;
}

function renderIndividualView(sum, catalog, teacherName) {
  const title = teacherName ? `<p class="uso-individual-hd">Vista individual · <strong>${escapeHtml(teacherName)}</strong></p>` : '';
  return `
    ${title}
    ${statTiles([
      { label: 'Variedad', value: `${sum.distinct} / ${catalog.modalities.length}`, note: 'modalidades distintas en el rango' },
      { label: 'Con modalidades registradas', value: `${pct(sum.withMods, sum.total)}%`, note: `${sum.withMods} de ${sum.total} clases` },
      { label: 'Espacios distintos', value: String([...sum.spaceHours.values()].filter((h) => h > 0).length) },
    ])}
    ${section('Modalidades en el tiempo', 'Clases por semana en que se usó cada modalidad.', modalityTimeline(sum, catalog))}
    <div class="uso-grid">
      ${section('Espacios que usa', 'Horas-clase reservadas por espacio.', spaceBars(sum, catalog, { onlyUsed: true }))}
      ${section('Modalidades más usadas', 'Número de clases por modalidad.', modalityBars(sum, catalog))}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Tooltip (one floating element per panel, event-delegated)
// ---------------------------------------------------------------------------

function wireTooltip(panel) {
  let tip = panel.querySelector('.uso-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'uso-tooltip';
    tip.hidden = true;
    tip.setAttribute('role', 'tooltip');
    panel.appendChild(tip);
  }
  const place = (e) => {
    const pad = 14;
    const rect = tip.getBoundingClientRect();
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    if (x + rect.width > window.innerWidth - 8) x = e.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8) y = e.clientY - rect.height - pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  };
  panel.addEventListener('pointerover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el || !panel.contains(el)) return;
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    place(e);
  });
  panel.addEventListener('pointermove', (e) => {
    if (!tip.hidden) place(e);
  });
  panel.addEventListener('pointerout', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el && !el.contains(e.relatedTarget)) tip.hidden = true;
  });
}

// ---------------------------------------------------------------------------
// Dashboard controller
// ---------------------------------------------------------------------------

function weekOptions(sessionWeeks) {
  const now = currentWeekStart();
  const first = sessionWeeks[0] ?? addWeeks(now, -(DEFAULT_WEEKS - 1));
  const lastSession = sessionWeeks[sessionWeeks.length - 1] ?? now;
  const last = lastSession > now ? lastSession : now;
  const weeks = [];
  for (let w = first; w <= last; w = addWeeks(w, 1)) weeks.push(w);
  return weeks;
}

function weeksBetween(from, to) {
  const out = [];
  for (let w = from; w <= to; w = addWeeks(w, 1)) out.push(w);
  return out;
}

function filtersHtml({ weeks, from, to, showTeacher, teachers }) {
  const weekOpts = (selected) =>
    weeks.map((w) => `<option value="${w}"${w === selected ? ' selected' : ''}>${escapeHtml(longWeek(w))}</option>`).join('');
  const teacherSelect = showTeacher
    ? `
      <label class="uso-filter">
        <span class="uso-filter-label">Maestra</span>
        <select class="input" data-filter="teacher">
          <option value="">Todas (vista grupal)</option>
          ${teachers.map((t) => `<option value="${t.id}">${escapeHtml(t.full_name || 'Sin nombre')}</option>`).join('')}
        </select>
      </label>`
    : '';
  return `
    <div class="uso-filters">
      <label class="uso-filter">
        <span class="uso-filter-label">Desde</span>
        <select class="input" data-filter="from">${weekOpts(from)}</select>
      </label>
      <label class="uso-filter">
        <span class="uso-filter-label">Hasta</span>
        <select class="input" data-filter="to">${weekOpts(to)}</select>
      </label>
      <label class="uso-filter">
        <span class="uso-filter-label">Grado</span>
        <select class="input" data-filter="grade">
          <option value="">Todos</option>
          ${GRADES.map((g) => `<option value="${g}">${g}</option>`).join('')}
        </select>
      </label>
      ${teacherSelect}
    </div>`;
}

/**
 * @param {HTMLElement} panel
 * @param {{ title: string, intro: string, mode: 'admin' | 'teacher', teacherId?: string }} opts
 */
async function mountDashboard(panel, opts) {
  panel.innerHTML = `
    <h2 class="panel-title">${escapeHtml(opts.title)}</h2>
    <p class="uso-intro">${escapeHtml(opts.intro)}</p>
    <div class="alert alert-error uso-alert" hidden></div>
    <div class="uso-filters-root"><p class="uso-loading">Cargando…</p></div>
    <div class="uso-body"></div>
  `;
  const alertEl = panel.querySelector('.uso-alert');
  const body = panel.querySelector('.uso-body');
  const showError = (err) => {
    alertEl.textContent = `No se pudieron cargar los datos: ${err?.message || err}`;
    alertEl.hidden = false;
  };

  let catalog;
  let teachers = [];
  try {
    [catalog, teachers] = await Promise.all([
      loadCatalog(),
      opts.mode === 'admin' ? loadTeachers() : Promise.resolve([]),
    ]);
  } catch (err) {
    panel.querySelector('.uso-filters-root').innerHTML = '';
    showError(err);
    return;
  }

  const weeks = weekOptions(catalog.sessionWeeks);
  const lastSession = catalog.sessionWeeks[catalog.sessionWeeks.length - 1];
  // Default: the last 4 weeks ending at the newest drafted week (includes the
  // week currently being registered, where new modality data lands first).
  const to = lastSession && weeks.includes(lastSession) ? lastSession : weeks[weeks.length - 1];
  const fromIdx = Math.max(0, weeks.indexOf(to) - (DEFAULT_WEEKS - 1));
  const filters = { from: weeks[fromIdx], to, grade: '', teacher: opts.teacherId ?? '' };

  panel.querySelector('.uso-filters-root').innerHTML = filtersHtml({
    weeks,
    from: filters.from,
    to: filters.to,
    showTeacher: opts.mode === 'admin',
    teachers,
  });

  /** Raw data cache keyed by range+teacher; grade filters client-side. */
  let cache = { key: '', classes: [] };
  let seq = 0;

  async function render() {
    const mySeq = ++seq;
    alertEl.hidden = true;
    let { from: f, to: t } = filters;
    if (f > t) [f, t] = [t, f];
    const teacherId = opts.mode === 'teacher' ? opts.teacherId : filters.teacher || null;
    const key = `${f}|${t}|${teacherId ?? ''}`;

    if (cache.key !== key) {
      body.innerHTML = '<p class="uso-loading">Cargando…</p>';
      try {
        const raw = await loadRange(f, t, teacherId);
        if (mySeq !== seq) return;
        cache = { key, classes: buildClasses(raw) };
      } catch (err) {
        if (mySeq !== seq) return;
        body.innerHTML = '';
        showError(err);
        return;
      }
    }

    const classes = filters.grade ? cache.classes.filter((c) => c.grade === filters.grade) : cache.classes;
    const sum = summarize(classes, catalog, weeksBetween(f, t));

    if (teacherId) {
      const name = opts.mode === 'admin' ? teachers.find((x) => x.id === teacherId)?.full_name ?? '' : '';
      body.innerHTML = renderIndividualView(sum, catalog, name);
    } else {
      body.innerHTML = renderGroupView(sum, catalog);
    }
  }

  panel.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-filter]');
    if (!sel) return;
    filters[sel.dataset.filter] = sel.value;
    render();
  });

  wireTooltip(panel);
  await render();
}

export async function mountUsoEspacios(profile) {
  if (profile.role !== 'admin') return;
  const panel = document.getElementById('panel-uso-de-espacios');
  if (!panel) return;
  await mountDashboard(panel, {
    mode: 'admin',
    title: 'Uso de espacios',
    intro: 'Cómo se usan los espacios y qué modalidades de enseñanza de Nair registran las maestras en cada clase. Elige una maestra para ver su vista individual.',
  });
}

export async function mountMisModalidades(profile) {
  if (profile.role !== 'teacher') return;
  const panel = document.getElementById('panel-mis-modalidades');
  if (!panel) return;
  await mountDashboard(panel, {
    mode: 'teacher',
    teacherId: profile.id,
    title: 'Mis modalidades',
    intro: 'Tus modalidades de enseñanza y los espacios que usas, semana a semana.',
  });
}
