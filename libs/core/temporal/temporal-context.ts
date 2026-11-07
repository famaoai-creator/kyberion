/**
 * Shared temporal vocabulary for calendar, scheduler, and organization work.
 *
 * This module is intentionally provider-free. Calendar adapters exchange
 * instants and busy windows; this module supplies the timezone, business-day,
 * and working-hours interpretation around those values.
 */
import {
  calendarDateInZone,
  nthBusinessDayOfMonthClamped,
  zonedWallTimeToInstant,
  type CalendarDate,
} from './business-calendar.js';

export type TemporalBusinessCalendar = 'none' | 'japanese_bank';

export interface TemporalWorkingHours {
  start: string;
  end: string;
  weekdays?: number[];
}

export interface TemporalContext {
  now: Date;
  timezone: string;
  locale?: string;
  business_calendar: TemporalBusinessCalendar;
  working_hours?: TemporalWorkingHours;
  default_duration_minutes: number;
}

export interface TemporalContextInput {
  now?: Date | string;
  timezone?: string;
  locale?: string;
  business_calendar?: TemporalBusinessCalendar;
  working_hours?: TemporalWorkingHours;
  default_duration_minutes?: number;
}

export interface TemporalWindowInput {
  start?: string;
  end?: string;
  duration_minutes?: number;
  business_day?: number;
  wall_time?: string;
}

export interface TemporalWindow {
  start: Date;
  end: Date;
  timezone: string;
  resolved_from: 'absolute' | 'business_day';
}

const DEFAULT_DURATION_MINUTES = 30;
const TIME_RE = /^\d{2}:\d{2}$/u;

function parseDate(value: Date | string | undefined, label: string, fallback: Date): Date {
  if (value === undefined) return new Date(fallback.getTime());
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`[TEMPORAL] invalid ${label}`);
  return parsed;
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    throw new Error(`[TEMPORAL] invalid timezone '${timezone}'`);
  }
}

function assertWallTime(value: string, label: string): void {
  if (!TIME_RE.test(value)) throw new Error(`[TEMPORAL] invalid ${label}: '${value}'`);
  const [hour, minute] = value.split(':').map(Number);
  if (hour > 23 || minute > 59) throw new Error(`[TEMPORAL] invalid ${label}: '${value}'`);
}

function assertDuration(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 24 * 60) {
    throw new Error(`[TEMPORAL] duration_minutes must be an integer from 1 to 1440`);
  }
}

export function resolveTemporalContext(input: TemporalContextInput = {}): TemporalContext {
  const timezone =
    input.timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  assertTimezone(timezone);
  const now = parseDate(input.now, 'now', new Date());
  const duration = input.default_duration_minutes ?? DEFAULT_DURATION_MINUTES;
  assertDuration(duration);
  const workingHours = input.working_hours
    ? { ...input.working_hours, weekdays: input.working_hours.weekdays?.slice() }
    : undefined;
  if (workingHours) {
    assertWallTime(workingHours.start, 'working_hours.start');
    assertWallTime(workingHours.end, 'working_hours.end');
    if (workingHours.start >= workingHours.end) {
      throw new Error('[TEMPORAL] working_hours.start must be before end');
    }
    if (workingHours.weekdays?.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new Error('[TEMPORAL] working_hours.weekdays must contain values from 0 to 6');
    }
  }
  return {
    now,
    timezone,
    ...(input.locale?.trim() ? { locale: input.locale.trim() } : {}),
    business_calendar: input.business_calendar || 'none',
    ...(workingHours ? { working_hours: workingHours } : {}),
    default_duration_minutes: duration,
  };
}

function dateAtBusinessDay(context: TemporalContext, ordinal: number): CalendarDate {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error('[TEMPORAL] business_day must be a positive integer');
  }
  const current = calendarDateInZone(context.now, context.timezone);
  if (context.business_calendar === 'japanese_bank') {
    return nthBusinessDayOfMonthClamped(current.year, current.month, ordinal);
  }
  let count = 0;
  const daysInMonth = new Date(Date.UTC(current.year, current.month, 0)).getUTCDate();
  for (let day = 1; day <= daysInMonth; day += 1) {
    const candidate = { year: current.year, month: current.month, day };
    const weekday = new Date(
      Date.UTC(candidate.year, candidate.month - 1, candidate.day)
    ).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
    if (count === ordinal) return candidate;
  }
  throw new Error(`[TEMPORAL] could not resolve business_day ${ordinal}`);
}

export function resolveTemporalWindow(
  input: TemporalWindowInput,
  contextInput: TemporalContextInput = {}
): TemporalWindow {
  const context = resolveTemporalContext(contextInput);
  const duration = input.duration_minutes ?? context.default_duration_minutes;
  assertDuration(duration);
  if (input.business_day !== undefined) {
    if (!input.wall_time) throw new Error('[TEMPORAL] wall_time is required with business_day');
    assertWallTime(input.wall_time, 'wall_time');
    const start = zonedWallTimeToInstant(
      dateAtBusinessDay(context, input.business_day),
      input.wall_time,
      context.timezone
    );
    return {
      start,
      end: new Date(start.getTime() + duration * 60_000),
      timezone: context.timezone,
      resolved_from: 'business_day',
    };
  }
  const start = parseDate(input.start, 'start', context.now);
  const end = input.end
    ? parseDate(input.end, 'end', start)
    : new Date(start.getTime() + duration * 60_000);
  if (end.getTime() <= start.getTime()) throw new Error('[TEMPORAL] end must be after start');
  return { start, end, timezone: context.timezone, resolved_from: 'absolute' };
}
