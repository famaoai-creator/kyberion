/**
 * Japanese bank business-day calendar.
 *
 * A business day is a weekday that is neither a national holiday (国民の祝日,
 * including substitute and citizen's holidays) nor a bank closing day
 * (December 31 – January 3, 銀行法施行令 第5条). Supported years: 2022–2099,
 * the range where the current holiday law and the equinox approximation hold.
 */

export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number;
}

const MIN_YEAR = 2022;
const MAX_YEAR = 2099;

function assertSupportedYear(year: number): void {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw new Error(`Business calendar supports ${MIN_YEAR}-${MAX_YEAR}; got ${year}.`);
  }
}

function weekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Day of the month for the nth Monday. */
function nthMonday(year: number, month: number, nth: number): number {
  const first = weekday(year, month, 1);
  return 1 + ((8 - first) % 7) + (nth - 1) * 7;
}

function vernalEquinoxDay(year: number): number {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function autumnalEquinoxDay(year: number): number {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function key(month: number, day: number): string {
  return `${month}-${day}`;
}

const holidayCache = new Map<number, Set<string>>();

/** National holidays of a year as `month-day` keys, including substitute and citizen's holidays. */
export function japaneseNationalHolidays(year: number): Set<string> {
  assertSupportedYear(year);
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const fixed: Array<[number, number]> = [
    [1, 1],
    [1, nthMonday(year, 1, 2)],
    [2, 11],
    [2, 23],
    [3, vernalEquinoxDay(year)],
    [4, 29],
    [5, 3],
    [5, 4],
    [5, 5],
    [7, nthMonday(year, 7, 3)],
    [8, 11],
    [9, nthMonday(year, 9, 3)],
    [9, autumnalEquinoxDay(year)],
    [10, nthMonday(year, 10, 2)],
    [11, 3],
    [11, 23],
  ];
  const holidays = new Set(fixed.map(([month, day]) => key(month, day)));
  // Citizen's holiday: a day sandwiched between two holidays.
  for (const [month, day] of fixed) {
    const next = new Date(Date.UTC(year, month - 1, day + 2));
    const between = new Date(Date.UTC(year, month - 1, day + 1));
    if (
      holidays.has(key(next.getUTCMonth() + 1, next.getUTCDate())) &&
      !holidays.has(key(between.getUTCMonth() + 1, between.getUTCDate())) &&
      between.getUTCDay() !== 0
    ) {
      holidays.add(key(between.getUTCMonth() + 1, between.getUTCDate()));
    }
  }
  // Substitute holiday: a holiday on Sunday moves to the next non-holiday day.
  for (const [month, day] of fixed) {
    if (weekday(year, month, day) !== 0) continue;
    let offset = 1;
    let cursor = new Date(Date.UTC(year, month - 1, day + offset));
    while (holidays.has(key(cursor.getUTCMonth() + 1, cursor.getUTCDate()))) {
      offset += 1;
      cursor = new Date(Date.UTC(year, month - 1, day + offset));
    }
    if (cursor.getUTCFullYear() === year) {
      holidays.add(key(cursor.getUTCMonth() + 1, cursor.getUTCDate()));
    }
  }
  holidayCache.set(year, holidays);
  return holidays;
}

export function isJapaneseBankBusinessDay(date: CalendarDate): boolean {
  const { year, month, day } = date;
  const dow = weekday(year, month, day);
  if (dow === 0 || dow === 6) return false;
  if ((month === 12 && day === 31) || (month === 1 && day <= 3)) return false;
  return !japaneseNationalHolidays(year).has(key(month, day));
}

/** The nth business day (1-based) of a month, or undefined if the month has fewer. */
export function nthBusinessDayOfMonth(
  year: number,
  month: number,
  nth: number
): CalendarDate | undefined {
  if (!Number.isInteger(nth) || nth < 1) throw new Error(`Invalid business day ordinal: ${nth}`);
  let count = 0;
  for (let day = 1; day <= daysInMonth(year, month); day += 1) {
    if (isJapaneseBankBusinessDay({ year, month, day })) {
      count += 1;
      if (count === nth) return { year, month, day };
    }
  }
  return undefined;
}

/**
 * The nth business day (1-based) of a month, clamped to the month's last
 * business day when the month has fewer — a deadline never silently lapses
 * in a short month.
 */
export function nthBusinessDayOfMonthClamped(
  year: number,
  month: number,
  nth: number
): CalendarDate {
  const exact = nthBusinessDayOfMonth(year, month, nth);
  if (exact) return exact;
  for (let day = daysInMonth(year, month); day >= 1; day -= 1) {
    if (isJapaneseBankBusinessDay({ year, month, day })) return { year, month, day };
  }
  // Unreachable on the bank calendar (every month has weekdays), kept total.
  return { year, month, day: daysInMonth(year, month) };
}

/** Calendar date of an instant in a given IANA timezone. */
export function calendarDateInZone(instant: Date, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day') };
}

/** The UTC instant of a wall-clock time (HH:MM) on a calendar date in a timezone. */
export function zonedWallTimeToInstant(date: CalendarDate, time: string, timeZone: string): Date {
  const match = /^(\d{2}):(\d{2})$/u.exec(time);
  if (!match) throw new Error(`Invalid wall-clock time: ${time}`);
  const [hour, minute] = [Number(match[1]), Number(match[2])];
  const guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // Resolve the zone offset at the guess, then correct once (enough outside DST gaps).
  const offsetAt = (instant: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    }).formatToParts(new Date(instant));
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const asUtc = Date.UTC(
      value('year'),
      value('month') - 1,
      value('day'),
      value('hour'),
      value('minute')
    );
    return asUtc - instant;
  };
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first));
}
