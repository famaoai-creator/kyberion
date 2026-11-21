import { buildTrustedInformationAssetWakeProposals } from '../information-assets/collector-wake.js';
import {
  assertEventContinuationOutput,
  claimEventContinuation,
  eventContinuationCharterChanged,
  isDurableEventKey,
} from './dot-event-continuation.js';
import { isFrontDeskDiagnosticDot } from './dot-charter.js';
import { assertDotAccountabilityCharter } from './dot-authority.js';
import { dotAdmissionScopeHash } from './dot-admission-identity.js';
import { loadDotExecutionPolicy } from './dot-execution-policy.js';
/**
 * Dot runtime: due-ness and one bounded goal turn per wake, called by the supervisor.
 * Durable loop memory under `active/shared/runtime/`:
 *
 * - `dot-wake-ledger.jsonl` — one row per wake attempt, keyed by a trigger key
 *   (`cron:<expr>@<minute>`, `watch:<path>@<mtime>:<size>`, `wake:<line-hash>`,
 *   `manual:<iso>`). Due-ness semantics per outcome:
 *     delivered / rejected → the key is consumed (rejected = policy wedge: a
 *                            misconfigured trigger must not hot-loop);
 *     failed               → retryable after DOT_WAKE_RETRY_AFTER_MS;
 *     skipped              → does NOT consume the key — a paused/capped dot
 *                            keeps the event pending so it can still fire
 *                            after the blocker clears. One skipped row per key
 *                            is kept as the audit marker (no flood).
 *   Keys are only matched within the same dot_id — two dots sharing a cron
 *   expression or a broadcast inbox row each get their own wake.
 * - `dot-token-usage.jsonl` — token usage accrued per wake, so
 *   `token_cap_per_day` is enforced across processes, not just per turn.
 *
 * `watch` snapshots live in `dot-watch-state.json`; `wake` channels read
 * `dot-inbox.jsonl` (`{dot_id?, channel, ...}` rows — a row with no dot_id
 * wakes every charter declaring that channel).
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
} from '../secure-io.js';
import { writeJson } from '../foundation/json.js';
import { readJsonLinesCached } from '../storage/jsonl-tail.js';
import { streamJsonLines } from '../storage/jsonl-read.js';
import {
  DOT_TOKEN_USAGE_PATH,
  maintainDotTokenUsageAfterAppend,
  readDotTokenUsageForDay,
  type DotTokenUsageEntry,
} from './dot-token-usage.js';
import { parseSafeJsonObjectInput } from '../foundation/safe-json.js';
import { getZonedDateParts, matchesCron } from '../pipeline/cron-utils.js';
import { recordDaemonHeartbeat } from '../daemon/daemon-heartbeat.js';
import { getReasoningBackend } from '../reasoning/reasoning-backend.js';
import { isLocalReasoningBackend } from '../reasoning/reasoning-egress-scope.js';
import {
  alertDotWakeLocalBackendUnavailable,
  buildLocalOnlyWakeBackend,
} from './dot-local-backend.js';
import { summarizeAppendedJsonlRecords, watchAppendOnlyIgnoredKinds } from './dot-append-watch.js';
import type { OpsAlertInput } from '../daemon/ops-alert.js';
import type {
  ReasoningBackend,
  ToolCall,
  ToolDefinition,
} from '../reasoning/reasoning-backend-contracts.js';
import { loadAuthorityRoleIndex } from '../organization/authority-role-registry.js';
import { estimateTokens } from '../foundation/text.js';
import {
  dotGoalRefLabel,
  listDotCharters,
  rereadOwnDotCharter,
  type DotCharter,
  type DotCharterLoadError,
  type DotTrigger,
  type LoadedDotCharter,
} from './dot-charter.js';
import { evaluateStateProbe, probeSpecId, type StateProbeDeps } from '../pipeline/state-probe.js';
import { createLogger } from '../logger.js';
import { getUsageAttribution } from '../finance/usage-accounting.js';
import { estimateWakeTokensFromText, withDotWakeUsage } from './dot-wake-usage.js';
import {
  withDotWakeSemanticObserver,
  type DotWakeSemanticCapture,
  type DotWakeSemanticFixtureInjection,
} from './dot-wake-semantic-observer.js';
import {
  buildDotProposeToolDefinition,
  collectDotProposals,
  dotProposalInstructions,
  parseDotProposalsFromText,
  DOT_PROPOSALS_FENCE,
  DOT_PROPOSE_TOOL_NAME,
  type DotProposal,
} from './dot-proposals.js';
import {
  dispatchDotProposals,
  dotBoundsPromptLines,
  type DotActionRecord,
} from './dot-dispatch.js';
import { dotFeedbackPromptLines, dotSignalStatusLines, readDotFeedback } from './dot-feedback.js';
import { readDotActionLedger } from './dot-action-ledger.js';
import { loadApprovalRequest } from '../governance/approval-store-reader.js';
import { AUTONOMY_APPROVAL_CHANNEL } from '../governance/approval-decision-card.js';
import { dotStatePath } from './dot-state-paths.js';
import {
  DOT_WAKE_SUSPENSION_THRESHOLD_MS,
  startDotWakeSuspensionMonitor,
  type DotWakeSuspensionMonitorFactory,
} from './dot-wake-suspension.js';
import { DOT_PROMPT_SECTIONS, DOT_WAKE_TOOLS } from './dot-extension-registry.js';
import { dotExtCtx, type DotExtCtx } from './dot-extensions.js';
import {
  evaluateDotFollowupsDue,
  followupRetryEvidence,
  recoverRetainedDotFollowup,
} from './dot-followups.js';
import { dotOutcomeContinuation } from './dot-progress.js';
import { assertDotStateLayoutReady } from './dot-state-paths.js';
import {
  runDelegatedWake,
  dotBackendIsUnconfiguredStub,
  isDotToolBackendUnavailableError,
  DOT_WAKE_BACKEND_UNAVAILABLE,
} from './dot-wake-backend.js';

const logger = createLogger('dot-runtime');

export { DOT_TOKEN_USAGE_PATH, type DotTokenUsageEntry } from './dot-token-usage.js';
export const DOT_WATCH_STATE_PATH = 'active/shared/runtime/dot-watch-state.json';
export const DOT_PROBE_STATE_PATH = 'active/shared/runtime/dot-probe-state.json';
export { DOT_INBOX_PATH } from './dot-inbox.js';
import {
  dotInboxPath,
  dotInboxRowWakesCharter,
  dotInboxWakeKey,
  DOT_EXECUTOR_REPORT_SOURCE_VALUE,
} from './dot-inbox.js';
import {
  classifyDotWakeReason,
  dotWakeErrorsPath,
  isDotWakeProcessFailure,
  DOT_WAKE_FAILURE_CATEGORY,
  type DotWakeFailureCategory,
} from './dot-wake-reasons.js';
import {
  appendJsonlEnsured,
  DOT_WAKE_LEDGER_PATH,
  dotRuntimePath as runtimePath,
  readDotWakeLedger,
  recordDotWakeOutcome,
  type DotWakeLedgerEntry,
  type DotWakeOutcome,
  type DotWakeTrigger,
} from './dot-wake-ledger.js';
import {
  applyDotWakeCircuit,
  dotWakeBackoffMs,
  recordDotCredentialFailureInputs,
} from './dot-wake-circuit.js';
// Moved out of this module; re-exported so existing callers keep one import site.
export {
  DOT_WAKE_FAILURE_CATEGORY,
  classifyDotWakeReason,
  dotWakeErrorsPath,
  isDotWakeProcessFailure,
  normalizeDotWakeReason,
  type DotWakeFailureCategory,
  type DotWakeReasonCode,
} from './dot-wake-reasons.js';
export {
  DOT_WAKE_LEDGER_PATH,
  compactDotWakeLedger,
  readDotWakeLedger,
  recordDotWakeOutcome,
  type DotWakeLedgerEntry,
  type DotWakeOutcome,
  type DotWakeTrigger,
} from './dot-wake-ledger.js';
export {
  DOT_WAKE_CIRCUIT_THRESHOLD,
  DOT_WAKE_CREDENTIAL_RECHECK_MS,
  DOT_WAKE_MAX_BACKOFF_MS,
  DOT_WAKE_RETRY_AFTER_MS,
  applyDotWakeCircuit,
  dotCredentialInputsFingerprint,
  dotWakeBackoffMs,
  evaluateDotWakeCircuit,
  type DotWakeCircuitState,
} from './dot-wake-circuit.js';

/** Ceiling for a delegated-turn wake when the charter sets no wall clock. */
const DEFAULT_DELEGATED_WAKE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Port for the goal-driven loop. Domain must not import the orchestration
 * driver (`worker-goal-driver`); callers under scripts / supervisor inject
 * `runGoalDrivenLoop` (or a test double) through {@link DotRuntimeDeps.runLoop}.
 */
