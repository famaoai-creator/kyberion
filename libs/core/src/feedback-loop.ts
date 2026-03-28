/**
 * Feedback Loop
 * Automatically connects execution results back into the knowledge and scheduling systems.
 * Implements the closed-loop between Phase 4 (Execution) and Phase 5 (Review/Distillation).
 */
import { logger } from '../core.js';
import { safeWriteFile, safeReadFile, safeExistsSync, safeMkdir } from '../secure-io.js';
import * as path from 'path';
import { pathResolver } from '../path-resolver.js';

// Import types
import type { Trace, TraceSpan } from './trace.js';
import type { KnowledgeHint } from './knowledge-index.js';

const FEEDBACK_HINTS_DIR = pathResolver.shared('runtime/feedback-loop/hints');
const PIPELINE_SCHEDULE_REGISTRY_PATH = pathResolver.shared('runtime/pipeline-schedules.json');

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

    // Extract successful patterns with artifacts (useful for future reference)
    if (span.status === 'ok' && span.artifacts.length > 0) {
      for (const artifact of span.artifacts) {
        hints.push({
          topic: `artifact ${sanitizeSpanName(span.name)}`,
          hint: `Step "${sanitizeSpanName(span.name)}" produced a ${artifact.type} artifact. Review trace ${trace.traceId} for the governed artifact reference.`,
          source: `trace/${trace.traceId}`,
          confidence: 0.5,
          tags: ['auto-generated', 'artifact', artifact.type],
        });
      }
    }

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

  const filePath = path.join(hintsDir, `${category}.json`);
  let existing: KnowledgeHint[] = [];

  if (safeExistsSync(filePath)) {
    try {
      const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      existing = JSON.parse(raw);
    } catch { /* start fresh */ }
  }

  // Deduplicate by topic
  const topicSet = new Set(existing.map(h => h.topic));
  const newHints = hints.filter(h => !topicSet.has(h.topic));

  if (newHints.length === 0) return;

  // Keep max 100 auto-generated hints (rotate oldest)
  const combined = [...existing, ...newHints].slice(-100);
  safeWriteFile(filePath, JSON.stringify(combined, null, 2));
  logger.info(`[FEEDBACK] Persisted ${newHints.length} new hints to ${category}.json (total: ${combined.length})`);
}

/**
 * Check scheduled pipeline health and auto-disable on repeated failures.
 */
export function checkScheduleHealth(scheduleId: string, maxConsecutiveFailures: number = 3): {
  healthy: boolean;
  action?: 'disabled' | 'warning';
  message?: string;
} {
  const registryPath = PIPELINE_SCHEDULE_REGISTRY_PATH;
  if (!safeExistsSync(registryPath)) return { healthy: true };

  try {
    const raw = safeReadFile(registryPath, { encoding: 'utf8' }) as string;
    const registry = JSON.parse(raw);
    const schedule = (registry.schedules || []).find((s: any) => s.id === scheduleId);

    if (!schedule) return { healthy: true };

    const failCount = schedule.consecutiveFailures || 0;

    if (failCount >= maxConsecutiveFailures) {
      // Auto-disable
      schedule.enabled = false;
      schedule.disabledReason = `Auto-disabled after ${failCount} consecutive failures`;
      schedule.disabledAt = new Date().toISOString();
      safeWriteFile(registryPath, JSON.stringify(registry, null, 2));
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
 * Record a pipeline execution result and update schedule tracking.
 */
export function recordPipelineResult(
  scheduleId: string,
  status: 'succeeded' | 'failed',
  trace?: Trace
): void {
  const registryPath = PIPELINE_SCHEDULE_REGISTRY_PATH;
  if (!safeExistsSync(registryPath)) return;

  try {
    const raw = safeReadFile(registryPath, { encoding: 'utf8' }) as string;
    const registry = JSON.parse(raw);
    const schedule = (registry.schedules || []).find((s: any) => s.id === scheduleId);

    if (!schedule) return;

    schedule.lastRun = new Date().toISOString();
    schedule.lastStatus = status;

    if (status === 'failed') {
      schedule.consecutiveFailures = (schedule.consecutiveFailures || 0) + 1;
    } else {
      schedule.consecutiveFailures = 0;
    }

    safeWriteFile(registryPath, JSON.stringify(registry, null, 2));

    // Auto-extract and persist hints from trace
    if (trace) {
      const hints = extractHintsFromTrace(trace);
      if (hints.length > 0) {
        persistHints(hints, `trace-${scheduleId}`);
      }
    }

    // Check health after recording
    checkScheduleHealth(scheduleId);
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
  trace?: Trace
): void {
  // 1. Record result in schedule registry
  if (scheduleId) {
    recordPipelineResult(scheduleId, status, trace);
  }

  // 2. Extract and persist hints from trace (even for non-scheduled pipelines)
  if (trace) {
    const hints = extractHintsFromTrace(trace);
    if (hints.length > 0) {
      persistHints(hints, 'auto-learned');
    }
  }
}
