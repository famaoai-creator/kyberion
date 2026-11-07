/**
 * R5 execution-start tracker — a dependency-free leaf.
 *
 * Backends (and the shared provider spawn helper) report the moment side
 * effects become possible; the failover guard and the idempotent reservation
 * read it to decide whether a failed delegation may run again. Kept free of
 * the secret/taxonomy graph of `delegation-result.ts` (which re-exports it)
 * so low-level helpers such as `provider-spawn-env.ts` can depend on it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** The only error hint this leaf reads or writes. */
interface StartHint {
  executionStarted?: boolean;
}

/** A reference to an artifact the delegation produced — never its content. */
export interface DelegationArtifactRef {
  path: string;
  kind?: string;
}

/** Measured usage only. Absent fields were not reported by the provider. */
export interface DelegationUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  duration_ms?: number;
}

/** Provider-reported metadata a backend may attach to the delegation it serves. */
export interface DelegationResultExtras {
  artifacts?: ReadonlyArray<DelegationArtifactRef>;
  usage?: Partial<Record<keyof DelegationUsage, unknown>> | null;
  served_model?: string;
}

// ---------------------------------------------------------------------------
// Execution-start signal (R5 failover guard + idempotent reservation release)
// ---------------------------------------------------------------------------

export interface DelegationExecutionTracker {
  started: boolean;
  /** Provider-reported result metadata (usage, served model, artifact refs). */
  metadata: DelegationResultExtras;
  onStart?: () => void;
}

const executionTrackers = new AsyncLocalStorage<DelegationExecutionTracker[]>();

/**
 * Run `fn` while tracking whether a backend reports that the delegation's
 * execution began (a process was spawned / a tool turn ran). Trackers nest:
 * a start mark reaches every enclosing tracker.
 */
export function runWithDelegationExecutionTracker<T>(
  fn: (tracker: Readonly<DelegationExecutionTracker>) => Promise<T>,
  onStart?: () => void
): Promise<T> {
  const tracker: DelegationExecutionTracker = {
    started: false,
    metadata: {},
    ...(onStart ? { onStart } : {}),
  };
  const stack = [...(executionTrackers.getStore() ?? []), tracker];
  return executionTrackers.run(stack, () => fn(tracker));
}

/**
 * Backends call this once side effects become possible (child process
 * spawned, first tool call issued). Outside a tracked delegation it is a no-op.
 */
export function markDelegationExecutionStarted(): void {
  for (const tracker of executionTrackers.getStore() ?? []) {
    if (tracker.started) continue;
    tracker.started = true;
    try {
      tracker.onStart?.();
    } catch {
      // A start listener is bookkeeping and must never fail the delegation.
    }
  }
}

/**
 * Backends report measured metadata for the delegation they are serving.
 * Only reported values reach the result: unmeasured usage stays `null` and
 * an unreported model stays absent. Outside a tracked delegation it is a no-op.
 */
export function reportDelegationResultMetadata(metadata: DelegationResultExtras): void {
  for (const tracker of executionTrackers.getStore() ?? []) {
    tracker.metadata = {
      ...tracker.metadata,
      ...(metadata.usage !== undefined ? { usage: metadata.usage } : {}),
      ...(metadata.served_model ? { served_model: metadata.served_model } : {}),
      ...(metadata.artifacts?.length
        ? { artifacts: [...(tracker.metadata.artifacts ?? []), ...metadata.artifacts] }
        : {}),
    };
  }
}

/** Attach an explicit start marker to an error a backend is about to throw. */
export function markErrorExecutionStarted<E>(error: E, started = true): E {
  if (error && typeof error === 'object') {
    try {
      (error as StartHint).executionStarted = started;
    } catch {
      // Frozen errors keep their original shape.
    }
  }
  return error;
}

/**
 * Whether a delegation failure provably happened before execution started.
 * `true` = started, `false` = never started, `undefined` = unknown.
 *
 * Only structural evidence counts — never the message text, because agentic
 * CLIs print "unauthorized" / "unsupported" / "policy" after running tools:
 * - an explicit `executionStarted` marker (set by a typed refusal raised
 *   before dispatch, or by a backend), or
 * - a spawn failure (`code: 'ENOENT'`, `syscall: 'spawn …'`): the process
 *   never existed.
 */
export function delegationExecutionStartedFromError(error: unknown): boolean | undefined {
  const explicit =
    error && typeof error === 'object' ? (error as StartHint).executionStarted : undefined;
  if (typeof explicit === 'boolean') return explicit;
  if (!error || typeof error !== 'object') return undefined;
  const { code, syscall } = error as { code?: unknown; syscall?: unknown };
  if (code === 'ENOENT' && (syscall === undefined || String(syscall).startsWith('spawn'))) {
    return false;
  }
  return undefined;
}

/**
 * Run one backend's `delegateTask` body when that backend reports every
 * side-effect point through `markDelegationExecutionStarted` — a pure
 * completion call (nothing executes locally), a tool loop that marks before
 * its first tool runs, or a CLI spawned through `spawnWithDelegationEnv`
 * (which marks once the child exists). A failure before any mark is then
 * provably pre-start (a 429/5xx from the API, a refused preflight, a spawn
 * that never produced a process) and is marked `executionStarted: false`,
 * so a keyed delegation may still retry or fail over. A failure after a mark
 * is marked started. An existing explicit marker is never overwritten.
 *
 * Only wrap a body whose EVERY dispatch path reports its start: an unmarked
 * side effect would be misreported as "never started" and could run twice.
 */
export function runStartReportingDelegation<T>(fn: () => Promise<T>): Promise<T> {
  return runWithDelegationExecutionTracker(async (tracker) => {
    try {
      return await fn();
    } catch (error) {
      if (delegationExecutionStartedFromError(error) === undefined) {
        markErrorExecutionStarted(error, tracker.started);
      }
      throw error;
    }
  });
}
