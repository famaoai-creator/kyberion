import {
  calendarDateInZone,
  isJapaneseBankBusinessDay,
  zonedWallTimeToInstant,
} from './business-calendar.js';
import {
  resolveTemporalContext,
  type TemporalContextInput,
  type TemporalWorkingHours,
} from './temporal-context.js';

export interface BusyWindow {
  start: string;
  end: string;
}

export interface AvailableSlotRequest extends TemporalContextInput {
  range_start: string;
  range_end: string;
  duration_minutes: number;
  slot_step_minutes?: number;
  busy: BusyWindow[];
}

export interface AvailableSlot {
  start: string;
  end: string;
  timezone: string;
}

function parseInstant(value: string, label: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`[TEMPORAL_SLOT] invalid ${label}`);
  return parsed;
}

function overlaps(
  start: number,
  end: number,
  busy: Array<{ start: number; end: number }>
): boolean {
  return busy.some((window) => start < window.end && end > window.start);
}

function dayKey(date: Date, timezone: string): string {
  const value = calendarDateInZone(date, timezone);
  return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

function nextDay(date: Date, timezone: string): Date {
  const current = calendarDateInZone(date, timezone);
  return zonedWallTimeToInstant({ ...current, day: current.day + 1 }, '00:00', timezone);
}

function defaultWorkingHours(): TemporalWorkingHours {
  return { start: '09:00', end: '18:00', weekdays: [1, 2, 3, 4, 5] };
}

export function planAvailableSlots(input: AvailableSlotRequest): AvailableSlot[] {
  const context = resolveTemporalContext(input);
  const rangeStart = parseInstant(input.range_start, 'range_start');
  const rangeEnd = parseInstant(input.range_end, 'range_end');
  if (rangeEnd <= rangeStart)
    throw new Error('[TEMPORAL_SLOT] range_end must be after range_start');
  if (!Number.isInteger(input.duration_minutes) || input.duration_minutes < 1) {
    throw new Error('[TEMPORAL_SLOT] duration_minutes must be a positive integer');
  }
  const step = input.slot_step_minutes ?? input.duration_minutes;
  if (!Number.isInteger(step) || step < 1)
    throw new Error('[TEMPORAL_SLOT] slot_step_minutes must be positive');
  const busy = input.busy.map((window) => ({
    start: parseInstant(window.start, 'busy.start').getTime(),
    end: parseInstant(window.end, 'busy.end').getTime(),
  }));
  const hours = context.working_hours || defaultWorkingHours();
  const weekdays = hours.weekdays || [1, 2, 3, 4, 5];
  const slots: AvailableSlot[] = [];
  const seenDays = new Set<string>();
  for (let cursor = rangeStart; cursor < rangeEnd; cursor = nextDay(cursor, context.timezone)) {
    const date = calendarDateInZone(cursor, context.timezone);
    const key = dayKey(cursor, context.timezone);
    if (seenDays.has(key)) continue;
    seenDays.add(key);
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    if (!weekdays.includes(weekday)) continue;
    if (context.business_calendar === 'japanese_bank' && !isJapaneseBankBusinessDay(date)) continue;
    const dayStart = zonedWallTimeToInstant(date, hours.start, context.timezone);
    const dayEnd = zonedWallTimeToInstant(date, hours.end, context.timezone);
    for (
      let start = Math.max(dayStart.getTime(), rangeStart.getTime());
      start + input.duration_minutes * 60_000 <= Math.min(dayEnd.getTime(), rangeEnd.getTime());
      start += step * 60_000
    ) {
      const end = start + input.duration_minutes * 60_000;
      if (!overlaps(start, end, busy)) {
        slots.push({
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString(),
          timezone: context.timezone,
        });
      }
    }
  }
  return slots;
}
