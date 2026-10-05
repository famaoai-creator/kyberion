import type { DotCharter } from '@agent/core/dot/dot-charter';
import { notifyOperatorSync } from '@agent/core/surface/operator-notifications';

/**
 * A dot stopped by a budget (its own daily token cap, or the org's hard limit)
 * used to say so only in a debug heartbeat, so the operator found out by
 * noticing the silence. This tells them once per dot, reason and day.
 */

export type DotBudgetStopReason = 'token-cap' | 'budget-hard';

const REASON_TEXT: Record<DotBudgetStopReason, string> = {
  'token-cap': "reached its charter's daily token cap",
  'budget-hard': "is in a scope that reached the org's hard budget limit",
};

const notified = new Set<string>();

export function notifyDotBudgetStopOnce(
  charter: Pick<DotCharter, 'dot_id'>,
  reason: DotBudgetStopReason,
  now: Date,
  notify: typeof notifyOperatorSync = notifyOperatorSync
): boolean {
  const key = `${charter.dot_id}:${reason}:${now.toISOString().slice(0, 10)}`;
  if (notified.has(key)) return false;
  notified.add(key);
  notify('ops_alert', {
    title: `Dot ${charter.dot_id} paused by budget`,
    body: `${charter.dot_id} ${REASON_TEXT[reason]}, so it will not wake again until the budget resets or is raised. Housekeeping continues.`,
    correlation_id: `dot-budget-stop:${key}`,
  });
  return true;
}

/** Test seam: forget what was already announced. */
export function resetDotBudgetAlerts(): void {
  notified.clear();
}