export interface DotWakeLoopOptions {
  objective: string;
  goalId?: string;
  /** Accountable actor on the goal driver's tool-call audit records (`dot:<id>`). */
  actorId?: string;
  systemPrompt?: string;
  toolRole?: string;
  maxTurns?: number;
  budget?: {
    wallClockBudgetMs?: number;
    turnBudget?: number;
  };
  /** Goal driver completion-audit wording; dot wakes use `event_handler`. */
  completionMode?: 'strict' | 'event_handler';
  /** Goal driver KD-02 grace step after a reached budget; dot wakes pass false. */
  budgetGraceStep?: boolean;
  /** The proposal tool plus registered wake tools — the only tools a dot is given. */
  extraTools?: ToolDefinition[];
  executeTool?: (call: ToolCall) => { resultText: string };
  /**
   * The backend the wake resolved. Passed straight to the goal driver so the
   * loop never re-resolves a different (e.g. stub) process backend.
   */
  backend?: Pick<ReasoningBackend, 'generateWithTools'>;
  /** Called with each turn's prompt as it is sent (the goal driver's `onPromptVisible`). */
  onPromptVisible?: (content: string, form: string) => void;
  /** Per-turn token estimator (the goal driver's `estimateTurnTokens`); called after each turn's response. */
  estimateTurnTokens?: (input: {
    prompt: string;
    result: { text?: string; toolCalls?: Array<{ name: string; input: unknown }> };
  }) => number;
}

/** Minimal wake receipt shape — only the fields the ledger/CLI need. */
export interface DotWakeLoopResult {
  turnsRun: number;
  finalState?: string;
  goal: { budgetStats?: { tokensUsed?: number }; terminalReason?: string };
}

/**
 * The goal driver ends a wake whose live backend turn outran the wall-clock
 * budget as `blocked` instead of throwing (the turn is cancelled, not failed).
 * With nothing collected that wake produced no work and must not read as delivered.
 */
function wallClockCancelledReason(result: DotWakeLoopResult): string | undefined {
  const reason = result.goal.terminalReason ?? '';
  if (result.finalState !== 'blocked' || !/wall[-_]clock budget/.test(reason)) return undefined;
  return `wake tool loop exceeded its wall_clock budget before a backend turn completed (${reason})`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Max characters of the dot's reply kept in the wake ledger. */
export const DOT_WAKE_SUMMARY_MAX = 600;

/** Reply text minus the fenced proposal block, whitespace-collapsed and bounded. */
export function dotWakeSummary(text: string | undefined): string | undefined {
  if (!text) return undefined;
  let prose = text;
  for (const fence of [DOT_PROPOSALS_FENCE, ...DOT_WAKE_TOOLS.map((tool) => tool.fence)]) {
    prose = prose.replace(new RegExp('```' + escapeRegExp(fence) + '[\\s\\S]*?```', 'g'), ' ');
  }
  prose = prose.replace(/\s+/g, ' ').trim();
  return prose ? prose.slice(0, DOT_WAKE_SUMMARY_MAX) : undefined;
}

export interface DotInboxEntry {
  dot_id?: string;
  channel?: string;
  [key: string]: unknown;
}

export interface DueDotTrigger {
  trigger: DotWakeTrigger;
  /** Stable dedup key; also used as the TriggerRunner idempotency key suffix. */
  key: string;
  /** Context the wake's goal turn should see (watched path / inbox row). */
  detail?: string;
  /** Set when this wake is the half-open probe of a dot whose wake circuit tripped. */
  circuit?: true;
  /** A retained delivery uses a separate runner key, including across upgrades. */
  followupRecovery?: true;
}

export interface DotRuntimeDeps {
  /** Explicit offline-fixture observation only; no production budget/provider adapter. */
  semanticJudgment?: DotWakeSemanticFixtureInjection;
  /** Internal durable event claim, minted immediately before provider invocation. */
  eventAttemptId?: string;
  /** Resolve provider wiring only after current charter validation. */
  resolveWakeExecution?: (
    charter: DotCharter
  ) => Promise<Pick<DotRuntimeDeps, 'backend' | 'runLoop' | 'backendUnavailable'>>;
  rootDir?: string;
  now?: () => Date;
  /**
   * Goal-loop port. Required when the backend exposes `generateWithTools`.
   * Orchestration callers inject `runGoalDrivenLoop`; tests inject a stub.
   * Domain never defaults to the orchestration driver (layer boundary).
   */
  runLoop?: (options: DotWakeLoopOptions) => Promise<DotWakeLoopResult>;
  /**
   * Injectable backend; defaults to getReasoningBackend(). When the backend
   * lacks `generateWithTools` (local shell CLIs), the wake degrades to a
   * single `delegateTask` turn bounded by wall_clock_ms_per_wake — the
   * delegated provider runs the objective natively.
   */
  backend?: Pick<ReasoningBackend, 'generateWithTools' | 'delegateTask' | 'delegateTaskHandle'>;
  /** Role-registry lookup for the per-wake revalidation (test seam). */
  hasRole?: (role: string) => boolean;
  /** Proposal governance port; defaults to {@link dispatchDotProposals}. */
  dispatch?: (charter: DotCharter, proposals: readonly DotProposal[]) => DotActionRecord[];
  /** Ops-alert port for the wake circuit; defaults to `sendOpsAlert` (dot-wake-circuit.ts). */
  opsAlert?: (input: OpsAlertInput) => void;
  /**
   * Set by orchestration when backend resolution found nothing real to run
   * (unconfigured stub). The wake records a failed row with this reason
   * instead of fabricating a delivery.
   */
  backendUnavailable?: string;
  /** Host-suspension detector for one wake (test seam); defaults to the timer-gap monitor. */
  suspensionMonitor?: DotWakeSuspensionMonitorFactory;
  /**
   * Fingerprint of the inputs a `credential_grant` failure depends on (test
   * seam); defaults to {@link dotCredentialInputsFingerprint}.
   */
  credentialInputsFingerprint?: (charter: DotCharter) => string | undefined;
}

/** Owner-scoped diagnostics; the global ledger remains a content-free control index. */
export function readScopedDotWakeLedger(
  charter: DotCharter,
  deps: DotRuntimeDeps = {}
): DotWakeLedgerEntry[] {
  if (charter.scope.tier === 'public' && !charter.scope.tenant_slug)
    return readDotWakeLedger(deps).filter((row) => row.dot_id === charter.dot_id);
  const key = (row: DotWakeLedgerEntry) =>
    JSON.stringify([row.trigger_key, row.fired_at, row.outcome]);
  const rows = new Map(
    readDotWakeLedger(deps)
      .filter((row) => row.dot_id === charter.dot_id)
      .map((row) => [key(row), row])
  );
  for (const row of readJsonLinesCached<DotWakeLedgerEntry>(
    runtimePath(deps.rootDir, dotStatePath(charter, 'wake-ledger.jsonl'))
  ))
    if (row.dot_id === charter.dot_id) rows.set(key(row), row);
  return [...rows.values()];
}

export {
  DOT_WAKE_LEDGER_COMPACT_MIN_BYTES,
  type DotWakeLedgerCompactionResult,
} from './dot-wake-ledger-compaction.js';

export function recordDotTokenUsage(
  dotId: string,
  tokens: number,
  deps: DotRuntimeDeps & { accounting_id?: string } = {}
): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const now = deps.now?.() ?? new Date();
  const attribution = getUsageAttribution();
  const accounting_id =
    deps.accounting_id ??
    (attribution?.actor_id === `dot:${dotId}` ? attribution.accounting_id : undefined);
  appendJsonlEnsured(
    DOT_TOKEN_USAGE_PATH,
    {
      dot_id: dotId,
      ...(accounting_id ? { accounting_id } : {}),
      day: now.toISOString().slice(0, 10),
      tokens,
      recorded_at: now.toISOString(),
    } satisfies DotTokenUsageEntry,
    deps
  );
  maintainDotTokenUsageAfterAppend(runtimePath(deps.rootDir, DOT_TOKEN_USAGE_PATH), now);
}

/**
 * Tokens accrued by this dot today (UTC day bucket), across all processes.
 * Backward scan to just before the day starts: the cost follows today's rows,
 * not the history, and the ledger's size never makes the check fail.
 */
export function dotTokensUsedToday(dotId: string, deps: DotRuntimeDeps = {}): number {
  const day = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  return readDotTokenUsageForDay(runtimePath(deps.rootDir, DOT_TOKEN_USAGE_PATH), day)
    .filter((row) => row?.dot_id === dotId)
    .reduce((sum, row) => sum + (Number(row.tokens) || 0), 0);
}

/** Daily token cap check: true when the charter caps tokens and the cap is hit. */
export function dotDailyTokenCapReached(charter: DotCharter, deps: DotRuntimeDeps = {}): boolean {
  const cap = charter.goal.budget?.token_cap_per_day;
  if (cap === undefined) return false;
  return dotTokensUsedToday(charter.dot_id, deps) >= cap;
}

