/**
 * Working-day arithmetic for statutory deadlines (e.g. 30 working days for a decision, Rule 4).
 * Bangladesh government weekend: Friday and Saturday. Public holidays come from the
 * working_day_calendar table and are passed in as ISO dates (YYYY-MM-DD, Asia/Dhaka).
 */

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000; // UTC+6, no DST

export function dhakaDateString(d: Date): string {
  return new Date(d.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}

export function dhakaYear(d: Date): number {
  return Number(dhakaDateString(d).slice(0, 4));
}

function addDays(iso: string, n: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function isWorkingDay(iso: string, holidays: ReadonlySet<string>): boolean {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay(); // 5 = Fri, 6 = Sat
  if (dow === 5 || dow === 6) return false;
  return !holidays.has(iso);
}

/**
 * Number of working days elapsed after `start` up to and including `end` (both Dhaka dates).
 * Submission day itself is not counted.
 */
export function workingDaysBetween(start: Date, end: Date, holidays: ReadonlySet<string> = new Set()): number {
  const s = dhakaDateString(start);
  const e = dhakaDateString(end);
  if (e <= s) return 0;
  let count = 0;
  for (let d = addDays(s, 1); d <= e; d = addDays(d, 1)) {
    if (isWorkingDay(d, holidays)) count++;
  }
  return count;
}

/** The Dhaka date that is `n` working days after `start`. */
export function addWorkingDays(start: Date, n: number, holidays: ReadonlySet<string> = new Set()): string {
  let d = dhakaDateString(start);
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (isWorkingDay(d, holidays)) left--;
  }
  return d;
}
