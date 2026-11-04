/**
 * Structured delegation result (R2) — a provider-neutral terminal record of a
 * delegated task, in addition to the legacy `delegateTask(): Promise<string>`.
 *
 * Concept borrowed from HarnessRouter's UHP Response object; re-implemented
 * here on top of Kyberion's own failure taxonomy (`classifyReasoningFailure`).
 * Nothing in this module guesses a value it was not told: `usage` is `null`
 * when unmeasured (never zero-filled) and `served_model` is omitted when the
 * provider did not report one.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  classifyReasoningFailure,
  reasoningFailureMessage,
  type ReasoningFailureClass,
} from './reasoning/reasoning-failure-taxonomy.js';
import { maskActiveSecrets, redactActiveSecretsForHostLog } from './secret/secret-guard.js';

export type DelegationResultStatus = 'completed' | 'failed' | 'incomplete' | 'cancelled';

export type DelegationIncompleteReason =
  'budget_exhausted' | 'timeout' | 'input_required' | 'interrupted';

export interface DelegationResultError {
  class: ReasoningFailureClass;
  retryable: boolean;
  allowFailover: boolean;
  /** Single line, secrets masked. */
  message: string;
  /** Multi-line / long form of the failure, secrets masked. */
  detail?: string;
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

export interface DelegationResult {
  status: DelegationResultStatus;
  output_text: string;
  error?: DelegationResultError;
  incomplete_reason?: DelegationIncompleteReason;
  artifacts: DelegationArtifactRef[];
  /** `null` when the provider did not measure usage — never zero-filled. */
  usage: DelegationUsage | null;
  /** Omitted when the provider did not report the served model. */
  served_model?: string;
}

export interface DelegationResultExtras {
  artifacts?: ReadonlyArray<DelegationArtifactRef>;
  usage?: Partial<Record<keyof DelegationUsage, unknown>> | null;
  served_model?: string;
}

/**
 * Mask active secrets without ever failing the delegation. `maskActiveSecrets`
 * refuses outside a trusted credential binding (tenant scopes); fall back to
 * the host redaction, which masks every active secret (over-masking is safe).
 */
function maskSecrets(text: string): string {
  try {
    return maskActiveSecrets(text);
  } catch {
    try {
      return redactActiveSecretsForHostLog(text);
    } catch {
      return text ? '[REDACTED_SECRET_MASKING_UNAVAILABLE]' : text;
    }
  }
}

const MESSAGE_MAX_CHARS = 500;
const DETAIL_MAX_CHARS = 4000;
const USAGE_KEYS: ReadonlyArray<keyof DelegationUsage> = [
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'cost_usd',
  'duration_ms',
];

/** Keep only measured, finite, non-negative usage fields; `null` when none remain. */
export function normalizeDelegationUsage(
  usage: DelegationResultExtras['usage']
): DelegationUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const normalized: DelegationUsage = {};
  for (const key of USAGE_KEYS) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) normalized[key] = value;
  }
  return Object.keys(normalized).length ? normalized : null;
}

function normalizeArtifacts(
  artifacts: DelegationResultExtras['artifacts']
): DelegationArtifactRef[] {
  return (artifacts ?? [])
    .filter((artifact) => typeof artifact?.path === 'string' && artifact.path.trim())
    .map((artifact) => ({
      path: artifact.path,
      ...(typeof artifact.kind === 'string' && artifact.kind ? { kind: artifact.kind } : {}),
    }));
}

function extrasFields(
  extras: DelegationResultExtras = {}
): Pick<DelegationResult, 'artifacts' | 'usage' | 'served_model'> {
  const servedModel = typeof extras.served_model === 'string' ? extras.served_model.trim() : '';
  return {
    artifacts: normalizeArtifacts(extras.artifacts),
    usage: normalizeDelegationUsage(extras.usage),
    ...(servedModel ? { served_model: servedModel } : {}),
  };
}

function singleLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MESSAGE_MAX_CHARS
    ? `${collapsed.slice(0, MESSAGE_MAX_CHARS - 1)}…`
    : collapsed;
}

export function buildCompletedDelegationResult(
  outputText: string,
  extras?: DelegationResultExtras
): DelegationResult {
  return {
    status: 'completed',
    output_text: maskSecrets(String(outputText ?? '')),
    ...extrasFields(extras),
  };
}

function incompleteReasonOf(message: string): DelegationIncompleteReason | undefined {
  if (
    /\[DELEGATION_INPUT_REQUIRED\]|input.?required|awaiting (?:user|operator) input/i.test(message)
  )
    return 'input_required';
  if (/budget.?exhausted|token budget|max.?turns|turn limit/i.test(message))
    return 'budget_exhausted';
  if (/timed out|timeout|wall.?clock|inactivity/i.test(message)) return 'timeout';
  if (/\bSIG(?:TERM|KILL|INT|HUP)\b|interrupted|killed/i.test(message)) return 'interrupted';
  return undefined;
}

/**
 * Error properties a governed layer may attach. `failureClass` preserves the
 * underlying taxonomy class across wrapping (e.g. the failover aggregate);
 * `executionStarted: true` forbids failover because side effects may exist.
 */