type WatchState = Record<
  string,
  Record<string, { mtime_ms: number; size: number; last_wake_ms?: number }>
>;

function readWatchState(deps: DotRuntimeDeps): WatchState {
  const filePath = runtimePath(deps.rootDir, DOT_WATCH_STATE_PATH);
  if (!safeExistsSync(filePath)) return {};
  try {
    return parseSafeJsonObjectInput(
      safeReadFile(filePath, { encoding: 'utf8' }) as string,
      filePath
    ) as WatchState;
  } catch {
    return {};
  }
}

function writeWatchState(state: WatchState, deps: DotRuntimeDeps): void {
  const statePath = runtimePath(deps.rootDir, DOT_WATCH_STATE_PATH);
  safeMkdir(path.dirname(statePath), { recursive: true });
  writeJson(statePath, state);
}

/** Watch paths are confined to the repo — a charter must not become a host oracle. */
function confinedWatchStat(
  rel: string,
  deps: DotRuntimeDeps
): { mtime_ms: number; size: number } | null {
  try {
    const safe = assertSafeRepositoryPath(path.join(deps.rootDir ?? pathResolver.rootDir(), rel), {
      allowMissingLeaf: true,
    });
    const stat = safeLstat(safe);
    return { mtime_ms: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/**
 * Persist the observed watch stats that were already delivered — takes the
 * values captured at evaluation time (encoded in the trigger key), so a change
 * landing mid-wake still produces a fresh key on the next sweep.
 */
export function recordDotWatchSnapshot(charter: DotCharter, deps: DotRuntimeDeps = {}): void {
  const state = readWatchState(deps);
  const dotState = { ...(state[charter.dot_id] ?? {}) };
  for (const trigger of charter.attention.triggers) {
    if (trigger.kind !== 'watch') continue;
    for (const rel of trigger.paths) {
      const current = confinedWatchStat(rel, deps);
      const prior = dotState[rel]?.last_wake_ms;
      if (current) dotState[rel] = { ...current, ...(prior ? { last_wake_ms: prior } : {}) };
      else delete dotState[rel];
    }
  }
  writeWatchState({ ...state, [charter.dot_id]: dotState }, deps);
}

/** Update the snapshot for one watched path to the exact stat the wake saw. */
function recordWatchSnapshotFromKey(
  charter: DotCharter,
  trigger: DueDotTrigger,
  deps: DotRuntimeDeps
): void {
  // key = `watch:<rel>@<mtime>:<size>`
  const match = /^watch:(.+)@(\d+):(\d+)$/.exec(trigger.key);
  if (!match) return;
  const [, rel, mtime, size] = match;
  const state = readWatchState(deps);
  writeWatchState(
    {
      ...state,
      [charter.dot_id]: {
        ...(state[charter.dot_id] ?? {}),
        [rel]: {
          mtime_ms: Number(mtime),
          size: Number(size),
          last_wake_ms: (deps.now?.() ?? new Date()).getTime(),
        },
      },
    },
    deps
  );
}

function minuteKey(date: Date, timezone?: string): string {
  const parts = getZonedDateParts(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function watchTriggerKey(
  charter: DotCharter,
  rel: string,
  deps: DotRuntimeDeps,
  ignoredKinds: readonly string[] = [],
  minSeverity?: string,
  minIntervalSeconds?: number
): { key: string; detail: string } | null {
  const current = confinedWatchStat(rel, deps);
  if (!current) return null;
  const state = readWatchState(deps);
  const snapshot = state[charter.dot_id]?.[rel];
  if (snapshot && snapshot.mtime_ms === current.mtime_ms && snapshot.size === current.size) {
    return null;
  }
  if (minIntervalSeconds && minIntervalSeconds > 0 && snapshot?.last_wake_ms) {
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    if (nowMs - snapshot.last_wake_ms < minIntervalSeconds * 1000) return null;
  }
  if (
    (ignoredKinds.length > 0 || minSeverity !== undefined) &&
    snapshot &&
    watchAppendOnlyIgnoredKinds(
      rel,
      snapshot.size,
      current.size,
      ignoredKinds,
      deps.rootDir,
      minSeverity
    )
  ) {
    writeWatchState(
      {
        ...state,
        [charter.dot_id]: { ...(state[charter.dot_id] ?? {}), [rel]: current },
      },
      deps
    );
    return null;
  }
  // Append-only JSONL: carry the wake-worthy appended records (bounded) so the
  // wake does not spend turns rediscovering what changed.
  const appended =
    snapshot && rel.endsWith('.jsonl') && current.size > snapshot.size
      ? summarizeAppendedJsonlRecords(rel, snapshot.size, current.size, {
          ignored: ignoredKinds,
          ...(minSeverity !== undefined ? { minSeverity } : {}),
          ...(deps.rootDir ? { rootDir: deps.rootDir } : {}),
        })
      : undefined;
  return {
    key: `watch:${rel}@${Math.round(current.mtime_ms)}:${current.size}`,
    detail: appended
      ? `watch ${rel} changed\nAppended records:\n${appended}`
      : `watch ${rel} changed`,
  };
}

/** `payload.report_from` of an executor report-back inbox row (DL-01). */
export const DOT_EXECUTOR_REPORT_SOURCE = DOT_EXECUTOR_REPORT_SOURCE_VALUE;

function wakeTriggerKeys(
  charter: DotCharter,
  deps: DotRuntimeDeps
): Array<{ key: string; detail: string }> {
  // Match + key derivation live in dot-inbox.ts so this consumer and the
  // tombstone compactor can never drift apart.
  // Streamed, no size cap; line numbers match split(/\r?\n/) index + 1 (keys unchanged).
  const rows = streamJsonLines<DotInboxEntry & { __line?: string; __index?: number }>(
    runtimePath(deps.rootDir, dotInboxPath(charter.scope)),
    {
      onMalformed: 'skip',
      map: (value, lineNumber, rawLine) => ({
        ...(value as DotInboxEntry),
        __line: rawLine,
        __index: lineNumber,
      }),
    }
  );
  const hits: Array<{ key: string; detail: string }> = [];
  for (const row of rows) {
    if (!dotInboxRowWakesCharter(row, charter)) continue;
    // Line number joins the hash so two identical rows are distinct wakes.
    hits.push({
      key: dotInboxWakeKey(row.__index as number, String(row.__line)),
      detail: String(row.__line).slice(0, 500),
    });
  }
  return hits;
}

/**
 * Ledger-backed due-ness for one dot's trigger keys. A key is consumed only
 * by a delivered or rejected ledger row owned by this dot_id; a failed key is
 * due again after {@link dotWakeBackoffMs}(n) — n consecutive failures of that
 * key, so 5 min, 10 min, 20 min … capped at 6 h; skipped keys stay due
 * immediately (the event must survive a pause/cap window).
 */
export function buildDotDueChecker(
  charter: DotCharter,
  now: Date,
  deps: DotRuntimeDeps
): (key: string) => boolean {
  const consumed = new Set<string>();
  const failures = new Map<string, { count: number; lastAt: number }>();
  for (const row of readDotWakeLedger(deps)) {
    if (row.dot_id !== charter.dot_id) continue;
    if ((row.outcome === 'delivered' && !row.trigger_retained) || row.outcome === 'rejected') {
      consumed.add(row.trigger_key);
      failures.delete(row.trigger_key);
    } else if (row.outcome === 'failed' || row.outcome === 'delivered') {
      // A retained delivery backs off like a failure, so a persistent store
      // error cannot turn the parent follow-up into a wake every sweep.
      const at = Date.parse(row.fired_at);
      const prior = failures.get(row.trigger_key);
      failures.set(row.trigger_key, {
        count: (prior?.count ?? 0) + 1,
        lastAt: Math.max(prior?.lastAt ?? 0, Number.isFinite(at) ? at : 0),
      });
    }
  }
  return (key: string): boolean => {
    if (consumed.has(key)) return false;
    const failed = failures.get(key);
    return !failed || now.getTime() - failed.lastAt >= dotWakeBackoffMs(failed.count);
  };
}

/**
 * Record a failed wake. Untenanted dots keep the full reason in the shared
 * ledger; tenant dots write only `category` there and the full reason to
 * their tenant-scoped `wake-errors.jsonl`. Returns the ledger reason.
 */
function recordDotWakeFailure(
  charter: DotCharter,
  trigger: DueDotTrigger | undefined,
  category: DotWakeFailureCategory,
  reason: string,
  deps: DotRuntimeDeps & { turns_run?: number; tokens_used?: number }
): string {
  if (classifyDotWakeReason(reason) === 'credential_grant')
    recordDotCredentialFailureInputs(charter, deps);
  if (charter.scope.tier === 'public' && !charter.scope.tenant_slug) {
    recordDotWakeOutcome(charter, trigger, 'failed', { ...deps, reason });
    return reason;
  }
  recordDotWakeOutcome(charter, trigger, 'failed', {
    ...deps,
    reason: category,
    reason_code: classifyDotWakeReason(reason),
  });
  try {
    const now = deps.now?.() ?? new Date();
    appendJsonlEnsured(
      dotWakeErrorsPath(charter),
      {
        dot_id: charter.dot_id,
        trigger_key: trigger?.key ?? `manual:${now.toISOString()}`,
        fired_at: now.toISOString(),
        category,
        reason,
      },
      deps
    );
  } catch (error) {
    logger.warn(
      `wake error log write failed for ${charter.dot_id} — ${error instanceof Error ? error.message : error} | next: the ledger still records '${category}' | evidence: ${dotWakeErrorsPath(charter)}`
    );
  }
  return category;
}

/** Default {@link DotCharter.runtime.force_wake_every_ms}: a real cron wake at least every 6 h. */
export const DOT_FORCE_WAKE_EVERY_MS_DEFAULT = 6 * 60 * 60 * 1000;
/** Most recent approval-bearing actions inspected by the idle pre-check. */
const IDLE_CHECK_MAX_APPROVALS = 50;

/**
 * Deterministic no-op pre-check for a cron wake. Returns the idle reason when
 * the model need not be called: the last real wake of this dot was delivered,
 * it is younger than `runtime.force_wake_every_ms`, and since it there is no
 * due inbox row, pending watched-file change, due follow-up, outcome
 * continuation, new dot-feedback row or approval decision on this dot's
 * requests. Any signal that cannot be read means "wake" (returns undefined).
 */
export function dotCronWakeIdleReason(
  charter: DotCharter,
  trigger: DueDotTrigger | undefined,
  deps: DotRuntimeDeps = {}
): string | undefined {
  if (trigger?.trigger.kind !== 'cron' || trigger.circuit) return undefined;
  try {
    const now = deps.now?.() ?? new Date();
    const last = readDotWakeLedger(deps)
      .filter((row) => row.dot_id === charter.dot_id && row.outcome !== 'skipped' && !row.idle_skip)
      .at(-1);
    if (!last || last.outcome !== 'delivered' || last.trigger_retained) return undefined;
    const lastAt = Date.parse(last.fired_at);
    if (!Number.isFinite(lastAt)) return undefined;
    const forceEvery = charter.runtime.force_wake_every_ms ?? DOT_FORCE_WAKE_EVERY_MS_DEFAULT;
    if (now.getTime() - lastAt >= forceEvery) return undefined;
    // fired_at marks the END of that wake; anything recorded while it ran counts as new.
    const sinceMs =
      lastAt - (charter.goal.budget?.wall_clock_ms_per_wake ?? DEFAULT_DELEGATED_WAKE_TIMEOUT_MS);

    const isDue = buildDotDueChecker(charter, now, deps);
    if (wakeTriggerKeys(charter, deps).some((hit) => isDue(hit.key))) return undefined;

    const watchState = readWatchState(deps)[charter.dot_id] ?? {};
    for (const t of charter.attention.triggers) {
      if (t.kind !== 'watch') continue;
      for (const rel of t.paths) {
        const current = confinedWatchStat(rel, deps);
        const snapshot = watchState[rel];
        if (!current && !snapshot) continue;
        if (
          !current ||
          !snapshot ||
          current.mtime_ms !== snapshot.mtime_ms ||
          current.size !== snapshot.size
        )
          return undefined;
      }
    }

    if (evaluateDotFollowupsDue(charter, { ...deps, now: () => now }).length > 0) return undefined;
    const outcome = dotOutcomeContinuation(charter, { ...deps, now: () => now });
    if (outcome && isDue(outcome.key)) return undefined;

    if (
      readDotFeedback(charter.dot_id, { ...deps, now: () => now }).some(
        (row) => !(Date.parse(row.recorded_at) < sinceMs)
      )
    )
      return undefined;

    const latest = new Map<string, string>();
    for (const row of readDotActionLedger({ rootDir: deps.rootDir, indexOnly: true })) {
      if (row.dot_id !== charter.dot_id) continue;
      latest.delete(row.action_ref);
      if (row.request_id) latest.set(row.action_ref, row.request_id);
    }
    for (const requestId of [...latest.values()].slice(-IDLE_CHECK_MAX_APPROVALS)) {
      const approval = loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, requestId);
      if (!approval) continue;
      if (approval.status === 'pending') continue;
      const decidedMs = Date.parse(approval.decidedAt ?? approval.requestedAt);
      if (!(decidedMs < sinceMs)) return undefined;
    }
    return `skipped_idle: no inbox, watch, follow-up, feedback or approval change since ${last.fired_at}`;
  } catch (error) {
    logger.debug(
      `idle pre-check unavailable for ${charter.dot_id} — ${error instanceof Error ? error.message : String(error)}; waking`
    );
    return undefined;
  }
}

/**
 * Triggers due right now for THIS dot — the synchronous kinds
 * (cron/watch/wake). Async probe triggers are evaluated separately by
 * {@link evaluateDotProbeTriggers}.
 */
export function evaluateDotTriggersDue(
  charter: DotCharter,
  deps: DotRuntimeDeps = {}
): DueDotTrigger[] {
  assertDotStateLayoutReady(charter, deps.rootDir);
  if (isFrontDeskDiagnosticDot(charter)) return [];
  const now = deps.now?.() ?? new Date();
  const isDue = buildDotDueChecker(charter, now, deps);
  const due: DueDotTrigger[] = [];
  for (const trigger of charter.attention.triggers) {
    if (trigger.kind === 'cron') {
      if (!matchesCron(trigger.cron, now, trigger.timezone)) continue;
      const key = `cron:${trigger.cron}@${minuteKey(now, trigger.timezone)}`;
      if (isDue(key)) {
        due.push({ trigger, key, detail: `cron ${trigger.cron} (${trigger.timezone ?? 'local'})` });
      }
    } else if (trigger.kind === 'watch') {
      for (const rel of trigger.paths) {
        const hit = watchTriggerKey(
          charter,
          rel,
          deps,
          trigger.ignore_jsonl_kinds,
          trigger.min_severity,
          trigger.min_interval_seconds
        );
        if (hit && isDue(hit.key)) {
          due.push({ trigger, key: hit.key, detail: hit.detail });
        }
      }
    }
  }
  // Inbox rows are scanned once: declared wake channels and accepted handoffs
  // share the lane, and a handoff-only dot declares no wake trigger at all.
  const wakeTrigger: DotTrigger = charter.attention.triggers.find(
    (t): t is Extract<DotTrigger, { kind: 'wake' }> => t.kind === 'wake'
  ) ?? { kind: 'wake', channels: ['inbox'] };
  for (const hit of wakeTriggerKeys(charter, deps)) {
    if (isDue(hit.key)) due.push({ trigger: wakeTrigger, key: hit.key, detail: hit.detail });
  }
  // Settlement can happen long after the executor's report-back wake. The
  // scoped outcome ledger itself keeps this continuation durable across a
  // supervisor crash; coalesce its visible prefix into one normal gated wake.
  const outcome = dotOutcomeContinuation(charter, { ...deps, now: () => now });
  if (outcome && isDue(outcome.key)) {
    due.push({ trigger: { kind: 'outcome' }, ...outcome });
  }
  return applyDotWakeCircuit(charter, due, deps);
}

// ---------------------------------------------------------------------------
// probe triggers — declarative external-state watches (async evaluation)
// ---------------------------------------------------------------------------

export interface DotProbeDeps extends DotRuntimeDeps {
  /** Injectable service-preset port for `service_preset` probes. */
  serviceCall?: StateProbeDeps['serviceCall'];
}

type ProbeState = Record<
  string,
  Record<
    string,
    {
      /** Write-once first observation — the fallback comparison baseline. */
      baseline_fingerprint?: string;
      /** Last evaluated fingerprint (bookkeeping only — never the 'changed' source). */
      fingerprint: string;
      evaluated_at: string;
    }
  >
>;

function readProbeState(deps: DotRuntimeDeps): ProbeState {
  const filePath = runtimePath(deps.rootDir, DOT_PROBE_STATE_PATH);
  if (!safeExistsSync(filePath)) return {};
  try {
    return parseSafeJsonObjectInput(
      safeReadFile(filePath, { encoding: 'utf8' }) as string,
      filePath
    ) as ProbeState;
  } catch {
    return {};
  }
}

function writeProbeState(state: ProbeState, deps: DotRuntimeDeps): void {
  const statePath = runtimePath(deps.rootDir, DOT_PROBE_STATE_PATH);
  safeMkdir(path.dirname(statePath), { recursive: true });
  writeJson(statePath, state);
}

/**
 * Fingerprint of the last DELIVERED/REJECTED wake for one probe spec — the
 * at-least-once comparison point for 'changed'. Trigger keys embed the
 * fingerprint (`probe:<specId>:<fp>`), so the ledger itself records which
 * observation the dot was last woken for; a crash between evaluation and
 * delivery can never hide a change, it just re-fires the same key.
 */
function lastDeliveredProbeFingerprint(
  charter: DotCharter,
  specId: string,
  deps: DotRuntimeDeps
): string | undefined {
  const prefix = `probe:${specId}:`;
  const rows = readDotWakeLedger(deps);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.dot_id !== charter.dot_id) continue;
    if (row.outcome !== 'delivered' && row.outcome !== 'rejected') continue;
    if (row.trigger_key.startsWith(prefix)) return row.trigger_key.slice(prefix.length);
  }
  return undefined;
}

/** Per-probe evaluation ceiling — a wedged service must not stall the sweep. */
const PROBE_EVAL_TIMEOUT_MS = 15_000;

/**
 * Async counterpart of {@link evaluateDotTriggersDue} for `probe` triggers.
 *
 * Per (dot, probe-spec) the state file keeps a write-once `baseline` plus the
 * last evaluated fingerprint (bookkeeping for `every_s`). A `changed`
 * expectation compares the current fingerprint against the last DELIVERED
 * fingerprint falling back to that baseline — never against the last
 * evaluation — so the gap between "observed" and "delivered" can only
 * re-fire, never lose a wake. Probe evaluation failure advances
 * `evaluated_at` but keeps the previous fingerprint, retrying next sweep
 * without burning a wake key.
 */
export async function evaluateDotProbeTriggers(
  charter: DotCharter,
  deps: DotProbeDeps = {}
): Promise<DueDotTrigger[]> {
  if (isFrontDeskDiagnosticDot(charter)) return [];
  const now = deps.now?.() ?? new Date();
  const probes = charter.attention.triggers.filter(
    (t): t is Extract<DotTrigger, { kind: 'probe' }> => t.kind === 'probe'
  );
  if (probes.length === 0) return [];
  const isDue = buildDotDueChecker(charter, now, deps);
  const all = readProbeState(deps);
  const dotState = { ...(all[charter.dot_id] ?? {}) };
  const due: DueDotTrigger[] = [];
  let stateDirty = false;
  for (const trigger of probes) {
    const specId = probeSpecId(trigger.probe);
    const prior = dotState[specId];
    if (
      prior &&
      typeof trigger.every_s === 'number' &&
      now.getTime() - Date.parse(prior.evaluated_at) < trigger.every_s * 1000
    ) {
      continue;
    }
    const previousFingerprint =
      lastDeliveredProbeFingerprint(charter, specId, deps) ?? prior?.baseline_fingerprint;
    let result;
    try {
      result = await Promise.race([
        evaluateStateProbe(trigger.probe, {
          rootDir: deps.rootDir,
          serviceCall: deps.serviceCall,
          previousFingerprint,
        }),
        new Promise<undefined>((resolve) => setTimeout(resolve, PROBE_EVAL_TIMEOUT_MS)),
      ]);
    } catch (error) {
      logger.warn(
        `[dot-probe] evaluation failed for ${charter.dot_id} (${specId}): ${error instanceof Error ? error.message : error}`
      );
      result = undefined;
    }
    dotState[specId] = {
      // Write-once: a failed evaluation must not seed the baseline, or the
      // first successful observation would fire as a spurious "change".
      baseline_fingerprint: prior?.baseline_fingerprint ?? result?.fingerprint,
      fingerprint: result?.fingerprint ?? prior?.fingerprint ?? '',
      evaluated_at: now.toISOString(),
    };
    stateDirty = true;
    if (!result?.matched) continue;
    const key = `probe:${specId}:${result.fingerprint}`;
    if (isDue(key)) {
      due.push({
        trigger,
        key,
        detail: `probe ${trigger.probe.type} matched${result.detail ? ` (${result.detail})` : ''}`,
      });
    }
  }
  if (stateDirty) writeProbeState({ ...all, [charter.dot_id]: dotState }, deps);
  return applyDotWakeCircuit(charter, due, deps);
}

export interface DotHeartbeatSpec {
  heartbeat_id: string;
  /**
   * Dots heartbeat per wake, not per sweep — staleness is the charter's own
   * `runtime.max_idle_wake_ms` so a quarter-hourly cron dot is not paged
   * between wakes. Absent → the watchdog's default staleness applies.
   */
  stale_after_ms?: number;
}

/**
 * Heartbeat ids supervised while their charter is active — the watchdog union.
 * `stale_after_ms` comes from `runtime.max_idle_wake_ms`. Malformed charters
 * are surfaced through `errors` instead of silently unsupervising every dot.
 */
export function listActiveDotHeartbeatSpecs(
  rootDir?: string,
  errors?: DotCharterLoadError[]
): DotHeartbeatSpec[] {
  try {
    return listDotCharters(rootDir, { status: 'active', errors })
      .filter((loaded) => !isFrontDeskDiagnosticDot(loaded.charter))
      .map((loaded) => ({
        heartbeat_id: loaded.charter.runtime.heartbeat_id,
        ...(loaded.charter.runtime.max_idle_wake_ms !== undefined
          ? { stale_after_ms: loaded.charter.runtime.max_idle_wake_ms }
          : {}),
      }));
  } catch {
    return [];
  }
}

/** Heartbeat ids supervised while their charter is active. */
export function listActiveDotHeartbeatIds(rootDir?: string): string[] {
  return listActiveDotHeartbeatSpecs(rootDir).map((spec) => spec.heartbeat_id);
}

export interface DotWakeReceipt {
  dot_id: string;
  outcome: DotWakeOutcome;
  reason?: string;
  result?: DotWakeLoopResult;
  /** Governed outcome of every proposal this wake produced. */
  actions?: DotActionRecord[];
  proposal_errors?: string[];
  /** Wake-tool parse/apply errors (registered DOT_WAKE_TOOLS). */
  tool_errors?: string[];
  /** Work completed, but its frozen follow-up schedule still needs persistence. */
  trigger_retained?: true;
}

function extensionFailure(kind: string, id: string, charter: DotCharter, error: unknown): void {
  const detail =
    charter.scope.tier === 'public' && !charter.scope.tenant_slug
      ? error instanceof Error
        ? error.message
        : String(error)
      : 'private diagnostic withheld';
  logger.warn(
    `${kind} '${id}' failed for ${charter.dot_id} — ${detail} | next: the wake continues without it | evidence: libs/core/dot/dot-extension-bootstrap.ts`
  );
}

/** Lines of every registered prompt section, ascending `order`; a throwing section is skipped. */
export function dotPromptSectionLines(charter: DotCharter, ctx: DotExtCtx): string[] {
  const lines: string[] = [];
  for (const section of [...DOT_PROMPT_SECTIONS].sort((a, b) => a.order - b.order)) {
    try {
      lines.push(
        ...section.lines(charter, ctx).filter((line) => typeof line === 'string' && line.trim())
      );
    } catch (error) {
      extensionFailure('prompt section', section.id, charter, error);
    }
  }
  return lines;
}

function wakeToolInstructions(mode: 'tool' | 'fence'): string[] {
  return DOT_WAKE_TOOLS.map((tool) =>
    mode === 'tool'
      ? `Tool ${tool.name} (at most ${tool.maxPerWake} per wake): ${tool.definition.description}`
      : `${tool.name} (at most ${tool.maxPerWake} per wake): ${tool.definition.description} — add a fenced block \`\`\`${tool.fence}\n[<input>, ...]\n\`\`\` whose inputs match ${JSON.stringify(tool.definition.inputSchema)}.`
  );
}

function dotSystemPrompt(
  charter: DotCharter,
  mode: 'tool' | 'fence',
  deps: DotRuntimeDeps
): string {
  const rootDir = deps.rootDir;
  const signals = dotSignalStatusLines(charter, { rootDir });
  const feedback = dotFeedbackPromptLines(charter.dot_id, { rootDir });
  const toolLines = wakeToolInstructions(mode);
  return [
    `You are the resident dot "${charter.dot_id}" (actor id dot:${charter.dot_id}).`,
    `Standing purpose: ${charter.purpose}`,
    charter.work_binding
      ? `Organization operation responsibility (context only, no additional authority): ${charter.work_binding.operation_id}`
      : '',
    dotGoalRefLabel(charter)
      ? `Organization goal you contribute to: ${dotGoalRefLabel(charter)}`
      : '',
    charter.goal.success_signals?.length
      ? `Success signals: ${charter.goal.success_signals.join('; ')}`
      : '',
    signals.length ? `Measured signal status:\n${signals.join('\n')}` : '',
    feedback.length
      ? `Recent operator feedback on your proposals (respect it):\n${feedback.join('\n')}`
      : '',
    'You are a coordinator: observe and classify, then propose. Never write outside your role scopes.',
    dotProposalInstructions(mode),
    toolLines.length ? `Other wake tools:\n${toolLines.join('\n')}` : '',
    `Your charter bounds:\n${dotBoundsPromptLines(charter, { rootDir }).join('\n')}`,
    ...dotPromptSectionLines(charter, dotExtCtx(deps)),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The per-wake objective: handle THIS trigger against the standing goal, then
 * finish. The standing goal is context, not the objective — a wake whose
 * objective is the open-ended charter goal never completes and idles through
 * `continue` turns up to its cap.
 */
export function dotWakeObjective(
  charter: DotCharter,
  mode: 'tool' | 'fence',
  trigger: DueDotTrigger | undefined
): string {
  const wakeLine = trigger
    ? `Wake trigger: ${trigger.key}${trigger.detail ? `\nDetail: ${trigger.detail}` : ''}`
    : 'Wake trigger: (none — manual wake)';
  const finish =
    mode === 'tool'
      ? 'When you have recorded what matters (memory / proposal / followup) or determined nothing needs doing, call goal_update with status "complete".'
      : 'Record what matters (memory / proposal / followup) in this single reply, or state that nothing needs doing.';
  return [
    `Objective for this wake: handle the wake trigger below against your standing goal (${charter.goal.statement}).`,
    finish,
    wakeLine,
  ].join('\n');
}

/** Full single-prompt wake (fenced / delegated path): system framing + per-wake objective. */
function wakePrompt(
  charter: DotCharter,
  mode: 'tool' | 'fence',
  trigger: DueDotTrigger | undefined,
  deps: DotRuntimeDeps
): string {
  return `${dotSystemPrompt(charter, mode, deps)}\n\n${dotWakeObjective(charter, mode, trigger)}`;
}

function governProposals(
  charter: DotCharter,
  proposals: readonly DotProposal[],
  deps: DotRuntimeDeps & { trigger?: DueDotTrigger },
  capture?: DotWakeSemanticCapture
): DotActionRecord[] {
  try {
    capture?.proposals(proposals);
  } catch {
    /* Advisory capture only. */
  }
  if (proposals.length === 0) return [];
  if (deps.dispatch) return deps.dispatch(charter, proposals);
  return dispatchDotProposals(charter, proposals, {
    rootDir: deps.rootDir,
    now: deps.now,
    operationKey: deps.trigger?.key,
  }).records;
}

/** Parsed wake-tool values collected during one wake, keyed by tool name. */
export type DotWakeToolOutputs = Record<string, unknown[]>;

/** Validate one untrusted wake-tool input into `outputs`; returns the text the model sees. */
function collectWakeToolValue(
  tool: (typeof DOT_WAKE_TOOLS)[number],
  value: unknown,
  outputs: DotWakeToolOutputs,
  errors: string[]
): string {
  const list = (outputs[tool.name] ??= []);
  if (list.length >= tool.maxPerWake) {
    errors.push(`${tool.name}: dropped (more than ${tool.maxPerWake} per wake)`);
    return `${tool.name} limit (${tool.maxPerWake}) reached for this wake.`;
  }
  let parsed: ReturnType<typeof tool.parse>;
  try {
    parsed = tool.parse(value);
  } catch (error) {
    parsed = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (parsed.ok === false) {
    errors.push(`${tool.name}: ${parsed.error}`);
    return `Rejected: ${parsed.error}`;
  }
  list.push(parsed.value);
  return 'Recorded; the runtime applies it after this wake.';
}

/** Parse every registered wake-tool fence (```<fence> JSON array or object) in a reply. */
export function parseDotWakeToolFences(text: string): {
  outputs: DotWakeToolOutputs;
  errors: string[];
} {
  const outputs: DotWakeToolOutputs = {};
  const errors: string[] = [];
  for (const tool of DOT_WAKE_TOOLS) {
    const pattern = new RegExp('```' + escapeRegExp(tool.fence) + '\\s*\\n([\\s\\S]*?)```', 'g');
    for (const match of text.matchAll(pattern)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(match[1]);
      } catch (error) {
        errors.push(
          `${tool.fence}: invalid JSON (${error instanceof Error ? error.message : error})`
        );
        continue;
      }
      for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
        collectWakeToolValue(tool, value, outputs, errors);
      }
    }
  }
  return { outputs, errors };
}

/**
 * Apply the values each registered wake tool collected during one wake.
 * Returns error strings; never throws. Wake tools apply after the wake's
 * proposals were governed (WorkItems / approvals may already exist), so a
 * persistence failure — including a durable follow-up — is recorded as a
 * receipt `tool_errors` entry and a warn, never a failed wake: failing here
 * would retry the trigger and re-spend tokens, re-dispatch the governed
 * proposals and re-apply earlier wake tools.
 */
export function applyDotWakeOutputs(
  charter: DotCharter,
  collected: DotWakeToolOutputs,
  ctx: DotExtCtx,
  /** Receives the names of tools whose apply threw (nothing was persisted for them). */
  failedTools?: Set<string>
): string[] {
  const errors: string[] = [];
  for (const tool of DOT_WAKE_TOOLS) {
    const values = collected[tool.name];
    if (!values?.length) continue;
    try {
      errors.push(...tool.apply(charter, values, ctx).map((error) => `${tool.name}: ${error}`));
    } catch (error) {
      extensionFailure('wake tool', tool.name, charter, error);
      failedTools?.add(tool.name);
      errors.push(
        `${tool.name}: apply failed (${error instanceof Error ? error.message : String(error)})`
      );
    }
  }
  return errors;
}

/** One dot must never run two wakes concurrently, whatever the trigger mix. */
const wakingDots = new Set<string>();

/**
 * One delegated turn: the child gets the fenced-proposal prompt; its fenced
 * proposals and wake-tool blocks are governed here, in this process, under
 * the charter role. The delegated child runs without the charter role (SO-03
 * strips inherited roles at the process boundary), so it can only propose.
 */
async function runFencedWake(
  current: DotCharter,
  backend: NonNullable<DotRuntimeDeps['backend']>,
  deps: DotRuntimeDeps & { trigger?: DueDotTrigger },
  labels: { ledgerReason: string; receiptReason: string },
  capture?: DotWakeSemanticCapture
): Promise<DotWakeReceipt> {
  const prompt = wakePrompt(current, 'fence', deps.trigger, deps);
  const text = await runDelegatedWake(
    current,
    backend,
    prompt,
    current.goal.budget?.wall_clock_ms_per_wake ?? DEFAULT_DELEGATED_WAKE_TIMEOUT_MS
  );
  const tokens = estimateWakeTokensFromText({ prompt, result: { text, toolCalls: [] } });
  recordDotTokenUsage(current.dot_id, tokens, deps);
  const parsed = parseDotProposalsFromText(text);
  const wakeTools = parseDotWakeToolFences(text);
  const actions = governProposals(current, parsed.proposals, deps, capture);
  const failedTools = new Set<string>();
  const toolErrors = [
    ...wakeTools.errors,
    ...applyDotWakeOutputs(current, wakeTools.outputs, dotExtCtx(deps, deps.trigger), failedTools),
  ];
  const followupRetry = followupRetryEvidence(deps.trigger, failedTools, wakeTools.outputs, deps);
  assertEventContinuationOutput(deps.eventAttemptId, toolErrors.length + parsed.errors.length);
  if (deps.trigger?.trigger.kind === 'watch') {
    recordWatchSnapshotFromKey(current, deps.trigger, deps);
  }
  recordDotWakeOutcome(current, deps.trigger, 'delivered', {
    ...deps,
    reason: `${labels.ledgerReason}; proposals ${parsed.proposals.length}`,
    turns_run: 1,
    tokens_used: tokens,
    ...followupRetry,
    // The wake ledger is a shared system-floor file: tenant prose stays out.
    summary: dotWakeSummary(text),
  });
  return {
    dot_id: current.dot_id,
    outcome: 'delivered',
    reason: labels.receiptReason,
    actions,
    ...(followupRetry.trigger_retained ? { trigger_retained: true as const } : {}),
    ...(parsed.errors.length ? { proposal_errors: parsed.errors } : {}),
    ...(toolErrors.length ? { tool_errors: toolErrors } : {}),
  };
}

/**
 * Re-read the charter's own file. A tenant charter is read in the same
 * tenant-bound runner context the loader scanned it with (dot-charter.ts); a
 * charter role need not read its own tenant's `knowledge/confidential/<slug>/dots/`.
 */

/**
 * Bounded wake: own-file reload and status/mode/role gates precede provider resolution.
 * Diagnostics durably reject model wakes without consuming executor results.
 * Generic tool loops retain their wall-clock-bounded fenced fallback.
 */
type WakeDeps = DotRuntimeDeps & { trigger?: DueDotTrigger };
export function runDotWake(loaded: LoadedDotCharter, deps: WakeDeps = {}): Promise<DotWakeReceipt> {
  return withDotWakeSemanticObserver(loaded, deps, (capture, baselineDeps) =>
    runDotWakeBaseline(loaded, baselineDeps, capture)
  );
}
async function runDotWakeBaseline(
  loaded: LoadedDotCharter,
  deps: WakeDeps,
  capture: DotWakeSemanticCapture
): Promise<DotWakeReceipt> {
  const { charter } = loaded;
  assertDotStateLayoutReady(charter, deps.rootDir);
  if (wakingDots.has(charter.dot_id)) {
    return { dot_id: charter.dot_id, outcome: 'skipped', reason: 'wake already in progress' };
  }
  wakingDots.add(charter.dot_id);
  try {
    let current: DotCharter;
    try {
      current = rereadOwnDotCharter(loaded);
      isFrontDeskDiagnosticDot(charter);
      if (current.dot_id !== charter.dot_id) {
        throw new Error(`file now declares dot_id '${current.dot_id}'`);
      }
      if (
        dotAdmissionScopeHash(current) !== dotAdmissionScopeHash(charter) ||
        eventContinuationCharterChanged(charter, current, deps.trigger)
      )
        throw new Error('charter scope or continuation binding changed since this wake was queued');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = `${DOT_WAKE_FAILURE_CATEGORY.charter} — ${message} | next: pnpm kyberion dot validate ${charter.dot_id} | evidence: ${loaded.path}`;
      logger.warn(reason);
      recordDotWakeFailure(charter, deps.trigger, DOT_WAKE_FAILURE_CATEGORY.charter, reason, deps);
      return { dot_id: charter.dot_id, outcome: 'failed', reason };
    }
    capture.charter(current); // Internal capture contains its own failure boundary.
    if (current.status !== 'active') {
      const reason = `charter status is ${current.status}, not active`;
      recordDotWakeOutcome(charter, deps.trigger, 'skipped', { ...deps, reason });
      return { dot_id: charter.dot_id, outcome: 'skipped', reason };
    }

    if (isFrontDeskDiagnosticDot(current) || isFrontDeskDiagnosticDot(charter)) {
      const reason = 'front_desk_diagnostic charters do not run model-driven wakes';
      recordDotWakeOutcome(current, deps.trigger, 'rejected', {
        ...deps,
        reason,
        turns_run: 0,
        tokens_used: 0,
      });
      return { dot_id: current.dot_id, outcome: 'rejected', reason };
    }
    const hasRole =
      deps.hasRole ?? ((role: string) => Boolean(loadAuthorityRoleIndex(deps.rootDir)[role]));
    try {
      assertDotAccountabilityCharter(current, deps);
    } catch (error) {
      const reason = `accountability authority refused: ${String(error)}`;
      recordDotWakeFailure(current, deps.trigger, DOT_WAKE_FAILURE_CATEGORY.charter, reason, deps);
      return { dot_id: current.dot_id, outcome: 'failed', reason };
    }
    let roleOk = false;
    try {
      roleOk = hasRole(current.authority.authority_role);
    } catch {
      roleOk = false;
    }
    if (!roleOk) {
      const reason = `authority_role '${current.authority.authority_role}' no longer resolves in the role registry`;
      recordDotWakeOutcome(current, deps.trigger, 'failed', { ...deps, reason });
      return { dot_id: current.dot_id, outcome: 'failed', reason };
    }

    const heartbeatOptions = deps.rootDir
      ? { rootDir: runtimePath(deps.rootDir, 'active/shared/runtime/heartbeats') }
      : {};
    // Heartbeat on every executed wake attempt (including capped/failed) so a
    // budget-paused or crashing dot stays fresh — watchdog pages only on real
    // silence, and 'error' heartbeats still prove liveness.
    recordDaemonHeartbeat(
      current.runtime.heartbeat_id,
      {
        status: 'running',
        details: { dot_id: current.dot_id, trigger: deps.trigger?.key ?? 'manual' },
      },
      heartbeatOptions
    );

    const recoveredFollowup = recoverRetainedDotFollowup(current, deps, recordDotWakeOutcome);
    if (recoveredFollowup) return recoveredFollowup;

    if (dotDailyTokenCapReached(current, deps)) {
      const reason = `token_cap_per_day ${current.goal.budget?.token_cap_per_day} reached`;
      recordDotWakeOutcome(current, deps.trigger, 'skipped', { ...deps, reason });
      return { dot_id: current.dot_id, outcome: 'skipped', reason };
    }

    try {
      const typedProposals = await buildTrustedInformationAssetWakeProposals(
        current,
        deps.trigger,
        deps.rootDir
      );
      if (typedProposals !== undefined) {
        const attemptId = claimEventContinuation(current, deps.trigger, deps);
        if (attemptId) deps = { ...deps, eventAttemptId: attemptId };
        const actions = governProposals(current, typedProposals, deps, capture);
        recordDotWakeOutcome(current, deps.trigger, 'delivered', {
          ...deps,
          reason: 'trusted information asset recipes',
          turns_run: 0,
          tokens_used: 0,
        });
        return {
          dot_id: current.dot_id,
          outcome: 'delivered',
          actions,
          reason: 'trusted information asset recipes',
        };
      }
    } catch (error) {
      const reason = 'information asset wake refused: ' + String(error);
      recordDotWakeFailure(current, deps.trigger, DOT_WAKE_FAILURE_CATEGORY.charter, reason, deps);
      return { dot_id: current.dot_id, outcome: 'failed', reason };
    }

    const idleReason = dotCronWakeIdleReason(current, deps.trigger, deps);
    if (idleReason) {
      recordDotWakeOutcome(current, deps.trigger, 'delivered', {
        ...deps,
        reason: idleReason,
        turns_run: 0,
        tokens_used: 0,
        idle_skip: true,
      });
      return { dot_id: current.dot_id, outcome: 'delivered', reason: idleReason };
    }

    const budget = current.goal.budget;
    const suspension = (deps.suspensionMonitor ?? startDotWakeSuspensionMonitor)();
    try {
      const execution = deps.resolveWakeExecution ? await deps.resolveWakeExecution(current) : deps;
      if (execution.backendUnavailable) throw new Error(execution.backendUnavailable);
      let backend = execution.backend ?? getReasoningBackend();
      if (execution.backend === undefined) {
        // execution.backend is undefined here, so `backend` came from
        // getReasoningBackend() and carries the full ReasoningBackend shape.
        const activeName = (backend as ReasoningBackend).name;
        if (
          (current.runtime.reasoning_training_use ??
            (current.scope.tier === 'public' ? 'training_eligible' : 'local_only')) ===
            'local_only' &&
          !isLocalReasoningBackend(activeName)
        ) {
          // Confidential material may not leave the host: swap to a
          // local-only backend when one is configured. Failing that, surface
          // ONE deduped actionable alert — without it the wake just dies on
          // an opaque REASONING_EGRESS_DENIED every retry.
          const local = await buildLocalOnlyWakeBackend(current);
          if (local) {
            backend = local;
          } else {
            alertDotWakeLocalBackendUnavailable(current, activeName);
            throw new Error(
              `dot wake needs a local-only reasoning backend (training_use 'local_only', tier '${current.scope.tier}') but the active backend '${activeName}' is external and no local backend is available — install/configure a local provider (ollama/mlx/lmstudio/…) or attest a no-training provider via 'pnpm onboarding llm attest'`
            );
          }
        }
      }
      const accounting_id = randomUUID();
      // Meter from the validated charter, never provider/model-supplied labels.
      const withWakeUsage = <T>(fn: () => T): T =>
        withDotWakeUsage(current, accounting_id, deps.eventAttemptId, fn, capture);
      // Only a caller-injected backend may be the stub (tests, explicit
      // `KYBERION_REASONING_BACKEND=stub`); the process-default stub would
      // record fabricated `[STUB]` text as a delivered wake.
      const realBackend = execution.backend !== undefined || !dotBackendIsUnconfiguredStub(backend);
      if (isDurableEventKey(deps.trigger?.key) && !realBackend)
        throw new Error(DOT_WAKE_BACKEND_UNAVAILABLE);
      // The claim precedes every possible provider call. A failure after it is ambiguous.
      if (realBackend) {
        const attemptId = claimEventContinuation(current, deps.trigger, deps);
        if (attemptId) deps = { ...deps, eventAttemptId: attemptId };
      }
      if (!execution.runLoop) {
        if (!realBackend) throw new Error(DOT_WAKE_BACKEND_UNAVAILABLE);
        return await withWakeUsage(() =>
          runFencedWake(
            current,
            backend,
            deps,
            {
              ledgerReason: 'delegated-turn (backend lacks generateWithTools)',
              receiptReason: 'delegated-turn',
            },
            capture
          )
        );
      }
      const runLoop = execution.runLoop;
      const proposalInputs: unknown[] = [];
      const toolOutputs: DotWakeToolOutputs = {};
      const toolErrors: string[] = [];
      // Partial-loop accounting: a loop that throws mid-wake has still spent
      // the turns that got a backend response.
      let promptsSent = 0;
      let toolCallsSeen = 0;
      let estimatedTokens = 0;
      let estimatorCalls = 0;
      let completedPromptTokens = 0;
      let lastPromptTokens = 0;
      let result: DotWakeLoopResult;
      try {
        result = await withWakeUsage(() =>
          runLoop({
            onPromptVisible: (content) => {
              // A new prompt means the previous turn completed.
              if (promptsSent > 0) completedPromptTokens += lastPromptTokens;
              promptsSent += 1;
              lastPromptTokens = estimateTokens(content);
            },
            estimateTurnTokens: (input) => {
              const tokens = estimateWakeTokensFromText(input);
              estimatorCalls += 1;
              estimatedTokens += tokens;
              return tokens;
            },
            // The system framing travels once, as systemPrompt; the objective is per-wake.
            objective: dotWakeObjective(current, 'tool', deps.trigger),
            goalId: `dot-${current.dot_id}`,
            actorId: `dot:${current.dot_id}`,
            systemPrompt: dotSystemPrompt(current, 'tool', deps),
            // A wake handles one trigger: completing once it is handled is the goal,
            // and per-turn tool outputs are already the durable result (no grace turn).
            completionMode: 'event_handler',
            budgetGraceStep: false,
            toolRole: current.authority.authority_role,
            extraTools: [
              buildDotProposeToolDefinition(),
              ...DOT_WAKE_TOOLS.map((tool) => tool.definition),
            ],
            executeTool: (call) => {
              toolCallsSeen += 1;
              if (call.name === DOT_PROPOSE_TOOL_NAME) {
                if (
                  proposalInputs.length >= loadDotExecutionPolicy().intake.max_proposals_per_wake
                ) {
                  return {
                    resultText: `Proposal limit (${loadDotExecutionPolicy().intake.max_proposals_per_wake}) reached for this wake.`,
                  };
                }
                proposalInputs.push(call.input);
                return {
                  resultText: 'Proposal recorded; the runtime governs it after this wake.',
                };
              }
              const tool = DOT_WAKE_TOOLS.find((entry) => entry.name === call.name);
              if (tool) {
                return {
                  resultText: collectWakeToolValue(tool, call.input, toolOutputs, toolErrors),
                };
              }
              return {
                resultText: `Tool ${call.name} is not available to a dot; propose instead.`,
              };
            },
            ...(deps.backend?.generateWithTools ? { backend: deps.backend } : {}),
            ...(budget?.max_turns_per_wake !== undefined
              ? { maxTurns: budget.max_turns_per_wake }
              : {}),
            ...(budget?.wall_clock_ms_per_wake !== undefined ||
            budget?.max_turns_per_wake !== undefined
              ? {
                  budget: {
                    ...(budget?.wall_clock_ms_per_wake !== undefined
                      ? { wallClockBudgetMs: budget.wall_clock_ms_per_wake }
                      : {}),
                    ...(budget?.max_turns_per_wake !== undefined
                      ? { turnBudget: budget.max_turns_per_wake }
                      : {}),
                  },
                }
              : {}),
          })
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Turns that got a backend response: every prompt but the one that
        // threw, or all of them once a tool call ran.
        const turnsCompleted = toolCallsSeen > 0 ? promptsSent : Math.max(0, promptsSent - 1);
        const partialTokens =
          estimatorCalls > 0
            ? estimatedTokens
            : completedPromptTokens + (toolCallsSeen > 0 ? lastPromptTokens : 0);
        recordDotTokenUsage(current.dot_id, partialTokens, { ...deps, accounting_id });
        const nothingCollected =
          proposalInputs.length === 0 && Object.keys(toolOutputs).length === 0;
        if (
          realBackend &&
          !deps.eventAttemptId &&
          turnsCompleted === 0 &&
          nothingCollected &&
          isDotToolBackendUnavailableError(message)
        ) {
          logger.warn(
            `tool loop unavailable for ${current.dot_id} — ${message} | next: serving this wake as a fenced delegated turn | evidence: ${DOT_WAKE_LEDGER_PATH}`
          );
          return await withWakeUsage(() =>
            runFencedWake(
              current,
              backend,
              deps,
              {
                ledgerReason: 'degraded: tool backend unavailable → fenced proposals',
                receiptReason: 'degraded-fenced',
              },
              capture
            )
          );
        }
        throw Object.assign(error instanceof Error ? error : new Error(message), {
          dotPartial: { turns_run: turnsCompleted, tokens_used: partialTokens },
        });
      }
      const tokens = result.goal.budgetStats?.tokensUsed ?? 0;
      recordDotTokenUsage(current.dot_id, tokens, { ...deps, accounting_id });
      if (deps.eventAttemptId && result.finalState !== 'complete') {
        throw new Error(
          'Durable event goal did not complete; dispatched attempt retained for operator recovery'
        );
      }
      const cancelled = wallClockCancelledReason(result);
      if (cancelled && proposalInputs.length === 0 && Object.keys(toolOutputs).length === 0) {
        throw Object.assign(new Error(cancelled), {
          dotPartial: { turns_run: Math.max(0, result.turnsRun - 1), tokens_used: tokens },
        });
      }
      const collected = collectDotProposals(proposalInputs);
      const actions = governProposals(current, collected.proposals, deps, capture);
      const failedTools = new Set<string>();
      toolErrors.push(
        ...applyDotWakeOutputs(current, toolOutputs, dotExtCtx(deps, deps.trigger), failedTools)
      );
      const followupRetry = followupRetryEvidence(deps.trigger, failedTools, toolOutputs, deps);
      assertEventContinuationOutput(
        deps.eventAttemptId,
        toolErrors.length + collected.errors.length
      );
      if (deps.trigger?.trigger.kind === 'watch') {
        recordWatchSnapshotFromKey(current, deps.trigger, deps);
      }
      recordDotWakeOutcome(current, deps.trigger, 'delivered', {
        ...deps,
        turns_run: result.turnsRun,
        tokens_used: tokens,
        ...followupRetry,
      });
      return {
        dot_id: current.dot_id,
        outcome: 'delivered',
        result,
        actions,
        ...(followupRetry.trigger_retained ? { trigger_retained: true as const } : {}),
        ...(collected.errors.length ? { proposal_errors: collected.errors } : {}),
        ...(toolErrors.length ? { tool_errors: toolErrors } : {}),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const partial = (error as { dotPartial?: { turns_run: number; tokens_used: number } })
        ?.dotPartial;
      const suspendedMs = suspension.suspendedMs();
      if (
        !deps.eventAttemptId &&
        classifyDotWakeReason(reason) === 'wall_clock_exceeded' &&
        suspendedMs > DOT_WAKE_SUSPENSION_THRESHOLD_MS
      ) {
        // The budget ran out while the host slept (macOS DarkWake / Power
        // Nap): not this dot's failure. A skipped row consumes nothing, so the
        // same trigger stays due and the next sweep retries it; the failure
        // circuits and per-key backoff never see it. A claimed durable event
        // attempt stays a failure — its provider effects are ambiguous.
        const skipReason = `${reason}; host suspended ~${Math.round(suspendedMs / 1000)}s during the wake — retried on the next sweep`;
        logger.warn(
          `wake of ${current.dot_id} ran out of wall clock while the host was suspended — not counted as a failure | next: nothing; the trigger stays due | evidence: ${DOT_WAKE_LEDGER_PATH}`
        );
        recordDotWakeOutcome(current, deps.trigger, 'skipped', {
          ...deps,
          reason:
            current.scope.tier === 'public' && !current.scope.tenant_slug
              ? skipReason
              : 'host suspended during wake',
          reason_code: 'host_suspended',
          ...(partial?.turns_run ? { turns_run: partial.turns_run } : {}),
          ...(partial?.tokens_used ? { tokens_used: partial.tokens_used } : {}),
        });
        return { dot_id: current.dot_id, outcome: 'skipped', reason: skipReason };
      }
      const category = isDotWakeProcessFailure(reason)
        ? DOT_WAKE_FAILURE_CATEGORY.backend
        : DOT_WAKE_FAILURE_CATEGORY.wake;
      const ledgerReason = recordDotWakeFailure(current, deps.trigger, category, reason, {
        ...deps,
        ...(partial?.turns_run ? { turns_run: partial.turns_run } : {}),
        ...(partial?.tokens_used ? { tokens_used: partial.tokens_used } : {}),
      });
      recordDaemonHeartbeat(
        current.runtime.heartbeat_id,
        { status: 'error', details: { dot_id: current.dot_id, error: ledgerReason } },
        heartbeatOptions
      );
      return { dot_id: current.dot_id, outcome: 'failed', reason };
    } finally {
      suspension.stop();
    }
  } finally {
    wakingDots.delete(charter.dot_id);
  }
}
