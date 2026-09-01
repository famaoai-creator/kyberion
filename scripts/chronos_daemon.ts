/**
 * scripts/chronos_daemon.ts
 * Kyberion Pipeline Scheduler Daemon
 *
 * Scans pipelines/ for ADF files that declare a `schedule` field and
 * auto-registers them with the pipeline-scheduler registry. Runs a tick
 * every 60 s, executes any pipelines due now, and records lastRun/lastStatus.
 */

import * as path from 'node:path';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import { recordDaemonHeartbeat } from '@agent/core/daemon-heartbeat';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';
import { sendOpsAlert } from '@agent/core/ops-alert';
import {
  registerScheduledPipeline,
  resolveScheduledPipelinePath,
  getSchedulesDueNow,
  claimScheduledPipelineRun,
  completeScheduledPipelineRun,
} from '@agent/core/pipeline-scheduler';
import {
  enqueueChronosDelivery,
  validateChronosDeliveryTarget,
} from '@agent/core/chronos-delivery';
import { createTriggerRunner, withTriggerLeaderLease } from '@agent/core/trigger-runner';
import { withExecutionContextAsync } from '@agent/core/authority';
import type { ChronosDeliveryTarget } from '@agent/core/chronos-delivery';
import { readValidatedPipelineAdf } from './refactor/adf-input.js';
import { runSteps } from './run_pipeline.js';
import { defineScript, isDirectScript } from './lib/harness.js';

const TICK_INTERVAL_MS = 60_000;
const triggerRunner = createTriggerRunner();

// ---------------------------------------------------------------------------
// ADF scan → registry sync
// ---------------------------------------------------------------------------

function collectPipelineFiles(dir: string): string[] {
  const found: string[] = [];
  if (!safeExistsSync(dir)) return found;
  const entries = safeReaddir(dir);
  for (const name of entries) {
    const full = path.join(dir, name);
    const stat = safeLstat(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      found.push(...collectPipelineFiles(full));
    } else if (name.endsWith('.json')) {
      found.push(full);
    }
  }
  return found;
}

/** Chronos executes only repository-owned pipeline files without project trust. */
export function assertChronosPipelinePath(
  inputPath: string,
  rootDir = pathResolver.rootDir()
): void {
  const root = path.resolve(rootDir);
  const absolute = path.resolve(inputPath);
  const relative = path.relative(root, absolute).replaceAll('\\', '/');
  if (
    !relative ||
    relative.startsWith('../') ||
    path.isAbsolute(relative) ||
    !relative.startsWith('pipelines/') ||
    !relative.endsWith('.json')
  ) {
    throw new Error(
      `[CHRONOS_SCOPE] scheduled pipeline must be a repository pipeline JSON: ${relative || inputPath}`
    );
  }

  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try {
      if (safeLstat(current).isSymbolicLink()) {
        throw new Error(
          `[CHRONOS_SCOPE] scheduled pipeline cannot traverse a symbolic link: ${relative}`
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('[CHRONOS_SCOPE]')) throw error;
      throw new Error(
        `[CHRONOS_SCOPE] scheduled pipeline could not be inspected safely: ${relative}`
      );
    }
  }
}

