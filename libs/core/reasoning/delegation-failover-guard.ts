/**
 * R5 failover guard for delegated tasks.
 *
 * Once a delegation's execution has started on a backend, side effects may
 * exist (files edited, commands run). Such a delegation is never retried in
 * place nor re-run on another failover candidate; its failure is reported
 * with `allowFailover: false`. Only failures with a structural pre-start
 * proof (an explicit `executionStarted: false` marker, a spawn ENOENT) may
 * still fail over — never a verdict inferred from the message text.
 *
 * Kept out of reasoning-backend.ts so the failover chain only calls into it.
 */
import { runIdempotentDelegation } from '../workforce/delegation-idempotency.js';
import {
  DelegationExecutionStartedError,
  delegationExecutionStartedFromError,
  markErrorExecutionStarted,
  runWithDelegationExecutionTracker,
} from '../workforce/delegation-result.js';
import type { ReasoningFailureClass } from './reasoning-failure-taxonomy.js';

/** The failover candidate an attempt runs on (named in the failure message). */
export interface GuardedCandidate {
  label?: string;
  provider?: string;
  backend: { name: string };
}

/** Wraps a failover `invoke` so every candidate attempt is start-guarded. */
export type DelegationAttemptGuard = <B, C extends GuardedCandidate>(
  invoke: (backend: B, candidate: C) => Promise<string>
) => (backend: B, candidate: C) => Promise<string>;

export interface GuardedDelegationHooks {
  guard: DelegationAttemptGuard;
  /** Call once a first pass returned: a later failure then counts as started. */
  onFirstPassServed: () => void;
}

export const STARTED_NEXT_ACTION =
  'execution already started (side effects may exist); stopping without retry or fallback';

interface DelegationGuardOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** Split a guard failure into its marker and the provider's own error. */
export function splitStarted(error: unknown): {
  startedError?: DelegationExecutionStartedError;
  underlying: unknown;
} {
  return error instanceof DelegationExecutionStartedError
    ? { startedError: error, underlying: error.originalError }
    : { underlying: error };
}

/** Rethrow form when no redispatch happens: the provider error, start marker kept. */
export function unwrap(error: unknown): unknown {
  return error instanceof DelegationExecutionStartedError
    ? markErrorExecutionStarted(error.originalError)
    : error;
}

export function startedAttemptFailure(
  failureClass: ReasoningFailureClass,
  message: string
): { ok: false; message: string; stop: true } {
  return { ok: false, message: `[${failureClass}] [execution-started] ${message}`, stop: true };
}

/** Run `execute` under the caller's `idempotencyKey` (pass-through without one). */
export function withDelegationIdempotency(
  instruction: string,
  context: string | undefined,
  options: DelegationGuardOptions | undefined,
  execute: () => Promise<string>
): Promise<string> {
  return runIdempotentDelegation({
    instruction,
    ...(context ? { context } : {}),
    ...(options ? { options } : {}),
    execute,
  });
}

/**
 * Idempotent + start-guarded delegation across a failover chain. `body` wraps
 * each candidate attempt with `guard` and calls `onFirstPassServed` once a
 * first pass returned (a later continuation failure then counts as started).
 *
 * With an idempotency key the guard is conservative: an unknown start state
 * counts as started. Without a key, only an explicit start signal does, so
 * legacy failover behavior is unchanged.
 */
export function runGuarded<O extends DelegationGuardOptions>(
  body: (
    instruction: string,
    context: string | undefined,
    options: O | undefined,
    hooks: GuardedDelegationHooks
  ) => Promise<string>,
  instruction: string,
  context?: string,
  options?: O
): Promise<string> {
  return withDelegationIdempotency(instruction, context, options, async () => {
    const keyed = Boolean(options?.idempotencyKey?.trim());
    let executed = false;
    let started: DelegationExecutionStartedError | undefined;
    const guard: DelegationAttemptGuard = (invoke) => (backend, candidate) =>
      runWithDelegationExecutionTracker(async (tracker) => {
        try {
          return await invoke(backend, candidate);
        } catch (error) {
          if (error instanceof DelegationExecutionStartedError) throw (started = error);
          const explicit = delegationExecutionStartedFromError(error);
          if (tracker.started || explicit === true || (keyed && explicit === undefined)) {
            const label =
              candidate.label || candidate.backend.name || candidate.provider || 'unknown';
            throw (started = new DelegationExecutionStartedError(label, error));
          }
          throw error;
        }
      });
    try {
      return await body(instruction, context, options, {
        guard,
        onFirstPassServed: () => {
          executed = true;
        },
      });
    } catch (error) {
      if (started) {
        // Keep the verdict on the failover aggregate for replay / structured results.
        markErrorExecutionStarted(error, true);
        if (error && typeof error === 'object' && !('failureClass' in error)) {
          Object.assign(error, { failureClass: started.failureClass });
        }
      } else if (keyed || executed) {
        // With a key, the guard converts every attempt failure lacking a
        // structural pre-start proof, so an unmarked aggregate means nothing
        // was dispatched (or every attempt failed to spawn).
        markErrorExecutionStarted(
          error,
          executed || delegationExecutionStartedFromError(error) === true
        );
      }
      throw error;
    }
  });
}
