// Time helpers. All business logic uses Asia/Kolkata (UTC+05:30, no DST) — plan §2.
// Dates are carried as 'YYYY-MM-DD' strings (IST calendar dates); instants as Date (UTC).
// Intervals are half-open [start, end).

export const IST_OFFSET_MS = 330 * 60 * 1000;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** IST wall-clock parts of an instant. dow: 0=Sunday … 6=Saturday. */
export function istParts(d: Date) {
  const s = new Date(d.getTime() + IST_OFFSET_MS);
  return {
    year: s.getUTCFullYear(),
    month: s.getUTCMonth() + 1,
    day: s.getUTCDate(),
    hour: s.getUTCHours(),
    minute: s.getUTCMinutes(),
    second: s.getUTCSeconds(),
    dow: s.getUTCDay(),
  };
}

/** IST calendar date of an instant, 'YYYY-MM-DD'. */
export function istDate(d: Date): string {
  const p = istParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** IST wall-clock time of an instant, 'HH:MM'. */
export function istTime(d: Date): string {
  const p = istParts(d);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function isValidDateStr(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isValidTimeStr(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) || s === "24:00";
}

/** Minutes since IST midnight for 'HH:MM'. */
export function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToTime(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

/** The UTC instant of an IST wall-clock date + time. */
export function istToUtc(date: string, time = "00:00"): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const mins = timeToMinutes(time);
  return new Date(Date.UTC(y, mo - 1, d, 0, mins) - IST_OFFSET_MS);
}

/** [start, end) instants of an IST calendar date. */
export function istDayRange(date: string): [Date, Date] {
  return [istToUtc(date), istToUtc(addDays(date, 1))];
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (b − a). */
export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
}

/** Calendar-month addition that clamps to the last day of the month. */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const dim = daysInMonth(ny, nm);
  return `${ny}-${pad(nm)}-${pad(Math.min(d, dim))}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Monday of the IST week containing `date` (weeks run Monday–Sunday). */
export function weekStart(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Financial year label (April–March), e.g. '2026-27'. */
export function financialYear(date: string): string {
  const [y, m] = date.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${pad((start + 1) % 100)}`;
}

/** Completed years of age on `onDate` for someone born on `dob` (both IST dates). */
export function ageOn(dob: string, onDate: string): number {
  const [by, bm, bd] = dob.split("-").map(Number);
  const [y, m, d] = onDate.split("-").map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

/** Prisma @db.Date values arrive as UTC-midnight Dates. */
export function dbDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function fromDbDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function dateRangeInclusive(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** '12 Oct 2026' */
export function fmtDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** 'Mon 12 Oct' */
export function fmtDay(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return `${DOWS[dow]} ${d} ${MONTHS[m - 1]}`;
}

/** '12 Oct 2026, 18:00' (IST) */
export function fmtDateTime(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return `${fmtDate(istDate(dt))}, ${istTime(dt)}`;
}

/** '18:00–19:00' (IST) */
export function fmtRange(start: Date | string, end: Date | string): string {
  const s = typeof start === "string" ? new Date(start) : start;
  const e = typeof end === "string" ? new Date(end) : end;
  return `${istTime(s)}–${istTime(e)}`;
}
