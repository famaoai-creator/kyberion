/**
 * Cron Utilities
 * Shared cron matching logic for pipeline-scheduler and generation-scheduler.
 */

export function matchCronField(field: string, value: number): boolean {
  if (field === '*') return true;
  return field.split(',').some((token) => {
    const trimmed = token.trim();
    if (!trimmed) return false;
    if (trimmed.includes('/')) {
      const [base, stepRaw] = trimmed.split('/');
      const step = Number(stepRaw);
      if (!Number.isFinite(step) || step <= 0) return false;
      if (base === '*') return value % step === 0;
      if (base.includes('-')) {
        const [start, end] = base.split('-').map(Number);
        return value >= start && value <= end && (value - start) % step === 0;
      }
      return value === Number(base);
    }
    if (trimmed.includes('-')) {
      const [start, end] = trimmed.split('-').map(Number);
      return value >= start && value <= end;
    }
    return value === Number(trimmed);
  });
}

export type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

export function getZonedDateParts(date: Date, timezone?: string): ZonedDateParts {
  if (!timezone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      weekday: date.getDay(),
    };
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: weekdayMap[get('weekday')] ?? date.getDay(),
  };
}

export function matchesCron(cronExpression: string, date: Date = new Date(), timezone?: string): boolean {
  const fields = cronExpression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const p = getZonedDateParts(date, timezone);
  return (
    matchCronField(minute, p.minute) &&
    matchCronField(hour, p.hour) &&
    matchCronField(dayOfMonth, p.day) &&
    matchCronField(month, p.month) &&
    matchCronField(dayOfWeek, p.weekday)
  );
}
