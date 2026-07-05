import { randomUUID } from 'node:crypto';
import { safeReadFile, safeWriteFile, safeExistsSync } from '../secure-io.js';
import { logger } from '../core.js';
import { matchesCron, getZonedDateParts } from './cron-utils.js';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduledPipeline {
  id: string;
  name: string;
  pipelinePath: string;        // path to pipeline ADF JSON
  actuator: string;            // 'browser' | 'media' | 'system' | etc
  trigger: {
    type: 'cron' | 'interval';
    cron?: string;             // 5-field cron expression
    intervalMs?: number;
    timezone?: string;
  };
  enabled: boolean;
  lastRun?: string;
  lastStatus?: 'succeeded' | 'failed';
  context?: Record<string, any>;  // additional context to inject
  runLock?: ScheduledPipelineRunLock;
}

export interface ScheduledPipelineRunLock {
  token: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface PipelineScheduleRegistry {
  version: string;
  schedules: ScheduledPipeline[];
}

export interface PipelineSchedulerOptions {
  rootDir?: string;
  now?: Date;
  runLockTtlMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REGISTRY_PATH = 'active/shared/runtime/pipeline-schedules.json';
const DEFAULT_RUN_LOCK_TTL_MS = 15 * 60 * 1000;

function registryPath(options: PipelineSchedulerOptions = {}): string {
  return options.rootDir
    ? path.join(options.rootDir, 'active/shared/runtime/pipeline-schedules.json')
    : REGISTRY_PATH;
}

function nowValue(options: PipelineSchedulerOptions = {}): Date {
  return options.now ?? new Date();
}

function runLockTtlMs(options: PipelineSchedulerOptions = {}): number {
  return options.runLockTtlMs ?? DEFAULT_RUN_LOCK_TTL_MS;
}

function runLockActive(
  lock: ScheduledPipelineRunLock | undefined,
  now: Date,
  ttlMs: number
): boolean {
  if (!lock) return false;
  const acquiredAt = new Date(lock.acquiredAt).getTime();
  const expiresAt = new Date(lock.expiresAt).getTime();
  if (!Number.isFinite(acquiredAt) || !Number.isFinite(expiresAt)) return false;
  return expiresAt > now.getTime() && now.getTime() - acquiredAt < ttlMs;
}

function sameZonedMinute(a: Date, b: Date, timezone?: string): boolean {
  const aParts = getZonedDateParts(a, timezone);
  const bParts = getZonedDateParts(b, timezone);
  return (
    aParts.year === bParts.year &&
    aParts.month === bParts.month &&
    aParts.day === bParts.day &&
    aParts.hour === bParts.hour &&
    aParts.minute === bParts.minute
  );
}

function hasMissedCronOccurrence(
  cron: string,
  lastRun: Date,
  now: Date,
  timezone?: string
): boolean {
  const cursor = new Date(now.getTime());
  cursor.setSeconds(0, 0);
  const floor = lastRun.getTime();
  while (cursor.getTime() > floor) {
    if (matchesCron(cron, cursor, timezone)) return true;
    cursor.setMinutes(cursor.getMinutes() - 1);
  }
  return false;
}

export function isScheduledPipelineDue(
  schedule: ScheduledPipeline,
  timezone?: string,
  now = new Date(),
  options: PipelineSchedulerOptions = {}
): boolean {
  if (!schedule.enabled) return false;
  if (runLockActive(schedule.runLock, now, runLockTtlMs(options))) return false;

  if (schedule.trigger.type === 'interval') {
    const intervalMs = Number(schedule.trigger.intervalMs || 0);
    if (!intervalMs) return false;
    if (!schedule.lastRun) return true;
    const lastRunDate = new Date(schedule.lastRun);
    return now.getTime() - lastRunDate.getTime() >= intervalMs;
  }

  if (schedule.trigger.type === 'cron') {
    const cron = schedule.trigger.cron;
    if (!cron) return false;
    const tz = timezone || schedule.trigger.timezone;
    if (matchesCron(cron, now, tz)) {
      if (!schedule.lastRun) return true;
      return !sameZonedMinute(new Date(schedule.lastRun), now, tz);
    }
    if (!schedule.lastRun) return false;
    return hasMissedCronOccurrence(cron, new Date(schedule.lastRun), now, tz);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Registry CRUD
// ---------------------------------------------------------------------------

function ensureRegistryDir(options: PipelineSchedulerOptions = {}): void {
  const dir = path.dirname(registryPath(options));
  if (!safeExistsSync(dir)) {
    // Use dynamic import-free approach: write will create intermediates via secure-io
    // The registry file write itself handles existence
  }
}

export function loadScheduleRegistry(
  options: PipelineSchedulerOptions = {}
): PipelineScheduleRegistry {
  const filePath = registryPath(options);
  if (!safeExistsSync(filePath)) {
    return { version: '1.0', schedules: [] };
  }
  try {
    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    return JSON.parse(raw) as PipelineScheduleRegistry;
  } catch (err) {
    logger.warn(`[PIPELINE-SCHEDULER] Failed to load registry, returning empty: ${err}`);
    return { version: '1.0', schedules: [] };
  }
}

export function saveScheduleRegistry(
  registry: PipelineScheduleRegistry,
  options: PipelineSchedulerOptions = {}
): void {
  ensureRegistryDir(options);
  safeWriteFile(registryPath(options), JSON.stringify(registry, null, 2));
  logger.info(`[PIPELINE-SCHEDULER] Registry saved with ${registry.schedules.length} schedule(s)`);
}

export function registerScheduledPipeline(
  pipeline: ScheduledPipeline,
  options: PipelineSchedulerOptions = {}
): void {
  const registry = loadScheduleRegistry(options);
  const existingIndex = registry.schedules.findIndex((s) => s.id === pipeline.id);
  if (existingIndex >= 0) {
    const existing = registry.schedules[existingIndex];
    registry.schedules[existingIndex] = {
      ...existing,
      ...pipeline,
      lastRun: pipeline.lastRun ?? existing.lastRun,
      lastStatus: pipeline.lastStatus ?? existing.lastStatus,
      runLock: pipeline.runLock ?? existing.runLock,
    };
    logger.info(`[PIPELINE-SCHEDULER] Updated schedule: ${pipeline.id}`);
  } else {
    registry.schedules.push(pipeline);
    logger.info(`[PIPELINE-SCHEDULER] Registered new schedule: ${pipeline.id}`);
  }
  saveScheduleRegistry(registry, options);
}

export function unregisterScheduledPipeline(id: string, options: PipelineSchedulerOptions = {}): void {
  const registry = loadScheduleRegistry(options);
  const before = registry.schedules.length;
  registry.schedules = registry.schedules.filter((s) => s.id !== id);
  if (registry.schedules.length < before) {
    saveScheduleRegistry(registry, options);
    logger.info(`[PIPELINE-SCHEDULER] Unregistered schedule: ${id}`);
  } else {
    logger.warn(`[PIPELINE-SCHEDULER] Schedule not found for unregister: ${id}`);
  }
}

export function listScheduledPipelines(options: PipelineSchedulerOptions = {}): ScheduledPipeline[] {
  return loadScheduleRegistry(options).schedules;
}

/**
 * Returns all pipelines whose trigger matches the current time.
 * For cron triggers, matches the cron expression against `now`.
 * For interval triggers, checks elapsed time since lastRun.
 */
export function getSchedulesDueNow(
  timezone?: string,
  now = new Date(),
  options: PipelineSchedulerOptions = {}
): ScheduledPipeline[] {
  const registry = loadScheduleRegistry(options);
  return registry.schedules.filter((schedule) =>
    isScheduledPipelineDue(schedule, timezone, now, options)
  );
}

export function claimScheduledPipelineRun(
  id: string,
  options: PipelineSchedulerOptions = {}
): ScheduledPipeline | null {
  const now = nowValue(options);
  const ttlMs = runLockTtlMs(options);
  const registry = loadScheduleRegistry(options);
  const schedule = registry.schedules.find((entry) => entry.id === id);
  if (!schedule || !isScheduledPipelineDue(schedule, schedule.trigger.timezone, now, options))
    return null;
  if (runLockActive(schedule.runLock, now, ttlMs)) return null;

  const token = randomUUID();
  schedule.runLock = {
    token,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  schedule.lastRun = now.toISOString();
  saveScheduleRegistry(registry, options);
  return schedule;
}

export function completeScheduledPipelineRun(
  id: string,
  token: string,
  status: 'succeeded' | 'failed',
  options: PipelineSchedulerOptions = {}
): ScheduledPipeline | null {
  const registry = loadScheduleRegistry(options);
  const schedule = registry.schedules.find((entry) => entry.id === id);
  if (!schedule || schedule.runLock?.token !== token) return null;
  delete schedule.runLock;
  schedule.lastStatus = status;
  saveScheduleRegistry(registry, options);
  return schedule;
}
