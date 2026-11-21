/**
 * WorkItem calendar dates (MSN-WORK-CALENDAR-20261121).
 *
 * `start_date` / `due_date` are calendar days (`YYYY-MM-DD`) with no time or
 * timezone: a due date names the day the work is due wherever the viewer is.
 * Both are optional; when both are set, start never comes after due. An update
 * passes `null` to clear a date and omits it to keep the current value.
 */
import { isCalendarDate } from '../foundation/time.js';
import { WorkCoordinationError } from './work-coordination-error.js';
import type { WorkItem } from './work-coordination-types.js';

function assertCalendarDate(field: string, value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : value;
  if (!isCalendarDate(text)) {
    throw new WorkCoordinationError(
      'validation_error',
      `${field} must be a calendar date (YYYY-MM-DD)`
    );
  }
  return text;
}

function assertOrder(start: string | undefined, due: string | undefined): void {
  if (start && due && start > due) {
    throw new WorkCoordinationError(
      'validation_error',
      `start_date (${start}) must not be after due_date (${due})`
    );
  }
}

/** Dates for a new WorkItem; omitted inputs stay absent. */
export function workItemScheduleCreation(input: {
  startDate?: string;
  dueDate?: string;
}): Pick<WorkItem, 'start_date' | 'due_date'> {
  const start =
    input.startDate === undefined ? undefined : assertCalendarDate('start_date', input.startDate);
  const due =
    input.dueDate === undefined ? undefined : assertCalendarDate('due_date', input.dueDate);
  assertOrder(start, due);
  return { ...(start ? { start_date: start } : {}), ...(due ? { due_date: due } : {}) };
}

/**
 * The date patch for an update: `undefined` keeps the current value, `null`
 * clears it. Order is checked against the resulting pair, so moving only the
 * due date before an existing start date is refused.
 */
export function workItemScheduleUpdate(
  current: Pick<WorkItem, 'start_date' | 'due_date'>,
  input: { startDate?: string | null; dueDate?: string | null }
): Partial<Pick<WorkItem, 'start_date' | 'due_date'>> {
  if (input.startDate === undefined && input.dueDate === undefined) return {};
  const start =
    input.startDate === undefined
      ? current.start_date
      : input.startDate === null
        ? undefined
        : assertCalendarDate('start_date', input.startDate);
  const due =
    input.dueDate === undefined
      ? current.due_date
      : input.dueDate === null
        ? undefined
        : assertCalendarDate('due_date', input.dueDate);
  assertOrder(start, due);
  return { start_date: start, due_date: due };
}
