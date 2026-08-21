/**
 * Shared week arithmetic for week-scoped drafts.
 *
 * Every week is identified by the ISO date string of its MONDAY ('YYYY-MM-DD'),
 * which is exactly what draft_sessions.week_start / reservations.week_start hold
 * in the database (see sql/draft_weeks.sql).
 *
 * All arithmetic runs on UTC-anchored Date objects so the host machine's
 * timezone/DST can never shift the calendar day, and "today" is read in
 * America/Monterrey so the browser and public.current_week_start() agree.
 */

const MONTH_NAMES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** Current calendar date (wall clock) in America/Monterrey. */
export function getMonterreyToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Monterrey',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = parts.split('-').map(Number);
  return { y, m, d };
}

/** Today as a UTC-anchored Date, in Monterrey wall-clock terms. */
export function monterreyTodayUTC() {
  const { y, m, d } = getMonterreyToday();
  return new Date(Date.UTC(y, m - 1, d));
}

/** 'YYYY-MM-DD' for a UTC-anchored Date. */
export function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

/** Parse 'YYYY-MM-DD' into a UTC-anchored Date. */
export function fromIsoDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** The Monday of the week containing `date`, as a UTC-anchored Date. */
export function mondayOf(date) {
  const dow = date.getUTCDay(); // 0 = Sunday … 6 = Saturday
  const offset = dow === 0 ? -6 : 1 - dow;
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + offset
  ));
}

/**
 * The week the schedule grid displays: Mon–Fri → this week, Sat/Sun → the
 * upcoming school week. Same rule the Horario grid has always used.
 * Returns the Monday as 'YYYY-MM-DD'.
 */
export function displayWeekStart() {
  const today = monterreyTodayUTC();
  const dow = today.getUTCDay();
  const base = dow === 0 || dow === 6
    ? new Date(Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + (dow === 0 ? 1 : 2)
      ))
    : today;
  return toIsoDate(mondayOf(base));
}

/**
 * The upcoming Monday: today when today IS Monday, otherwise the next one.
 * This is the admin week selector's default — the week a draft is normally
 * being prepared for.
 */
export function upcomingWeekStart() {
  const today = monterreyTodayUTC();
  const dow = today.getUTCDay();
  if (dow === 1) return toIsoDate(today);
  const daysAhead = dow === 0 ? 1 : 8 - dow;
  return toIsoDate(new Date(Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate() + daysAhead
  )));
}

/** The Monday of the week containing today (no weekend roll-forward). */
export function currentWeekStart() {
  return toIsoDate(mondayOf(monterreyTodayUTC()));
}

/** Shift a week ('YYYY-MM-DD' Monday) by n weeks. */
export function addWeeks(weekStartIso, n) {
  const d = fromIsoDate(weekStartIso);
  return toIsoDate(new Date(Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + n * 7
  )));
}

/** The five Mon–Fri UTC-anchored Dates of a week. */
export function weekDays(weekStartIso) {
  const monday = fromIsoDate(weekStartIso);
  const days = [];
  for (let i = 0; i < 5; i++) {
    days.push(new Date(Date.UTC(
      monday.getUTCFullYear(),
      monday.getUTCMonth(),
      monday.getUTCDate() + i
    )));
  }
  return days;
}

/** 0–4 when today falls on a weekday of `weekStartIso`, else -1. */
export function todayIndexIn(weekStartIso) {
  const todayIso = toIsoDate(monterreyTodayUTC());
  return weekDays(weekStartIso).findIndex((d) => toIsoDate(d) === todayIso);
}

/** 'Semana del 4 al 8 de agosto' for a Mon–Fri Date array. */
export function formatWeekRange(days) {
  const start = days[0];
  const end = days[4];
  const sd = start.getUTCDate();
  const ed = end.getUTCDate();
  const sm = MONTH_NAMES_ES[start.getUTCMonth()];
  const em = MONTH_NAMES_ES[end.getUTCMonth()];
  const sy = start.getUTCFullYear();
  const ey = end.getUTCFullYear();
  if (sy === ey && sm === em) return `Semana del ${sd} al ${ed} de ${sm}`;
  if (sy === ey) return `Semana del ${sd} de ${sm} al ${ed} de ${em}`;
  return `Semana del ${sd} de ${sm} de ${sy} al ${ed} de ${em} de ${ey}`;
}

/** 'Semana del …' straight from a Monday ISO string. */
export function formatWeekStart(weekStartIso) {
  return formatWeekRange(weekDays(weekStartIso));
}

/** 'pasada' | 'actual' | 'futura' for a week relative to today. */
export function weekRelation(weekStartIso) {
  const now = currentWeekStart();
  if (weekStartIso === now) return 'actual';
  return weekStartIso < now ? 'pasada' : 'futura';
}
