import * as path from 'node:path';
import { safeExistsSync, safeMkdir, safeReadFile, safeReaddir, safeWriteFile } from './secure-io.js';
import type { GenerationSchedule } from './src/types/generation-schedule.js';
import { matchesCron, getZonedDateParts } from './src/cron-utils.js';

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
    const cronExpr = String(schedule.trigger.cron || '');
    if (!matchesCron(cronExpr, now, schedule.trigger.timezone)) return false;
    if (!lastRun) return true;
    // Avoid re-triggering within the same minute
    const lastRunParts = getZonedDateParts(lastRun, schedule.trigger.timezone);
    const nowParts = getZonedDateParts(now, schedule.trigger.timezone);
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
