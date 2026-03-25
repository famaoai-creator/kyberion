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
}

export interface PipelineScheduleRegistry {
  version: string;
  schedules: ScheduledPipeline[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REGISTRY_PATH = 'active/shared/runtime/pipeline-schedules.json';

// ---------------------------------------------------------------------------
// Registry CRUD
// ---------------------------------------------------------------------------

function ensureRegistryDir(): void {
  const dir = path.dirname(REGISTRY_PATH);
  if (!safeExistsSync(dir)) {
    // Use dynamic import-free approach: write will create intermediates via secure-io
    // The registry file write itself handles existence
  }
}

export function loadScheduleRegistry(): PipelineScheduleRegistry {
  if (!safeExistsSync(REGISTRY_PATH)) {
    return { version: '1.0', schedules: [] };
  }
  try {
    const raw = safeReadFile(REGISTRY_PATH, { encoding: 'utf8' }) as string;
    return JSON.parse(raw) as PipelineScheduleRegistry;
  } catch (err) {
    logger.warn(`[PIPELINE-SCHEDULER] Failed to load registry, returning empty: ${err}`);
    return { version: '1.0', schedules: [] };
  }
}

export function saveScheduleRegistry(registry: PipelineScheduleRegistry): void {
  safeWriteFile(REGISTRY_PATH, JSON.stringify(registry, null, 2));
  logger.info(`[PIPELINE-SCHEDULER] Registry saved with ${registry.schedules.length} schedule(s)`);
}

export function registerScheduledPipeline(pipeline: ScheduledPipeline): void {
  const registry = loadScheduleRegistry();
  const existingIndex = registry.schedules.findIndex((s) => s.id === pipeline.id);
  if (existingIndex >= 0) {
    registry.schedules[existingIndex] = pipeline;
    logger.info(`[PIPELINE-SCHEDULER] Updated schedule: ${pipeline.id}`);
  } else {
    registry.schedules.push(pipeline);
    logger.info(`[PIPELINE-SCHEDULER] Registered new schedule: ${pipeline.id}`);
  }
  saveScheduleRegistry(registry);
}

export function unregisterScheduledPipeline(id: string): void {
  const registry = loadScheduleRegistry();
  const before = registry.schedules.length;
  registry.schedules = registry.schedules.filter((s) => s.id !== id);
  if (registry.schedules.length < before) {
    saveScheduleRegistry(registry);
    logger.info(`[PIPELINE-SCHEDULER] Unregistered schedule: ${id}`);
  } else {
    logger.warn(`[PIPELINE-SCHEDULER] Schedule not found for unregister: ${id}`);
  }
}

export function listScheduledPipelines(): ScheduledPipeline[] {
  return loadScheduleRegistry().schedules;
}

/**
 * Returns all pipelines whose trigger matches the current time.
 * For cron triggers, matches the cron expression against `now`.
 * For interval triggers, checks elapsed time since lastRun.
 */
export function getSchedulesDueNow(timezone?: string, now = new Date()): ScheduledPipeline[] {
  const registry = loadScheduleRegistry();
  return registry.schedules.filter((schedule) => {
    if (!schedule.enabled) return false;

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
      if (!matchesCron(cron, now, tz)) return false;
      // Avoid re-triggering within the same minute
      if (schedule.lastRun) {
        const lastRunParts = getZonedDateParts(new Date(schedule.lastRun), tz);
        const nowParts = getZonedDateParts(now, tz);
        if (
          lastRunParts.year === nowParts.year &&
          lastRunParts.month === nowParts.month &&
          lastRunParts.day === nowParts.day &&
          lastRunParts.hour === nowParts.hour &&
          lastRunParts.minute === nowParts.minute
        ) {
          return false;
        }
      }
      return true;
    }

    return false;
  });
}
