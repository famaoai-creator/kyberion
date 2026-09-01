/**
 * Feedback Loop
 * Automatically connects execution results back into the knowledge and scheduling systems.
 * Implements the closed-loop between Phase 4 (Execution) and Phase 5 (Review/Distillation).
 */
import { logger } from '../core.js';
import { readJson } from '../foundation/json.js';
import { safeWriteFile, safeExistsSync, safeMkdir } from '../secure-io.js';
import * as path from 'path';
import { pathResolver } from '../path-resolver.js';

// Import types
import type { Trace, TraceSpan } from './trace.js';
import type { KnowledgeHint } from './knowledge-index.js';
import { loadScheduleRegistry, saveScheduleRegistry } from './pipeline-scheduler.js';
import type { PipelineScheduleRegistry, PipelineSchedulerOptions } from './pipeline-scheduler.js';
import { sendOpsAlert } from '../ops-alert.js';
import type { OpsAlertInput, OpsAlertOptions, OpsAlertReceipt } from '../ops-alert.js';

const FEEDBACK_HINTS_DIR = pathResolver.shared('runtime/feedback-loop/hints');

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

function sanitizeCategory(category: string): string {
  const normalized = String(category || 'auto-learned')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'auto-learned';
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
 * Persist extracted hints to the knowledge layer.
 * Appends to existing hint files or creates new ones.
 */
export function persistHints(hints: KnowledgeHint[], category: string = 'auto-learned'): void {
  if (hints.length === 0) return;

  const hintsDir = FEEDBACK_HINTS_DIR;
  if (!safeExistsSync(hintsDir)) safeMkdir(hintsDir, { recursive: true });

  const filePath = path.join(hintsDir, `${sanitizeCategory(category)}.json`);
  let existing: KnowledgeHint[] = [];

  if (safeExistsSync(filePath)) {
    try {
      existing = readJson<KnowledgeHint[]>(filePath);
    } catch {
      /* start fresh */
    }
  }

  // Deduplicate by topic
  const topicSet = new Set(existing.map((h) => h.topic));
  const newHints = hints.filter((h) => !topicSet.has(h.topic));

  if (newHints.length === 0) return;

  // Keep max 100 auto-generated hints (rotate oldest)
  const combined = [...existing, ...newHints].slice(-100);
  safeWriteFile(filePath, JSON.stringify(combined, null, 2));
  logger.info(
    `[FEEDBACK] Persisted ${newHints.length} new hints to ${category}.json (total: ${combined.length})`
  );
}

/**
 * LC-03: read back a persisted hint category (e.g. 'adf-repair') so repair /
 * planning prompts can inject lessons from earlier same-class failures.
 */
export function readHintsByCategory(category: string): KnowledgeHint[] {
  const filePath = path.join(FEEDBACK_HINTS_DIR, `${sanitizeCategory(category)}.json`);
  if (!safeExistsSync(filePath)) return [];
  try {
    const parsed = readJson<unknown>(filePath);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Check scheduled pipeline health and auto-disable on repeated failures.
 */
export function checkScheduleHealth(
  scheduleId: string,
  maxConsecutiveFailures: number = 3,
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

    if (failCount >= maxConsecutiveFailures) {
      // Auto-disable
      schedule.enabled = false;
      schedule.disabledReason = `Auto-disabled after ${failCount} consecutive failures`;
      schedule.disabledAt = new Date().toISOString();
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
  const emit = options.emitAlert ?? sendOpsAlert;
  const alert = emit(
    {
      severity: 'warning',
      category: 'scheduler',
      title: `${failed.length} scheduled pipeline(s) in failed state`,
      context: { failed_schedules: failed },
      recommendation:
        'Inspect the failing pipelines (lastStatus/consecutiveFailures above), fix the root cause, and re-enable any auto-disabled schedule in active/shared/runtime/pipeline-schedules.json.',
      options: [
        'pnpm ops:alerts  # triage the alert backlog',
        'node dist/scripts/run_pipeline.js --input <pipelinePath>  # reproduce one failing run',
      ],
      dedupe_key: 'scheduler:failed-schedule-sweep',
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

    schedule.lastRun = new Date().toISOString();
    schedule.lastStatus = status;

    if (status === 'failed') {
      schedule.consecutiveFailures = (schedule.consecutiveFailures || 0) + 1;
    } else {
      schedule.consecutiveFailures = 0;
    }

    saveScheduleRegistry(registry, registryOptions);

    // Auto-extract and persist hints from trace
    if (trace) {
      const hints = extractHintsFromTrace(trace);
      if (hints.length > 0) {
        persistHints(hints, `trace-${scheduleId}`);
      }
    }

    // Check health after recording
    checkScheduleHealth(scheduleId, 3, registryOptions);
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
