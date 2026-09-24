import { matchCronField, matchesCron } from './cron-utils.js';
import type {
  OrganizationOperationRecord,
  OrganizationOperationState,
} from './organization-operating-model.js';

/** Resolve the next scheduled occurrence after the latest completed run (or registration). */
export function nextOrganizationOperationDue(
  operation: OrganizationOperationRecord,
  lastRunAt?: string
): string | undefined {
  if (operation.trigger.kind !== 'schedule' || !operation.trigger.expression) return undefined;
  const anchor = Date.parse(lastRunAt || operation.updated_at);
  if (!Number.isFinite(anchor)) return undefined;
  const fields = operation.trigger.expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minuteField, , dayField, monthField, weekdayField] = fields;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: operation.trigger.timezone || 'UTC' });
  } catch {
    return undefined;
  }
  if (dayField !== '*' && monthField !== '*') {
    const startYear = new Date(anchor).getUTCFullYear();
    let calendarMatch = false;
    for (let year = startYear; year <= startYear + 9 && !calendarMatch; year += 1) {
      for (let month = 1; month <= 12 && !calendarMatch; month += 1) {
        if (!matchCronField(monthField, month)) continue;
        for (let day = 1; day <= 31; day += 1) {
          if (!matchCronField(dayField, day)) continue;
          const date = new Date(Date.UTC(year, month - 1, day));
          if (date.getUTCMonth() === month - 1 && matchCronField(weekdayField, date.getUTCDay())) {
            calendarMatch = true;
            break;
          }
        }
      }
    }
    if (!calendarMatch) return undefined;
  }
  const candidates = Array.from({ length: 60 }, (_, minute) => minute).filter((minute) =>
    matchCronField(minuteField, minute)
  );
  if (!candidates.length) return undefined;
  const firstHour = new Date(anchor);
  firstHour.setUTCMinutes(0, 0, 0);
  // Inspect matching minutes within each hour; this preserves timezone and DST behavior.
  // February 29 may be separated by eight years across a non-leap century.
  for (let hour = 0; hour < 8 * 366 * 24; hour += 1) {
    for (const minute of candidates) {
      const cursor = new Date(firstHour.getTime() + hour * 3_600_000 + minute * 60_000);
      if (
        cursor.getTime() > anchor &&
        matchesCron(operation.trigger.expression, cursor, operation.trigger.timezone || 'UTC')
      ) {
        return cursor.toISOString();
      }
    }
  }
  return undefined;
}

export function organizationOperationDueProjection(
  operation: OrganizationOperationRecord,
  state: OrganizationOperationState | null,
  now = new Date()
): Pick<OrganizationOperationState, 'due_status' | 'next_due_at'> {
  if (operation.trigger.kind === 'manual' || operation.trigger.kind === 'event') {
    return { due_status: 'not_scheduled' };
  }
  const nextDue = nextOrganizationOperationDue(operation, state?.last_run_at);
  if (!nextDue) return { due_status: 'unknown' };
  const dueAt = Date.parse(nextDue);
  return {
    next_due_at: nextDue,
    due_status:
      dueAt > now.getTime() ? 'current' : dueAt + 60_000 > now.getTime() ? 'due' : 'overdue',
  };
}