function syncSchedulesFromAdf(): void {
  const root = pathResolver.rootDir();
  const pipelinesDir = path.join(root, 'pipelines');
  const files = collectPipelineFiles(pipelinesDir);

  let registered = 0;
  for (const fullPath of files) {
    try {
      assertChronosPipelinePath(fullPath);
      const adf = readValidatedPipelineAdf(fullPath, {
        // Chronos only registers pipeline files through its governed
        // scheduler path; make that trust decision explicit for the loader.
        trustResolved: true,
      });
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
        deliver_to: sched.deliver_to,
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

async function tickAsLeader(): Promise<void> {
  const now = new Date();
  recordDaemonHeartbeat('chronos-daemon', {
    status: 'running',
    details: { phase: 'tick' },
  });
  const due = getSchedulesDueNow(undefined, now);
  if (due.length === 0) return;

  logger.info(`[CHRONOS] ${due.length} pipeline(s) due`);

  for (const scheduled of due) {
    const minuteKey = now.toISOString().slice(0, 16);
    const receipt = await triggerRunner.run(
      {
        idempotencyKey: `cron:${scheduled.id}:${minuteKey}`,
        source: 'cron',
        createdBy: { authority_role: 'chronos_gateway', level: 40 },
        requestedAuthority: { authority_role: 'chronos_gateway', level: 40 },
        payload: {
          schedule_id: scheduled.id,
          fired_at: now.toISOString(),
          cron_runtime_context: {
            fresh_thread: true,
            persisted_between_fires: [
              'pipeline-schedules.json',
              'active/shared/runtime/trigger-deliveries.jsonl',
              'pipeline trace and run journal artifacts',
            ],
          },
        },
      },
      async ({ deliveryId }) => {
        const claimed = claimScheduledPipelineRun(scheduled.id, { now });
        if (!claimed || !claimed.runLock) {
          logger.info(`[CHRONOS] → Skipped: ${scheduled.id} (already running or no longer due)`);
          return `skipped:${scheduled.id}:${minuteKey}`;
        }

        const runToken = claimed.runLock.token;
        logger.info(`[CHRONOS] → Starting: ${scheduled.id}`);

        try {
          const resolvedPipelinePath = resolveScheduledPipelinePath(scheduled);
          assertChronosPipelinePath(resolvedPipelinePath);
          const adf = readValidatedPipelineAdf(resolvedPipelinePath, {
            trustResolved: true,
          });
          const result = await runSteps(
            adf.steps,
            {
              ...(scheduled.context ?? {}),
              ...(adf.context ?? {}),
              cron_runtime_context: {
                trigger_id: deliveryId,
                fired_at: now.toISOString(),
                fresh_thread: true,
                persisted_between_fires: [
                  'pipeline-schedules.json',
                  'active/shared/runtime/trigger-deliveries.jsonl',
                  'pipeline trace and run journal artifacts',
                ],
              },
            },
            { pipelinePath: resolvedPipelinePath, runId: deliveryId }
          );

          let deliverySucceeded = true;
          if (result.status === 'succeeded' && scheduled.deliver_to) {
            try {
              const messageId = enqueueChronosDelivery({
                scheduleId: scheduled.id,
                pipelineName: scheduled.name,
                runId: deliveryId,
                status: result.status,
                context: result.context,
                target: validateChronosDeliveryTarget(
                  scheduled.deliver_to as ChronosDeliveryTarget
                ),
              });
              logger.info(`[CHRONOS] ✓ ${scheduled.id}: direct delivery queued (${messageId})`);
            } catch (deliveryError: any) {
              deliverySucceeded = false;
              logger.error(
                `[CHRONOS] ✗ ${scheduled.id}: direct delivery failed: ${deliveryError.message}`
              );
              sendOpsAlert({
                severity: 'warning',
                title: 'Scheduled pipeline delivery failed',
                context: {
                  daemon_id: 'chronos-daemon',
                  schedule_id: scheduled.id,
                  delivery: scheduled.deliver_to,
                  error: deliveryError?.message ?? String(deliveryError),
                },
                recommendation:
                  'Inspect the target surface outbox and schedule deliver_to contract.',
                dedupe_key: `chronos:${scheduled.id}:delivery-failed`,
              });
            }
          }

          completeScheduledPipelineRun(
            scheduled.id,
            runToken,
            result.status === 'succeeded' && deliverySucceeded ? 'succeeded' : 'failed',
            { now }
          );
          logger.info(`[CHRONOS] ✓ ${scheduled.id}: ${result.status}`);
          return `cron-run:${runToken}`;
        } catch (err: any) {
          completeScheduledPipelineRun(scheduled.id, runToken, 'failed', { now });
          logger.error(`[CHRONOS] ✗ ${scheduled.id}: ${err.message}`);
          sendOpsAlert({
            severity: 'warning',
            title: 'Scheduled pipeline failed',
            context: {
              daemon_id: 'chronos-daemon',
              schedule_id: scheduled.id,
              pipeline_path: scheduled.pipelinePath,
              error: err?.message ?? String(err),
            },
            recommendation: 'Inspect the pipeline trace and rerun the failed scheduled pipeline.',
            dedupe_key: `chronos:${scheduled.id}:failed`,
          });
          throw err;
        }
      }
    );
    if (receipt.status === 'failed' || receipt.status === 'rejected') {
      logger.warn(
        `[CHRONOS] Trigger ${scheduled.id} ${receipt.status}: ${receipt.reason || 'unknown'}`
      );
    }
  }
}

async function tick(): Promise<void> {
  const result = await withTriggerLeaderLease('chronos-daemon', () =>
    withExecutionContextAsync('chronos_gateway', tickAsLeader)
  );
  if (result === undefined) {
    logger.info('[CHRONOS] Another scheduler leader owns this tick; skipping.');
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(_args: string[] = []): Promise<void> {
  logger.info('[CHRONOS] Kyberion Pipeline Scheduler starting...');
  recordDaemonHeartbeat('chronos-daemon', {
    status: 'starting',
    details: { tick_interval_ms: TICK_INTERVAL_MS },
  });

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

  recordDaemonHeartbeat('chronos-daemon', {
    status: 'running',
    details: { tick_interval_ms: TICK_INTERVAL_MS },
  });
  logger.info(`[CHRONOS] Running. Tick interval: ${TICK_INTERVAL_MS / 1000}s`);
}

const runChronosDaemon = defineScript({
  name: 'chronos:daemon',
  flags: [],
  run: async ({ argv }) => {
    try {
      await main(argv);
    } catch (err: any) {
      logger.error(`[CHRONOS] Fatal: ${err.message}`);
      recordDaemonHeartbeat('chronos-daemon', {
        status: 'error',
        details: { error: err?.message ?? String(err) },
      });
      sendOpsAlert({
        severity: 'critical',
        title: 'Chronos daemon fatal error',
        context: { daemon_id: 'chronos-daemon', error: err?.message ?? String(err) },
        recommendation:
          'Restart chronos and inspect active/shared/logs/traces for the last failure.',
        dedupe_key: 'chronos-daemon:fatal',
      });
      process.exitCode = 1;
    }
  },
});

if (
  isDirectScript(import.meta.url, 'chronos_daemon.ts') ||
  isDirectScript(import.meta.url, 'chronos_daemon.js')
) {
  void runChronosDaemon();
}
