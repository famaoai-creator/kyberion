/**
 * Per-(step, dot) circuit breaker for supervisor steps that iterate active
 * charters. A repeated identical failure is almost always deterministic
 * (policy deny, missing grant, bad config) — retrying it every sweep produces
 * warning storms, not progress. After {@link OPEN_THRESHOLD} consecutive
 * failures with the same signature the step holds that dot for a cooldown,
 * emitting one ops alert per opening instead of one warn per sweep; a
 * half-open run at cooldown end either closes the circuit (success) or
 * re-opens it with exponential backoff.
 *
 * State is in-memory on purpose: a supervisor restart resets the streak, so a
 * real fix takes effect on the next sweep without a manual reset, and the
 * worst-case cost of a restart is one re-alert cycle.
 */

import { createLogger } from '../logger.js';
import { sendOpsAlert } from '../daemon/ops-alert.js';
import type { DotCharter } from './dot-charter.js';

const logger = createLogger('dot-step-circuit');

export const DOT_STEP_CIRCUIT_OPEN_THRESHOLD = 3;
export const DOT_STEP_CIRCUIT_BASE_COOLDOWN_MS = 30 * 60_000;
export const DOT_STEP_CIRCUIT_MAX_COOLDOWN_MS = 6 * 3_600_000;

interface StepCircuitEntry {
  /** Consecutive failures sharing {@link signature}. */
  streak: number;
  /** Normalized first line of the last failure message. */
  signature: string;
  /** Epoch ms until which the dot is held (half-open probe allowed after). */
  openUntil: number;
}

export type DotStepFailureVerdict = 'counted' | 'open' | 'held';

function failureSignature(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Normalize volatile payloads (pids, epochs, uuids, long hex) so the same
  // underlying defect streaks — "lock held by pid 1073" and "pid 2084" are
  // one failure, not two distinct ones that never reach the threshold.
  return message
    .split('\n')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .slice(0, 200);
}

export class DotSupervisorStepCircuit {
  private readonly entries = new Map<string, StepCircuitEntry>();

  constructor(
    private readonly stepId: string,
    private readonly options: {
      threshold?: number;
      baseCooldownMs?: number;
      maxCooldownMs?: number;
    } = {}
  ) {}

  /** true when the dot may run this step this sweep (closed or half-open). */
  admits(dotId: string, now = Date.now()): boolean {
    const entry = this.entries.get(dotId);
    return !entry || entry.openUntil <= now;
  }

  reportSuccess(dotId: string): void {
    this.entries.delete(dotId);
  }

  /**
   * Records a failure.
   * - `counted`: streak grew below the open threshold — caller logs as usual.
   * - `open`: the breaker (re-)opened — caller emits ONE alert. A half-open
   *   probe that fails re-opens, so a persistent defect re-surfaces once per
   *   cooldown instead of vanishing forever after the first alert.
   * - `held`: a failure was reported while still inside the hold window —
   *   defensive only, since callers gate execution with {@link admits}.
   */
  reportFailure(dotId: string, error: unknown, now = Date.now()): DotStepFailureVerdict {
    const signature = failureSignature(error);
    const entry = this.entries.get(dotId);
    const streak = entry && entry.signature === signature ? entry.streak + 1 : 1;
    const threshold = this.options.threshold ?? DOT_STEP_CIRCUIT_OPEN_THRESHOLD;
    if (streak < threshold) {
      this.entries.set(dotId, { streak, signature, openUntil: 0 });
      return 'counted';
    }
    const wasOpen = !!entry && entry.openUntil > now;
    const base = this.options.baseCooldownMs ?? DOT_STEP_CIRCUIT_BASE_COOLDOWN_MS;
    const cap = this.options.maxCooldownMs ?? DOT_STEP_CIRCUIT_MAX_COOLDOWN_MS;
    const cooldown = Math.min(base * 2 ** (streak - threshold), cap);
    this.entries.set(dotId, { streak, signature, openUntil: now + cooldown });
    return wasOpen ? 'held' : 'open';
  }

  signatureOf(dotId: string): string | undefined {
    return this.entries.get(dotId)?.signature;
  }

  streakOf(dotId: string): number {
    return this.entries.get(dotId)?.streak ?? 0;
  }
}

/**
 * Report a freshly opened step circuit: one ops alert (deduped by
 * step/dot/signature) plus one warn line. Failure prose stays out of the
 * shared log for non-public dots, matching the wake-circuit alert rule.
 */
export function alertDotStepCircuitOpen(
  stepId: string,
  charter: DotCharter,
  signature: string,
  streak: number
): void {
  const isPublic = charter.scope.tier === 'public' && !charter.scope.tenant_slug;
  try {
    sendOpsAlert({
      severity: 'warning',
      title: `Supervisor step held for ${charter.dot_id}: ${stepId}`,
      context: {
        dot_id: charter.dot_id,
        step: stepId,
        consecutive_failures: streak,
        ...(isPublic ? { reason: signature } : {}),
      },
      recommendation: `Step '${stepId}' keeps failing the same way for ${charter.dot_id} and is quiesced with backoff. Fix the cause; a half-open run each cooldown closes the circuit automatically.`,
      dedupe_key: `dot-step-circuit:${stepId}:${charter.dot_id}:${signature}`,
      category: 'dot',
    });
  } catch (error) {
    logger.warn(
      `step circuit alert failed for ${charter.dot_id} — ${error instanceof Error ? error.message : error} | next: the step stays held regardless | evidence: libs/core/dot/dot-step-circuit.ts`
    );
  }
  logger.warn(
    `step circuit open for ${charter.dot_id} in '${stepId}' — ${streak} consecutive identical failures | next: fix the cause; a half-open run retries after the cooldown | evidence: libs/core/dot/dot-step-circuit.ts`
  );
}
