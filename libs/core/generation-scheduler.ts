import * as path from 'node:path';
import { safeExistsSync, safeMkdir, safeReadFile, safeReaddir, safeWriteFile } from './secure-io.js';
import type { GenerationSchedule } from './src/types/generation-schedule.js';

export const GENERATION_SCHEDULE_DIR = 'active/shared/runtime/media-generation/schedules';

function nowIso(date = new Date()): string {
  return date.toISOString();
}

function ensureScheduleDir(): void {
  if (!safeExistsSync(GENERATION_SCHEDULE_DIR)) {
    safeMkdir(GENERATION_SCHEDULE_DIR, { recursive: true });
  }
}

export function generationSchedulePath(scheduleId: string): string {
  return path.join(GENERATION_SCHEDULE_DIR, `${scheduleId}.json`);
}

export function readGenerationSchedule(logicalPath: string): GenerationSchedule {
  return JSON.parse(safeReadFile(logicalPath, { encoding: 'utf8' }) as string) as GenerationSchedule;
}

export function writeGenerationSchedule(schedule: GenerationSchedule): GenerationSchedule {
  ensureScheduleDir();
  safeWriteFile(generationSchedulePath(schedule.schedule_id), JSON.stringify(schedule, null, 2));
  return schedule;
}

export function registerGenerationSchedule(sourcePath: string): GenerationSchedule {
  const schedule = readGenerationSchedule(sourcePath);
  return writeGenerationSchedule({
    ...schedule,
    updated_at: nowIso(),
  });
}

export function listGenerationSchedules(): GenerationSchedule[] {
  if (!safeExistsSync(GENERATION_SCHEDULE_DIR)) return [];
  return safeReaddir(GENERATION_SCHEDULE_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readGenerationSchedule(path.join(GENERATION_SCHEDULE_DIR, name)))
    .sort((a, b) => a.schedule_id.localeCompare(b.schedule_id));
}

function matchCronField(field: string, value: number): boolean {
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

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

function getZonedDateParts(date: Date, timezone?: string): ZonedDateParts {
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
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
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

export function isGenerationScheduleDue(schedule: GenerationSchedule, now = new Date()): boolean {
  if (!schedule.enabled) return false;
  const lastRunAt = (schedule as any).last_submitted_at || schedule.created_at;
  const lastRun = lastRunAt ? new Date(lastRunAt) : null;

  if (schedule.trigger.type === 'interval') {
    const intervalMs = Number(schedule.trigger.interval_ms || 0);
    if (!intervalMs) return false;
    if (!lastRun) return true;
    return now.getTime() - lastRun.getTime() >= intervalMs;
  }

  if (schedule.trigger.type === 'cron') {
    const fields = String(schedule.trigger.cron || '').trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    const nowParts = getZonedDateParts(now, schedule.trigger.timezone);
    const matches =
      matchCronField(minute, nowParts.minute) &&
      matchCronField(hour, nowParts.hour) &&
      matchCronField(dayOfMonth, nowParts.day) &&
      matchCronField(month, nowParts.month) &&
      matchCronField(dayOfWeek, nowParts.weekday);
    if (!matches) return false;
    if (!lastRun) return true;
    const lastRunParts = getZonedDateParts(lastRun, schedule.trigger.timezone);
    return (
      lastRunParts.year !== nowParts.year ||
      lastRunParts.month !== nowParts.month ||
      lastRunParts.day !== nowParts.day ||
      lastRunParts.hour !== nowParts.hour ||
      lastRunParts.minute !== nowParts.minute
    );
  }

  return false;
}

export function markGenerationScheduleSubmitted(
  schedule: GenerationSchedule,
  jobId: string,
  submittedAt = nowIso(),
): GenerationSchedule {
  return writeGenerationSchedule({
    ...schedule,
    last_job_id: jobId,
    last_job_status: 'submitted',
    last_submitted_at: submittedAt,
    updated_at: submittedAt,
  });
}

export function markGenerationScheduleReconciled(
  schedule: GenerationSchedule,
  updates: Record<string, unknown>,
  updatedAt = nowIso(),
): GenerationSchedule {
  return writeGenerationSchedule({
    ...schedule,
    ...updates,
    updated_at: updatedAt,
  });
}
