/** Attempt snapshot finalization; persistence and ownership checks remain with the fenced store. */
import { nowIso } from '../foundation/time.js';
import type {
  WorkItem,
  WorkItemAttempt,
  WorkItemAttemptStatus,
} from './work-coordination-types.js';

export function finalizeWorkItemAttempt(
  current: WorkItem,
  nextStatus: Exclude<WorkItemAttemptStatus, 'running'>,
  input: {
    summary?: string;
    blockedReason?: string;
    failureReason?: string;
    traceId?: string;
    metadata?: Record<string, unknown>;
  } = {}
): { attempts: WorkItemAttempt[]; currentAttemptId?: string; attempt: WorkItemAttempt | null } {
  const attempts = [...(current.attempts || [])];
  const now = nowIso();
  const index = current.current_attempt_id
    ? attempts.findIndex((attempt) => attempt.run_id === current.current_attempt_id)
    : attempts.length - 1;
  if (index < 0) {
    return { attempts, currentAttemptId: undefined, attempt: null };
  }

  const previous = attempts[index];
  const attempt: WorkItemAttempt = {
    ...previous,
    status: nextStatus,
    ended_at: now,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.blockedReason ? { blocked_reason: input.blockedReason } : {}),
    ...(input.failureReason ? { failure_reason: input.failureReason } : {}),
    ...(input.traceId ? { trace_id: input.traceId } : {}),
    ...(input.metadata ? { metadata: { ...(previous.metadata || {}), ...input.metadata } } : {}),
  };
  attempts[index] = attempt;
  return { attempts, currentAttemptId: undefined, attempt };
}
