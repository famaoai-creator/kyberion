import {
  recordSchedulerIncident,
  listSchedulerIncidents,
  schedulerIncidentLogForRoot,
  schedulerIncidentSweepKey,
} from '../daemon/scheduler-incidents.js';
/**
 * Feedback Loop
 * Automatically connects execution results back into the knowledge and scheduling systems.
 * Implements the closed-loop between Phase 4 (Execution) and Phase 5 (Review/Distillation).
 */
import { logger } from '../core.js';
import { createFailureTracker } from '../foundation/failure-tracker.js';
import { loadRuntimeControlPolicy } from '../governance/runtime-control-policy.js';
import { nowIso } from '../foundation/time.js';
import {
  loadHintFileAtPath,
  persistScopedHints,
  readLegacyHints,
  readScopedHints,
  sanitizeHintCategory,
} from './hint-store.js';

// Import types
import type { Trace, TraceSpan } from '../analysis/trace.js';
import type { KnowledgeHint } from './knowledge-index.js';
import { loadScheduleRegistry, saveScheduleRegistry } from '../pipeline/pipeline-scheduler.js';
import type {
  PipelineScheduleRegistry,
  PipelineSchedulerOptions,
} from '../pipeline/pipeline-scheduler.js';
import { sendOpsAlert } from '../daemon/ops-alert.js';
import type { OpsAlertInput, OpsAlertOptions, OpsAlertReceipt } from '../daemon/ops-alert.js';

function sanitizeSpanName(name: string): string {
  return name.replace(/[^\w:-]+/g, ' ').trim();
}