interface DelegationErrorHints {
  failureClass?: ReasoningFailureClass;
  executionStarted?: boolean;
  delegationResult?: DelegationResult;
}

function hintsOf(error: unknown): DelegationErrorHints {
  return error && typeof error === 'object' ? (error as DelegationErrorHints) : {};
}

/** Map a thrown delegation error onto the structured result. */
export function buildFailedDelegationResult(
  error: unknown,
  extras?: DelegationResultExtras & { output_text?: string }
): DelegationResult {
  const hints = hintsOf(error);
  if (hints.delegationResult) return hints.delegationResult;
  const raw = maskSecrets(reasoningFailureMessage(error));
  const classification = classifyReasoningFailure(error);
  const failureClass = hints.failureClass ?? classification.class;
  const message = singleLine(raw) || 'delegation failed';
  const detail =
    raw.length > message.length || /\n/.test(raw) ? raw.slice(0, DETAIL_MAX_CHARS) : '';
  const resultError: DelegationResultError = {
    class: failureClass,
    retryable: hints.executionStarted ? false : classification.retryable,
    allowFailover: hints.executionStarted ? false : classification.allowFailover,
    message,
    ...(detail ? { detail } : {}),
  };
  const base = {
    output_text: maskSecrets(String(extras?.output_text ?? '')),
    error: resultError,
    ...extrasFields(extras),
  };
  if (failureClass === 'cancelled') return { status: 'cancelled', ...base };
  const incompleteReason = incompleteReasonOf(raw);
  if (incompleteReason)
    return { status: 'incomplete', incomplete_reason: incompleteReason, ...base };
  return { status: 'failed', ...base };
}

/** Cancellation by the caller (handle.cancel), not a provider failure. */
export function buildCancelledDelegationResult(reason: string): DelegationResult {
  const message = singleLine(maskSecrets(reason)) || 'cancelled';
  return {
    status: 'cancelled',
    output_text: '',
    error: { class: 'cancelled', retryable: false, allowFailover: false, message },
    artifacts: [],
    usage: null,
  };
}

/**
 * Error carrying a terminal DelegationResult, thrown by the legacy string API
 * when a non-completed result is replayed (e.g. an idempotent replay).
 */
export class DelegationTerminalError extends Error {
  readonly delegationResult: DelegationResult;
  readonly failureClass: ReasoningFailureClass;
  readonly executionStarted?: boolean;
  constructor(result: DelegationResult, options: { executionStarted?: boolean } = {}) {
    super(result.error?.message || `delegation ${result.status}`);
    this.name = 'DelegationTerminalError';
    this.delegationResult = result;
    this.failureClass = result.error?.class ?? 'unknown';
    if (options.executionStarted !== undefined) this.executionStarted = options.executionStarted;
  }
}

/**
 * R5 failover guard: a delegation failed after its execution started on a
 * backend. Side effects may exist, so it is neither retried in place nor
 * re-run on another candidate.
 */
export class DelegationExecutionStartedError extends Error {
  readonly executionStarted = true;
  readonly failureClass: ReasoningFailureClass;
  readonly servedBy: string;
  readonly originalError: unknown;
  constructor(servedBy: string, originalError: unknown) {
    super(
      `[DELEGATION_EXECUTION_STARTED] delegation already started on ${servedBy}; not retrying or re-running it on another candidate because side effects may exist: ${reasoningFailureMessage(originalError)}`
    );
    this.name = 'DelegationExecutionStartedError';
    this.servedBy = servedBy;
    this.originalError = originalError;
    this.failureClass =
      hintsOf(originalError).failureClass ?? classifyReasoningFailure(originalError).class;
  }
}

/** Legacy projection: completed → output text, anything else → throws. */
export function delegationResultText(result: DelegationResult): string {
  if (result.status === 'completed') return result.output_text;
  throw new DelegationTerminalError(result);
}

// ---------------------------------------------------------------------------
// Execution-start signal (R5 failover guard + idempotent reservation release)
// ---------------------------------------------------------------------------

interface DelegationExecutionTracker {
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
      (error as DelegationErrorHints).executionStarted = started;
    } catch {
      // Frozen errors keep their original shape.
    }
  }
  return error;
}

const PRE_START_CLASSES: ReadonlySet<ReasoningFailureClass> = new Set([
  'auth',
  'entitlement',
  'capability',
  'capacity',
  'policy',
  'request',
]);

/**
 * Whether a delegation failure provably happened before execution started.
 * `true` = started, `false` = never started, `undefined` = unknown.
 *
 * Explicit markers win; otherwise only refusals that a provider returns
 * before running anything (auth, entitlement, missing binary, unsupported
 * capability, context limit, policy/request rejection) count as pre-start.
 */
export function delegationExecutionStartedFromError(error: unknown): boolean | undefined {
  const explicit = hintsOf(error).executionStarted;
  if (typeof explicit === 'boolean') return explicit;
  const message = reasoningFailureMessage(error);
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (
    code === 'ENOENT' ||
    /\bENOENT\b|command not found|not installed|binary (?:is )?missing/i.test(message)
  )
    return false;
  if (PRE_START_CLASSES.has(classifyReasoningFailure(error).class)) return false;
  return undefined;
}
