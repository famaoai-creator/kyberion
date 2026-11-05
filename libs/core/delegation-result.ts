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
import {
  classifyReasoningFailure,
  reasoningFailureMessage,
  type ReasoningFailureClass,
} from './reasoning/reasoning-failure-taxonomy.js';
import { maskActiveSecrets, redactActiveSecretsForHostLog } from './secret/secret-guard.js';
import type {
  DelegationArtifactRef,
  DelegationResultExtras,
  DelegationUsage,
} from './delegation-execution-tracker.js';

// The execution-start tracker is a dependency-free leaf so spawn helpers can
// report a start without importing this module's secret/taxonomy graph.
export {
  delegationExecutionStartedFromError,
  markDelegationExecutionStarted,
  markErrorExecutionStarted,
  reportDelegationResultMetadata,
  runStartReportingDelegation,
  runWithDelegationExecutionTracker,
} from './delegation-execution-tracker.js';
export type {
  DelegationArtifactRef,
  DelegationResultExtras,
  DelegationUsage,
} from './delegation-execution-tracker.js';

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

/** Mask active secrets without ever failing the delegation (over-masking is safe). */
function maskSecrets(text: string): string {
  // maskActiveSecrets honours task credential bindings and plugin grants;
  // the host redaction then masks every active secret, so nothing ungranted
  // inside a plugin frame survives into persisted records.
  let masked = text;
  try {
    masked = maskActiveSecrets(masked);
  } catch {
    // refused outside a trusted binding — the host redaction below still applies
  }
  try {
    return redactActiveSecretsForHostLog(masked);
  } catch {
    return masked ? '[REDACTED_SECRET_MASKING_UNAVAILABLE]' : masked;
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

/** A typed refusal raised before anything was dispatched (provably pre-start). */
export class DelegationNotStartedError extends Error {
  readonly executionStarted = false;
  constructor(message: string) {
    super(message);
    this.name = 'DelegationNotStartedError';
  }
}