function sanitizeErrorMessage(error: string): string {
  return error
    .replace(/\/[^\s"']+/g, '[path]')
    .replace(/active\/[^\s"']+/g, '[artifact]')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract learning hints from a completed trace.
 * Analyzes error spans and successful patterns to generate knowledge hints.
 */
export function extractHintsFromTrace(trace: Trace): KnowledgeHint[] {
  const hints: KnowledgeHint[] = [];

  function walkSpan(span: TraceSpan, parentName?: string) {
    // Extract error hints
    if (span.status === 'error' && span.error) {
      hints.push({
        topic: `error ${sanitizeSpanName(span.name)}`,
        hint: `Step "${sanitizeSpanName(span.name)}" failed. ${parentName ? `Context: ${sanitizeSpanName(parentName)}.` : ''} Review trace ${trace.traceId} for details. ${sanitizeErrorMessage(span.error)}`,
        source: `trace/${trace.traceId}`,
        confidence: 0.7,
        tags: ['auto-generated', 'error', span.name.split(':')[0]],
      });
    }

    // LC-15: a successful artifact fact is not a reusable lesson by itself.
    // Do not persist the old low-signal "Step X produced a file artifact"
    // template; meaningful success hints must come from an explicit category
    // or a later quality signal rather than artifact existence alone.

    for (const child of span.children) {
      walkSpan(child, span.name);
    }
  }

  walkSpan(trace.rootSpan);
  return hints;
}

/**
 * Persist extracted hints into the D8 hint store (hint-store.ts), in the
 * capture scope's partition: the explicit scope, else the credential-bound
 * tenant of this execution, else public. Never into a shared directory for a
 * tenant's hints.
 */
export function persistHints(
  hints: KnowledgeHint[],
  category: string = 'auto-learned',
  scope?: { tier: string; tenant_slug?: string } | null
): void {
  if (hints.length === 0) return;
  const result = persistScopedHints(hints, category, scope);
  if (result.written.length === 0) return;
  logger.info(
    `[FEEDBACK] Persisted ${result.written.length} new hints to ${sanitizeHintCategory(category)}.json (total: ${result.total})`
  );
}

/**
 * LC-03: read back a persisted hint category (e.g. 'adf-repair') so repair /
 * planning prompts can inject lessons from earlier same-class failures. Reads
 * the scope's partition; an unscoped (system) reader also sees the pre-D8
 * legacy directory for one release.
 */
export function readHintsByCategory(
  category: string,
  scope?: { tier: string; tenant_slug?: string } | null
): KnowledgeHint[] {
  try {
    const scoped = readScopedHints(category, scope);
    if (scope) return scoped;
    const seen = new Set(scoped.map((hint) => hint.topic));
    return [...readLegacyHints(category).filter((hint) => !seen.has(hint.topic)), ...scoped];
  } catch {
    return [];
  }
}

/** Load one persisted hint category file through its schema and path boundary. */
export function loadFeedbackHintsAtPath(filePath: string): KnowledgeHint[] {
  return loadHintFileAtPath(filePath);
}

/**
 * Check scheduled pipeline health and auto-disable on repeated failures.
 */
export function checkScheduleHealth(
  scheduleId: string,
  maxConsecutiveFailures: number = loadRuntimeControlPolicy().schedule_failures.threshold,
  registryOptions: PipelineSchedulerOptions = {}
): {
  healthy: boolean;
  action?: 'disabled' | 'warning';
  message?: string;
} {
  try {
    const registry = loadScheduleRegistry(registryOptions);
    const schedule = registry.schedules.find((s) => s.id === scheduleId);

    if (!schedule) return { healthy: true };

    const failCount = schedule.consecutiveFailures || 0;

    if (
      createFailureTracker({
        threshold: maxConsecutiveFailures,
        reset: 'never',
        action: 'disable',
      }).decision({ count: failCount }).exceeded
    ) {
      // Auto-disable
      schedule.enabled = false;
      schedule.disabledReason = `Auto-disabled after ${failCount} consecutive failures`;
      schedule.disabledAt = nowIso();
      saveScheduleRegistry(registry, registryOptions);
      logger.warn(`[FEEDBACK] Schedule "${scheduleId}" auto-disabled after ${failCount} failures`);
      return {
        healthy: false,
        action: 'disabled',
        message: `Auto-disabled after ${failCount} consecutive failures. Last status: ${schedule.lastStatus}`,
      };
    }

    if (failCount > 0) {
      return {
        healthy: false,
        action: 'warning',
        message: `${failCount}/${maxConsecutiveFailures} consecutive failures`,
      };
    }

    return { healthy: true };
  } catch {
    return { healthy: true };
  }
}

/**
 * LC-01c: one schedule entry currently in a failed state (failed last run,
 * accumulating consecutive failures, or auto-disabled by checkScheduleHealth).
 */
export interface FailedScheduleFinding {
  id: string;
  name?: string;
  enabled: boolean;
  lastStatus?: string;
  lastRun?: string;
  consecutiveFailures: number;
  disabledReason?: string;
}

/**
 * LC-01c (pure): scan a schedule registry for schedules whose last result is
 * `failed`, whose consecutiveFailures counter is non-zero, or which were
 * auto-disabled. Read-only — never mutates the registry.
 */
export function collectFailedSchedules(
  registry: PipelineScheduleRegistry
): FailedScheduleFinding[] {
  const findings: FailedScheduleFinding[] = [];
  for (const schedule of registry.schedules ?? []) {
    const raw = schedule as unknown as Record<string, unknown>;
    const consecutiveFailures = Number(raw.consecutiveFailures ?? 0) || 0;
    const disabledReason = typeof raw.disabledReason === 'string' ? raw.disabledReason : undefined;
    const failedLastRun = schedule.lastStatus === 'failed';
    const autoDisabled = !schedule.enabled && disabledReason !== undefined;
    if (!failedLastRun && consecutiveFailures === 0 && !autoDisabled) continue;
    findings.push({
      id: schedule.id,
      ...(schedule.name ? { name: schedule.name } : {}),
      enabled: schedule.enabled,
      ...(schedule.lastStatus ? { lastStatus: schedule.lastStatus } : {}),
      ...(schedule.lastRun ? { lastRun: schedule.lastRun } : {}),
      consecutiveFailures,
      ...(disabledReason !== undefined ? { disabledReason } : {}),
    });
  }
  return findings;
}

/**
 * LC-01c: escalation sweep. checkScheduleHealth only runs from
 * recordPipelineResult — i.e. only when a schedule actually fires — so a
 * schedule stuck in `failed` (or a whole dead daemon) never escalates on its
 * own. This sweep is called from the session-start baseline check: it is a
 * read-only scan that emits ONE warn-level ops alert listing every failed
 * schedule. It never disables anything beyond what checkScheduleHealth
 * already did.
 */
export function sweepFailedSchedules(
  options: {
    registryOptions?: PipelineSchedulerOptions;
    emitAlert?: (input: OpsAlertInput, alertOptions?: OpsAlertOptions) => OpsAlertReceipt;
    alertOptions?: OpsAlertOptions;
  } = {}
): { failed: FailedScheduleFinding[]; alert: OpsAlertReceipt | null } {
  const registry = loadScheduleRegistry(options.registryOptions);
  const failed = collectFailedSchedules(registry);
  if (failed.length === 0) return { failed, alert: null };
  const incidentOptions = {
    alertLogPath:
      options.alertOptions?.alertLogPath ||
      schedulerIncidentLogForRoot(options.registryOptions?.rootDir),
    now: options.alertOptions?.now,
  };
  const incidents = listSchedulerIncidents(incidentOptions);
  const alertable = failed.filter((schedule) => {
    const latest = incidents.find((incident) => incident.scheduleId === schedule.id);
    return !latest || latest.status === 'detected';
  });
  if (alertable.length === 0) return { failed, alert: null };
  const emit = options.emitAlert ?? sendOpsAlert;
  const alert = emit(
    {
      severity: 'warning',
      category: 'scheduler',
      title: `${alertable.length} scheduled pipeline(s) in failed state`,
      context: { failed_schedules: alertable },
      recommendation:
        'Inspect the failing pipelines (lastStatus/consecutiveFailures above), fix the root cause, and re-enable any auto-disabled schedule in active/shared/runtime/pipeline-schedules.json.',
      options: [
        'pnpm ops:alerts  # triage the alert backlog',
        'node dist/scripts/run_pipeline.js --input <pipelinePath>  # reproduce one failing run',
      ],
      dedupe_key: schedulerIncidentSweepKey(
        alertable.map(
          (schedule) =>
            `${schedule.id}:${incidents.find((incident) => incident.scheduleId === schedule.id)?.signature || 'unknown'}:${incidents.find((incident) => incident.scheduleId === schedule.id)?.episodeId || 'legacy'}`
        )
      ),
    },
    options.alertOptions
  );
  return { failed, alert };
}

/**
 * Record a pipeline execution result and update schedule tracking.
 */
export function recordPipelineResult(
  scheduleId: string,
  status: 'succeeded' | 'failed',
  trace?: Trace,
  registryOptions: PipelineSchedulerOptions = {}
): void {
  try {
    const registry = loadScheduleRegistry(registryOptions);
    const schedule = registry.schedules.find((s) => s.id === scheduleId);

    if (!schedule) return;

    schedule.lastRun = nowIso();
    schedule.lastStatus = status;

    const failurePolicy = loadRuntimeControlPolicy().schedule_failures;
    schedule.consecutiveFailures = createFailureTracker({
      threshold: failurePolicy.threshold,
      reset: failurePolicy.reset,
      action: failurePolicy.action,
      resetOnSuccess: failurePolicy.reset_on_success,
    }).transition(
      { count: schedule.consecutiveFailures || 0 },
      {
        kind: status === 'failed' ? 'failure' : 'success',
        now: Date.now(),
      }
    ).count;

    saveScheduleRegistry(registry, registryOptions);
    try {
      recordSchedulerIncident(scheduleId, status, trace?.rootSpan.error, {
        alertLogPath: schedulerIncidentLogForRoot(registryOptions.rootDir),
      });
    } catch (error) {
      logger.warn(
        `[FEEDBACK] incident projection failed — schedule result retained | evidence: ${String(error)}`
      );
    }

    // Auto-extract and persist hints from trace
    if (trace) {
      const hints = extractHintsFromTrace(trace);
      if (hints.length > 0) {
        persistHints(hints, `trace-${scheduleId}`);
      }
    }

    // Check health after recording
    checkScheduleHealth(scheduleId, failurePolicy.threshold, registryOptions);
  } catch (e: any) {
    logger.error(`[FEEDBACK] Failed to record result: ${e.message}`);
  }
}

/**
 * Run the full feedback loop for a completed pipeline execution.
 * This is the main entry point called after any pipeline finishes.
 */
export function runFeedbackLoop(
  scheduleId: string | undefined,
  status: 'succeeded' | 'failed',
  trace?: Trace,
  registryOptions: PipelineSchedulerOptions = {}
): void {
  // 1. Record result in schedule registry
  if (scheduleId) {
    recordPipelineResult(scheduleId, status, trace, registryOptions);
  }

  // 2. Extract and persist hints from trace (even for non-scheduled pipelines)
  if (trace) {
    const hints = extractHintsFromTrace(trace);
    if (hints.length > 0) {
      persistHints(hints, 'auto-learned');
    }
  }
}
