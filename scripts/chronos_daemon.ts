/**
 * scripts/chronos_daemon.ts
 * Kyberion Pipeline Scheduler Daemon
 *
 * Scans pipelines/ for ADF files that declare a `schedule` field and
 * auto-registers them with the pipeline-scheduler registry. Runs a tick
 * every 60 s, executes any pipelines due now, and records lastRun/lastStatus.
 */

import * as path from 'node:path';
import { logger, pathResolver, safeExistsSync, safeLstat, safeReaddir } from '@agent/core';
import {
  registerScheduledPipeline,
  getSchedulesDueNow,
  loadScheduleRegistry,
  saveScheduleRegistry,
} from '@agent/core/pipeline-scheduler';
import { readValidatedPipelineAdf } from './refactor/adf-input.js';
import { runSteps } from './run_pipeline.js';

const TICK_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// ADF scan → registry sync
// ---------------------------------------------------------------------------

function collectPipelineFiles(dir: string): string[] {
  const found: string[] = [];
  if (!safeExistsSync(dir)) return found;
  const entries = safeReaddir(dir);
  for (const name of entries) {
    const full = path.join(dir, name);
    if (safeLstat(full).isDirectory()) {
      found.push(...collectPipelineFiles(full));
    } else if (name.endsWith('.json')) {
      found.push(full);
    }
  }
  return found;
}

function syncSchedulesFromAdf(): void {
  const root = pathResolver.rootDir();
  const pipelinesDir = path.join(root, 'pipelines');
  const files = collectPipelineFiles(pipelinesDir);

  let registered = 0;
  for (const fullPath of files) {
    try {
      const adf = readValidatedPipelineAdf(fullPath);
      if (!adf.schedule?.cron) continue;

      const sched = adf.schedule;
      const id = sched.id ?? path.basename(fullPath, '.json');

      registerScheduledPipeline({
        id,
        name: adf.name ?? id,
        pipelinePath: fullPath,
        actuator: 'run_pipeline',
        trigger: {
          type: 'cron',
          cron: sched.cron,
          timezone: sched.timezone,
        },
        enabled: sched.enabled !== false,
        context: adf.context ?? {},
      });
      registered++;
    } catch (err: any) {
      logger.warn(
        `[CHRONOS] Skipped ${path.relative(pathResolver.rootDir(), fullPath)}: ${err.message}`
      );
    }
  }

  if (registered > 0) {
    logger.info(`[CHRONOS] Synced ${registered} scheduled pipeline(s) from pipelines/`);
  }
}

// ---------------------------------------------------------------------------
// Tick: find due pipelines and run them
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  const due = getSchedulesDueNow();
  if (due.length === 0) return;

  logger.info(`[CHRONOS] ${due.length} pipeline(s) due`);

  for (const scheduled of due) {
    logger.info(`[CHRONOS] → Starting: ${scheduled.id}`);

    // Stamp lastRun optimistically before execution to prevent duplicate fires
    // in case the run takes longer than a tick interval.
    const registry = loadScheduleRegistry();
    const entry = registry.schedules.find((s) => s.id === scheduled.id);
    if (entry) entry.lastRun = new Date().toISOString();
    saveScheduleRegistry(registry);

    try {
      const adf = readValidatedPipelineAdf(scheduled.pipelinePath);
      const result = await runSteps(
        adf.steps,
        { ...(scheduled.context ?? {}), ...(adf.context ?? {}) },
        { pipelinePath: scheduled.pipelinePath }
      );

      const registry2 = loadScheduleRegistry();
      const entry2 = registry2.schedules.find((s) => s.id === scheduled.id);
      if (entry2) entry2.lastStatus = result.status === 'succeeded' ? 'succeeded' : 'failed';
      saveScheduleRegistry(registry2);

      logger.info(`[CHRONOS] ✓ ${scheduled.id}: ${result.status}`);
    } catch (err: any) {
      const registry2 = loadScheduleRegistry();
      const entry2 = registry2.schedules.find((s) => s.id === scheduled.id);
      if (entry2) entry2.lastStatus = 'failed';
      saveScheduleRegistry(registry2);

      logger.error(`[CHRONOS] ✗ ${scheduled.id}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info('[CHRONOS] Kyberion Pipeline Scheduler starting...');

  syncSchedulesFromAdf();

  // First tick immediately on startup
  await tick();

  setInterval(async () => {
    try {
      syncSchedulesFromAdf(); // picks up new/changed schedule fields
      await tick();
    } catch (err: any) {
      logger.error(`[CHRONOS] Tick error: ${err.message}`);
    }
  }, TICK_INTERVAL_MS);

  logger.info(`[CHRONOS] Running. Tick interval: ${TICK_INTERVAL_MS / 1000}s`);
}

main().catch((err) => {
  logger.error(`[CHRONOS] Fatal: ${err.message}`);
  process.exit(1);
});
