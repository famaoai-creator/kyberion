/**
 * Abort measurement rules shared by every caller that tries to show a
 * provider honours an AbortSignal (live scenarios, backend conformance).
 *
 * A wrapper between the measurement and the provider can answer an abort on
 * the provider's behalf:
 * - `bindReasoningRequestTimeout` rejects the moment the caller signal fires
 *   (or at once for an already-aborted signal) with the caller's own reason,
 *   without waiting for the provider;
 * - `FailoverReasoningBackend` (and `throwIfReasoningAborted` in the retry
 *   policy) rejects an already-aborted call before any provider is invoked.
 *
 * So a measurement:
 * 1. aborts with a distinctive NON-Error reason with no abort/cancel wording
 *    (`measurementAbortReason`). Governed providers turn a non-Error reason
 *    into their own `[DELEGATION_CANCELLED] …` error; a rejection that IS
 *    that value or quotes it came from a layer that forwarded the caller's
 *    signal, never from the provider stopping (`classifyMeasuredAbortRejection`
 *    → `forwarded`), and must be reported unverified, not as a pass;
 * 2. drives an unwrapped backend. Live (mid-flight) aborts may go through the
 *    failover chain — it rethrows the provider's own rejection once the signal
 *    is aborted — but never through the request-timeout wrapper, so live
 *    entry points construct with `requestTimeout: 'caller'`. A pre-aborted
 *    probe (conformance) is always answered by a failover chain's pre-flight
 *    guard, so it must receive the provider adapter itself
 *    (`abortAnsweringWrapper` names the chain it refuses).
 */
import { FailoverReasoningBackend } from './reasoning-backend.js';
import type { ReasoningBackend } from './reasoning-backend-contracts.js';

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** A per-run abort reason: a plain string with no abort/cancel wording. */
export function measurementAbortReason(scope: string, nonce: string): string {
  return `${scope}-stop-${nonce}`;
}

/** True when the rejection is the caller's own reason, or quotes it. */
export function isForwardedAbortReason(error: unknown, reason: string): boolean {
  return error === reason || errorText(error).includes(reason);
}

/** True when the rejection reads as an abort / cancellation error. */
export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    /abort|cancel/iu.test(errorText(error))
  );
}

export type MeasuredAbortRejection = 'forwarded' | 'abort' | 'other';

/**
 * Judge a rejection observed after aborting with `reason`. `forwarded` wins
 * over `abort`: a wrapper's rejection with the caller reason would otherwise
 * pass whenever the reason (or its wrapping) mentions abort.
 */
export function classifyMeasuredAbortRejection(
  error: unknown,
  reason: string
): MeasuredAbortRejection {
  if (isForwardedAbortReason(error, reason)) return 'forwarded';
  if (isAbortError(error)) return 'abort';
  return 'other';
}

/**
 * The wrapper that would answer an ALREADY-aborted call for the provider, or
 * undefined for an unwrapped provider adapter. `instanceof` sees through the
 * task-local ownership proxy and the request-timeout proxy, which keep the
 * target's prototype.
 */
export function abortAnsweringWrapper(backend: ReasoningBackend): 'failover' | undefined {
  return backend instanceof FailoverReasoningBackend ? 'failover' : undefined;
}
