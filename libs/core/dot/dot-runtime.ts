/**
 * Dot runtime — evaluates charter attention triggers for due-ness and executes
 * one bounded goal turn per wake.
 *
 * The resident loop lives in `agent-runtime-supervisor`'s daemon sweep; this
 * module is the pure, testable core it calls. Two ledgers under
 * `active/shared/runtime/` give the loop memory:
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
import { createHash } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
} from '../secure-io.js';
import { appendJsonLine, readJsonIfPresent, readJsonLines, writeJson } from '../foundation/json.js';
import { parseSafeJsonObjectInput } from '../foundation/safe-json.js';
import { getZonedDateParts, matchesCron } from '../pipeline/cron-utils.js';
import { recordDaemonHeartbeat } from '../daemon-heartbeat.js';
import { getReasoningBackend } from '../reasoning/reasoning-backend.js';
import { sendOpsAlert, type OpsAlertInput } from '../ops-alert.js';
import type {
  ReasoningBackend,
  ToolCall,
  ToolDefinition,
} from '../reasoning/reasoning-backend-contracts.js';
import type { DelegationHandle } from '../delegated-task-observability.js';
import { loadAuthorityRoleIndex } from '../organization/authority-role-registry.js';
import { estimateTokens } from '../workforce/worker-context-compaction.js';
import {
  dotGoalRefLabel,
  listDotCharters,
  loadDotCharterSource,
  type DotCharter,
  type DotCharterLoadError,
  type DotTrigger,
  type LoadedDotCharter,
} from './dot-charter.js';
import { evaluateStateProbe, probeSpecId, type StateProbeDeps } from '../state-probe.js';
import { createLogger } from '../logger.js';
import {
  buildDotProposeToolDefinition,
  collectDotProposals,
  dotProposalInstructions,
  parseDotProposalsFromText,
  DOT_PROPOSALS_FENCE,
  DOT_PROPOSE_TOOL_NAME,
  MAX_DOT_PROPOSALS_PER_WAKE,
  type DotProposal,
} from './dot-proposals.js';
import {
  dispatchDotProposals,
  dotBoundsPromptLines,
  type DotActionRecord,
} from './dot-dispatch.js';
import { dotFeedbackPromptLines, dotSignalStatusLines } from './dot-feedback.js';
import { dotStatePath } from './dot-state-paths.js';
import { DOT_PROMPT_SECTIONS, DOT_WAKE_TOOLS } from './dot-extension-registry.js';
import type { DotExtCtx } from './dot-extensions.js';
import {
  dotBackendIsUnconfiguredStub,
  isDotToolBackendUnavailableError,
  DOT_WAKE_BACKEND_UNAVAILABLE,
} from './dot-wake-backend.js';

const logger = createLogger('dot-runtime');

export const DOT_WAKE_LEDGER_PATH = 'active/shared/runtime/dot-wake-ledger.jsonl';
export const DOT_TOKEN_USAGE_PATH = 'active/shared/runtime/dot-token-usage.jsonl';
export const DOT_WATCH_STATE_PATH = 'active/shared/runtime/dot-watch-state.json';
export const DOT_PROBE_STATE_PATH = 'active/shared/runtime/dot-probe-state.json';
export { DOT_INBOX_PATH } from './dot-inbox.js';
import { DOT_INBOX_PATH } from './dot-inbox.js';

/** A failed wake is retried no sooner than this (per trigger key); doubles per consecutive failure. */
export const DOT_WAKE_RETRY_AFTER_MS = 5 * 60 * 1000;
/** Ceiling of the per-key / per-dot exponential backoff. */
export const DOT_WAKE_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
/** Consecutive same-reason failures that open a dot's wake circuit. */
export const DOT_WAKE_CIRCUIT_THRESHOLD = 5;

/** `min(5min * 2^(n-1), 6h)` for the n-th consecutive failure (n >= 1). */
export function dotWakeBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const exponent = Math.min(consecutiveFailures - 1, 30);
  return Math.min(DOT_WAKE_RETRY_AFTER_MS * 2 ** exponent, DOT_WAKE_MAX_BACKOFF_MS);
}
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
  systemPrompt?: string;
  toolRole?: string;
  maxTurns?: number;
  budget?: {
    wallClockBudgetMs?: number;
    turnBudget?: number;
  };
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
  goal: { budgetStats?: { tokensUsed?: number } };
}

/** Same ~3-chars/token heuristic as the goal driver; governance-grade only. */
function estimateWakeTokensFromText(input: {
  prompt: string;
  result: { text?: string; toolCalls?: Array<{ name: string; input: unknown }> };
}): number {
  const responseText = [
    input.result.text ?? '',
    ...(input.result.toolCalls ?? []).map((call) => `${call.name} ${JSON.stringify(call.input)}`),
  ].join(' ');
  return estimateTokens(input.prompt) + estimateTokens(responseText);
}

export type DotWakeOutcome = 'delivered' | 'skipped' | 'failed' | 'rejected';

/** Runtime-only trigger kinds beyond the charter's declared ones. */
export type DotWakeTrigger = DotTrigger | { kind: 'followup' };

export interface DotWakeLedgerEntry {
  dot_id: string;
  trigger_key: string;
  kind: DotWakeTrigger['kind'] | 'manual';
  fired_at: string;
  outcome: DotWakeOutcome;
  reason?: string;
  turns_run?: number;
  tokens_used?: number;
  /** The dot's own words (proposal block removed), so "why did it propose nothing?" is answerable. */
  summary?: string;
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

export interface DotTokenUsageEntry {
  dot_id: string;
  /** UTC day bucket (YYYY-MM-DD) the tokens accrue to. */
  day: string;
  tokens: number;
  recorded_at: string;
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
}

export interface DotRuntimeDeps {
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
  /** Ops-alert port for the wake circuit; defaults to {@link sendOpsAlert}. */
  opsAlert?: (input: OpsAlertInput) => void;
  /**
   * Set by orchestration when backend resolution found nothing real to run
   * (unconfigured stub). The wake records a failed row with this reason
   * instead of fabricating a delivery.
   */
  backendUnavailable?: string;
}

function runtimePath(rootDir: string | undefined, rel: string): string {
  return path.join(rootDir ?? pathResolver.rootDir(), rel);
}

export function readDotWakeLedger(deps: DotRuntimeDeps = {}): DotWakeLedgerEntry[] {
  return readJsonLines<DotWakeLedgerEntry>(runtimePath(deps.rootDir, DOT_WAKE_LEDGER_PATH), {
    onMalformed: 'skip',
  }).filter((row) => typeof row?.dot_id === 'string' && typeof row?.trigger_key === 'string');
}

function appendJsonlEnsured(rel: string, value: unknown, deps: DotRuntimeDeps): void {
  const filePath = runtimePath(deps.rootDir, rel);
  safeMkdir(path.dirname(filePath), { recursive: true });
  appendJsonLine(filePath, value);
}

/**
 * Append a wake-ledger row. 'skipped' rows are written at most once per
 * trigger key — they are an audit marker, not a consumption record.
 */
export function recordDotWakeOutcome(
  charter: DotCharter,
  trigger: DueDotTrigger | undefined,
  outcome: DotWakeOutcome,
  deps: DotRuntimeDeps & {
    reason?: string;
    turns_run?: number;
    tokens_used?: number;
    summary?: string;
  } = {}
): void {
  const now = deps.now?.() ?? new Date();
  const key = trigger?.key ?? `manual:${now.toISOString()}`;
  if (outcome === 'skipped') {
    const already = readDotWakeLedger(deps).some(
      (row) => row.dot_id === charter.dot_id && row.trigger_key === key && row.outcome === 'skipped'
    );
    if (already) return;
  }
  appendJsonlEnsured(
    DOT_WAKE_LEDGER_PATH,
    {
      dot_id: charter.dot_id,
      trigger_key: key,
      kind: trigger?.trigger.kind ?? 'manual',
      fired_at: now.toISOString(),
      outcome,
      ...(deps.reason ? { reason: deps.reason } : {}),
      ...(deps.turns_run !== undefined ? { turns_run: deps.turns_run } : {}),
      ...(deps.tokens_used !== undefined ? { tokens_used: deps.tokens_used } : {}),
      ...(deps.summary ? { summary: deps.summary } : {}),
    } satisfies DotWakeLedgerEntry,
    deps
  );
}

export function recordDotTokenUsage(
  dotId: string,
  tokens: number,
  deps: DotRuntimeDeps = {}
): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const now = deps.now?.() ?? new Date();
  appendJsonlEnsured(
    DOT_TOKEN_USAGE_PATH,
    {
      dot_id: dotId,
      day: now.toISOString().slice(0, 10),
      tokens,
      recorded_at: now.toISOString(),
    } satisfies DotTokenUsageEntry,
    deps
  );
}

/** Tokens accrued by this dot today (UTC day bucket), across all processes. */
export function dotTokensUsedToday(dotId: string, deps: DotRuntimeDeps = {}): number {
  const day = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  return readJsonLines<DotTokenUsageEntry>(runtimePath(deps.rootDir, DOT_TOKEN_USAGE_PATH), {
    onMalformed: 'skip',
  })
    .filter((row) => row?.dot_id === dotId && row?.day === day)
    .reduce((sum, row) => sum + (Number(row.tokens) || 0), 0);
}

/** Daily token cap check: true when the charter caps tokens and the cap is hit. */
export function dotDailyTokenCapReached(charter: DotCharter, deps: DotRuntimeDeps = {}): boolean {
  const cap = charter.goal.budget?.token_cap_per_day;
  if (cap === undefined) return false;
  return dotTokensUsedToday(charter.dot_id, deps) >= cap;
}

type WatchState = Record<string, Record<string, { mtime_ms: number; size: number }>>;

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
      if (current) dotState[rel] = current;
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
        [rel]: { mtime_ms: Number(mtime), size: Number(size) },
      },
    },
    deps
  );
}

function minuteKey(date: Date, timezone?: string): string {
  const parts = getZonedDateParts(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function watchTriggerKey(charter: DotCharter, rel: string, deps: DotRuntimeDeps): string | null {
  const current = confinedWatchStat(rel, deps);
  if (!current) return null;
  const snapshot = readWatchState(deps)[charter.dot_id]?.[rel];
  if (snapshot && snapshot.mtime_ms === current.mtime_ms && snapshot.size === current.size) {
    return null;
  }
  return `watch:${rel}@${Math.round(current.mtime_ms)}:${current.size}`;
}

/** `payload.report_from` of an executor report-back inbox row (DL-01). */
export const DOT_EXECUTOR_REPORT_SOURCE = 'dot-executor';

function wakeTriggerKeys(
  charter: DotCharter,
  deps: DotRuntimeDeps
): Array<{ key: string; detail: string }> {
  const declaredChannels = charter.attention.triggers
    .filter((t): t is Extract<DotTrigger, { kind: 'wake' }> => t.kind === 'wake')
    .flatMap((t) => t.channels);
  const handoffSources = charter.team?.accepts_handoffs_from ?? [];
  // No early return: every dot hears its own executor's report-backs, even
  // one that declares no wake channel and accepts no handoffs.
  const rows = readJsonLines<DotInboxEntry & { __line?: string; __index?: number }>(
    runtimePath(deps.rootDir, DOT_INBOX_PATH),
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
    const payload =
      row.payload && typeof row.payload === 'object'
        ? (row.payload as Record<string, unknown>)
        : undefined;
    const handoffFrom = payload?.handoff_from;
    // A handoff wakes its target only from a dot the target accepts; the
    // dot's own executor reporting a finished WorkItem always wakes it.
    const addressed =
      row.dot_id === charter.dot_id &&
      (typeof handoffFrom === 'string'
        ? handoffSources.includes(handoffFrom)
        : payload?.report_from === DOT_EXECUTOR_REPORT_SOURCE || declaredChannels.length > 0);
    const channelHit =
      !row.dot_id && typeof row.channel === 'string' && declaredChannels.includes(row.channel);
    if (!addressed && !channelHit) continue;
    // Line number joins the hash so two identical rows are distinct wakes.
    const key = `wake:${createHash('sha256')
      .update(`${row.__index}:${String(row.__line)}`)
      .digest('hex')
      .slice(0, 16)}`;
    hits.push({ key, detail: String(row.__line).slice(0, 500) });
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
    if (row.outcome === 'delivered' || row.outcome === 'rejected') {
      consumed.add(row.trigger_key);
      failures.delete(row.trigger_key);
    } else if (row.outcome === 'failed') {
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
 * Category-only failure reasons. Tenant dots write only these to the shared
 * system-floor wake ledger and heartbeat; the full message goes to the
 * tenant-scoped `wake-errors.jsonl` ({@link dotWakeErrorsPath}).
 */
export const DOT_WAKE_FAILURE_CATEGORY = {
  charter: 'charter unreadable',
  backend: 'backend unavailable',
  wake: 'wake failed',
} as const;
export type DotWakeFailureCategory =
  (typeof DOT_WAKE_FAILURE_CATEGORY)[keyof typeof DOT_WAKE_FAILURE_CATEGORY];

/**
 * Backend / process-level failure (no real backend, no tool-capable
 * candidate, failover chain exhausted): not this dot's fault, so it never
 * counts toward the per-dot wake circuit — a healthy dot resumes as soon as
 * the backend recovers instead of being held for the circuit's backoff.
 */
export function isDotWakeProcessFailure(reason: string | undefined): boolean {
  if (!reason) return false;
  if (reason === DOT_WAKE_FAILURE_CATEGORY.backend) return true;
  return /no real reasoning backend|lacks generateWithTools|failed across \d+ candidate|has no tool-capable backend/.test(
    reason
  );
}

/** Tenant-scoped full-text wake error log for a dot. */
export function dotWakeErrorsPath(charter: DotCharter): string {
  return dotStatePath(charter, 'wake-errors.jsonl');
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
  if (!charter.scope.tenant_slug) {
    recordDotWakeOutcome(charter, trigger, 'failed', { ...deps, reason });
    return reason;
  }
  recordDotWakeOutcome(charter, trigger, 'failed', { ...deps, reason: category });
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

/** Digits and hex runs stripped, so "same failure, different id/mtime" is one reason. */
export function normalizeDotWakeReason(reason: string | undefined): string {
  return String(reason ?? '')
    .replace(/\b[0-9a-f]{6,}\b/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export interface DotWakeCircuitState {
  /** Trailing failed wakes of this dot sharing one normalized reason. */
  consecutive: number;
  /** consecutive >= DOT_WAKE_CIRCUIT_THRESHOLD. */
  tripped: boolean;
  /** Tripped and still inside the backoff window — every due trigger is held. */
  open: boolean;
  reason?: string;
  reason_hash?: string;
  last_failed_at?: string;
  streak_started_at?: string;
  /** When a single half-open probe wake is allowed again. */
  reopens_at?: string;
}

/**
 * Per-dot wake circuit: the last {@link DOT_WAKE_CIRCUIT_THRESHOLD} wake
 * attempts (skipped audit markers and backend/process-level failures
 * ignored — see {@link isDotWakeProcessFailure}) all failed with the same
 * normalized reason → hold every trigger until `lastFailedAt + backoff(n)`.
 * This is what stops rotating keys (`watch:<file>@<mtime>`) from defeating
 * the per-key backoff and flooding the ledger with one failure per change.
 */
export function evaluateDotWakeCircuit(
  charter: DotCharter,
  deps: DotRuntimeDeps = {}
): DotWakeCircuitState {
  const now = (deps.now?.() ?? new Date()).getTime();
  // Skipped audit markers and backend/process-level failures are transparent:
  // they neither extend nor break a dot's own failure streak.
  const rows = readDotWakeLedger(deps).filter(
    (row) =>
      row.dot_id === charter.dot_id &&
      row.outcome !== 'skipped' &&
      !(row.outcome === 'failed' && isDotWakeProcessFailure(row.reason))
  );
  const last = rows.at(-1);
  if (!last || last.outcome !== 'failed') return { consecutive: 0, tripped: false, open: false };
  const reason = normalizeDotWakeReason(last.reason);
  let consecutive = 0;
  let streakStart = last;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.outcome !== 'failed' || normalizeDotWakeReason(row.reason) !== reason) break;
    consecutive += 1;
    streakStart = row;
  }
  const tripped = consecutive >= DOT_WAKE_CIRCUIT_THRESHOLD;
  const lastAt = Date.parse(last.fired_at);
  const reopensAt = (Number.isFinite(lastAt) ? lastAt : now) + dotWakeBackoffMs(consecutive);
  return {
    consecutive,
    tripped,
    open: tripped && now < reopensAt,
    reason,
    reason_hash: createHash('sha256').update(reason).digest('hex').slice(0, 12),
    last_failed_at: last.fired_at,
    streak_started_at: streakStart.fired_at,
    ...(tripped ? { reopens_at: new Date(reopensAt).toISOString() } : {}),
  };
}

interface DotWakeCircuitMarker {
  dot_id: string;
  opening_id: string;
  alerted_at: string;
}

function circuitMarkerPath(charter: DotCharter, deps: DotRuntimeDeps): string {
  return runtimePath(deps.rootDir, dotStatePath(charter, 'wake-circuit', `${charter.dot_id}.json`));
}

/** One ops alert per circuit opening, durable across daemon restarts. */
function alertDotWakeCircuitOnce(
  charter: DotCharter,
  circuit: DotWakeCircuitState,
  deps: DotRuntimeDeps
): void {
  const openingId = `${circuit.reason_hash}@${circuit.streak_started_at}`;
  const markerPath = circuitMarkerPath(charter, deps);
  try {
    const marker = readJsonIfPresent<DotWakeCircuitMarker>(markerPath);
    if (marker?.opening_id === openingId) return;
    const alert =
      deps.opsAlert ??
      ((input: OpsAlertInput) =>
        void sendOpsAlert(
          input,
          deps.rootDir
            ? {
                alertLogPath: runtimePath(
                  deps.rootDir,
                  'active/shared/observability/ops-alerts.jsonl'
                ),
              }
            : {}
        ));
    alert({
      severity: 'warning',
      title: `Dot wake circuit open: ${charter.dot_id}`,
      context: {
        dot_id: charter.dot_id,
        consecutive_failures: circuit.consecutive,
        reopens_at: circuit.reopens_at,
        // Tenant dots keep failure prose out of the shared alert log.
        ...(charter.scope.tenant_slug ? {} : { reason: circuit.reason }),
      },
      recommendation: `Wakes for ${charter.dot_id} are held until ${circuit.reopens_at}. Inspect \`pnpm kyberion dot status ${charter.dot_id}\` and the wake ledger, fix the cause, then the next half-open wake closes the circuit.`,
      dedupe_key: `dot-wake-circuit:${charter.dot_id}:${circuit.reason_hash}`,
      category: 'dot',
    });
    safeMkdir(path.dirname(markerPath), { recursive: true });
    writeJson(markerPath, {
      dot_id: charter.dot_id,
      opening_id: openingId,
      alerted_at: (deps.now?.() ?? new Date()).toISOString(),
    } satisfies DotWakeCircuitMarker);
    logger.warn(
      `wake circuit open for ${charter.dot_id} — ${circuit.consecutive} consecutive failures with one reason | next: fix the cause; one probe wake runs at ${circuit.reopens_at} | evidence: ${DOT_WAKE_LEDGER_PATH}`
    );
  } catch (error) {
    logger.warn(
      `wake circuit alert failed for ${charter.dot_id} — ${error instanceof Error ? error.message : error} | next: wakes stay held regardless | evidence: ${markerPath}`
    );
  }
}

/**
 * Apply the dot's wake circuit to a due list: open → nothing is due (one ops
 * alert per opening); tripped but past the window → only the first trigger
 * runs, marked `circuit: true` (half-open probe); closed → unchanged.
 * Idempotent, so callers that concatenate several due lists re-apply it.
 */
export function applyDotWakeCircuit(
  charter: DotCharter,
  due: DueDotTrigger[],
  deps: DotRuntimeDeps = {}
): DueDotTrigger[] {
  if (due.length === 0) return due;
  const circuit = evaluateDotWakeCircuit(charter, deps);
  if (!circuit.tripped) return due;
  alertDotWakeCircuitOnce(charter, circuit, deps);
  if (circuit.open) return [];
  return [{ ...due[0], circuit: true }];
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
        const key = watchTriggerKey(charter, rel, deps);
        if (key && isDue(key)) {
          due.push({ trigger, key, detail: `watch ${rel} changed` });
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
    return listDotCharters(rootDir, { status: 'active', errors }).map((loaded) => ({
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
}

function dotExtCtx(deps: DotRuntimeDeps): DotExtCtx {
  return { rootDir: deps.rootDir, now: deps.now ?? (() => new Date()) };
}

function extensionFailure(kind: string, id: string, dotId: string, error: unknown): void {
  logger.warn(
    `${kind} '${id}' failed for ${dotId} — ${error instanceof Error ? error.message : String(error)} | next: the wake continues without it | evidence: libs/core/dot/dot-extension-registry.ts`
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
      extensionFailure('prompt section', section.id, charter.dot_id, error);
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

function wakePrompt(
  charter: DotCharter,
  mode: 'tool' | 'fence',
  trigger: DueDotTrigger | undefined,
  deps: DotRuntimeDeps
): string {
  const wakeLine = trigger
    ? `\n\nWake trigger: ${trigger.key}${trigger.detail ? `\nDetail: ${trigger.detail}` : ''}`
    : '';
  return `${dotSystemPrompt(charter, mode, deps)}\n\nObjective: ${charter.goal.statement}${wakeLine}`;
}

function governProposals(
  charter: DotCharter,
  proposals: readonly DotProposal[],
  deps: DotRuntimeDeps
): DotActionRecord[] {
  if (proposals.length === 0) return [];
  if (deps.dispatch) return deps.dispatch(charter, proposals);
  return dispatchDotProposals(charter, proposals, { rootDir: deps.rootDir, now: deps.now }).records;
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
 * Returns the error strings (prefixed by tool name); a throwing tool never
 * fails the wake.
 */
export function applyDotWakeOutputs(
  charter: DotCharter,
  collected: DotWakeToolOutputs,
  ctx: DotExtCtx
): string[] {
  const errors: string[] = [];
  for (const tool of DOT_WAKE_TOOLS) {
    const values = collected[tool.name];
    if (!values?.length) continue;
    try {
      errors.push(...tool.apply(charter, values, ctx).map((error) => `${tool.name}: ${error}`));
    } catch (error) {
      extensionFailure('wake tool', tool.name, charter.dot_id, error);
      errors.push(
        `${tool.name}: apply failed (${error instanceof Error ? error.message : String(error)})`
      );
    }
  }
  return errors;
}

/** One dot must never run two wakes concurrently, whatever the trigger mix. */
const wakingDots = new Set<string>();

async function runDelegatedWake(
  charter: DotCharter,
  backend: NonNullable<DotRuntimeDeps['backend']>,
  prompt: string,
  timeoutMs: number
): Promise<string> {
  if (backend.delegateTaskHandle) {
    const handle: DelegationHandle = backend.delegateTaskHandle(prompt, undefined);
    return await Promise.race([
      handle.join(),
      new Promise<string>((_resolve, reject) =>
        setTimeout(() => {
          void handle.cancel(`wall_clock budget ${timeoutMs}ms exceeded`).catch(() => {});
          reject(new Error(`delegated wake exceeded wall_clock budget ${timeoutMs}ms`));
        }, timeoutMs).unref?.()
      ),
    ]);
  }
  return await Promise.race([
    backend.delegateTask(prompt, undefined),
    new Promise<string>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`delegated wake exceeded wall_clock budget ${timeoutMs}ms`)),
        timeoutMs
      ).unref?.()
    ),
  ]);
}

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
  labels: { ledgerReason: string; receiptReason: string }
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
  const actions = governProposals(current, parsed.proposals, deps);
  const toolErrors = [
    ...wakeTools.errors,
    ...applyDotWakeOutputs(current, wakeTools.outputs, dotExtCtx(deps)),
  ];
  if (deps.trigger?.trigger.kind === 'watch') {
    recordWatchSnapshotFromKey(current, deps.trigger, deps);
  }
  recordDotWakeOutcome(current, deps.trigger, 'delivered', {
    ...deps,
    reason: `${labels.ledgerReason}; proposals ${parsed.proposals.length}`,
    turns_run: 1,
    tokens_used: tokens,
    // The wake ledger is a shared system-floor file: tenant prose stays out.
    ...(current.scope.tenant_slug ? {} : { summary: dotWakeSummary(text) }),
  });
  return {
    dot_id: current.dot_id,
    outcome: 'delivered',
    reason: labels.receiptReason,
    actions,
    ...(parsed.errors.length ? { proposal_errors: parsed.errors } : {}),
    ...(toolErrors.length ? { tool_errors: toolErrors } : {}),
  };
}

/**
 * Re-read the charter's own file. A tenant charter is read in the same
 * tenant-bound runner context the loader scanned it with (dot-charter.ts); a
 * charter role need not read its own tenant's `knowledge/confidential/<slug>/dots/`.
 */
function rereadOwnCharter(loaded: LoadedDotCharter): DotCharter {
  const normalized = loaded.path.split(path.sep).join('/');
  // The directory binds a tenant charter (loadDotCharterSource reads it in
  // that tenant's context and rejects a scope that names another tenant).
  const dirTenant = normalized.match(/(?:^|\/)knowledge\/confidential\/([^/]+)\/dots\/[^/]+$/)?.[1];
  return loadDotCharterSource({
    path: loaded.path,
    ...(dirTenant ? { tenant_slug: dirTenant } : {}),
  });
}

/**
 * Execute one wake for a charter: per-dot re-entrancy guard → re-read of the
 * charter's OWN file (a sibling's bad JSON never blocks this dot; an
 * unreadable own file is a failed wake carrying the real error) → status
 * re-check (a charter paused between evaluation and delivery must not run) →
 * role re-validation (an already-active charter whose role vanished must not
 * run — the activation gate only fires on transitions) → heartbeat → daily
 * token cap → bounded goal turn (runGoalDrivenLoop under toolRole + KD-02
 * budgets), or one fenced delegateTask turn bounded by wall_clock when the
 * backend cannot drive tools — including a tool loop that finds no live tool
 * candidate, which degrades to the fenced turn inside the same wake. A
 * process holding only the unconfigured stub fails the wake instead of
 * recording `[STUB]` text as a delivery.
 */
export async function runDotWake(
  loaded: LoadedDotCharter,
  deps: DotRuntimeDeps & { trigger?: DueDotTrigger } = {}
): Promise<DotWakeReceipt> {
  const { charter } = loaded;
  if (wakingDots.has(charter.dot_id)) {
    return { dot_id: charter.dot_id, outcome: 'skipped', reason: 'wake already in progress' };
  }
  wakingDots.add(charter.dot_id);
  try {
    let current: DotCharter;
    try {
      current = rereadOwnCharter(loaded);
      if (current.dot_id !== charter.dot_id) {
        throw new Error(`file now declares dot_id '${current.dot_id}'`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = `${DOT_WAKE_FAILURE_CATEGORY.charter} — ${message} | next: pnpm kyberion dot validate ${charter.dot_id} | evidence: ${loaded.path}`;
      logger.warn(reason);
      recordDotWakeFailure(charter, deps.trigger, DOT_WAKE_FAILURE_CATEGORY.charter, reason, deps);
      return { dot_id: charter.dot_id, outcome: 'failed', reason };
    }
    if (current.status !== 'active') {
      const reason = `charter status is ${current.status}, not active`;
      recordDotWakeOutcome(charter, deps.trigger, 'skipped', { ...deps, reason });
      return { dot_id: charter.dot_id, outcome: 'skipped', reason };
    }

    const hasRole =
      deps.hasRole ?? ((role: string) => Boolean(loadAuthorityRoleIndex(deps.rootDir)[role]));
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

    if (dotDailyTokenCapReached(current, deps)) {
      const reason = `token_cap_per_day ${current.goal.budget?.token_cap_per_day} reached`;
      recordDotWakeOutcome(current, deps.trigger, 'skipped', { ...deps, reason });
      return { dot_id: current.dot_id, outcome: 'skipped', reason };
    }

    const budget = current.goal.budget;
    try {
      if (deps.backendUnavailable) throw new Error(deps.backendUnavailable);
      const backend = deps.backend ?? getReasoningBackend();
      // Only a caller-injected backend may be the stub (tests, explicit
      // `KYBERION_REASONING_BACKEND=stub`); the process-default stub would
      // record fabricated `[STUB]` text as a delivered wake.
      const realBackend = deps.backend !== undefined || !dotBackendIsUnconfiguredStub(backend);
      if (!deps.runLoop) {
        if (!realBackend) throw new Error(DOT_WAKE_BACKEND_UNAVAILABLE);
        return await runFencedWake(current, backend, deps, {
          ledgerReason: 'delegated-turn (backend lacks generateWithTools)',
          receiptReason: 'delegated-turn',
        });
      }
      const runLoop = deps.runLoop;
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
        result = await runLoop({
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
          objective: wakePrompt(current, 'tool', deps.trigger, deps),
          goalId: `dot-${current.dot_id}`,
          systemPrompt: dotSystemPrompt(current, 'tool', deps),
          toolRole: current.authority.authority_role,
          extraTools: [
            buildDotProposeToolDefinition(),
            ...DOT_WAKE_TOOLS.map((tool) => tool.definition),
          ],
          executeTool: (call) => {
            toolCallsSeen += 1;
            if (call.name === DOT_PROPOSE_TOOL_NAME) {
              if (proposalInputs.length >= MAX_DOT_PROPOSALS_PER_WAKE) {
                return {
                  resultText: `Proposal limit (${MAX_DOT_PROPOSALS_PER_WAKE}) reached for this wake.`,
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
            return { resultText: `Tool ${call.name} is not available to a dot; propose instead.` };
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
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Turns that got a backend response: every prompt but the one that
        // threw, or all of them once a tool call ran.
        const turnsCompleted = toolCallsSeen > 0 ? promptsSent : Math.max(0, promptsSent - 1);
        const partialTokens =
          estimatorCalls > 0
            ? estimatedTokens
            : completedPromptTokens + (toolCallsSeen > 0 ? lastPromptTokens : 0);
        recordDotTokenUsage(current.dot_id, partialTokens, deps);
        const nothingCollected =
          proposalInputs.length === 0 && Object.keys(toolOutputs).length === 0;
        if (
          realBackend &&
          turnsCompleted === 0 &&
          nothingCollected &&
          isDotToolBackendUnavailableError(message)
        ) {
          logger.warn(
            `tool loop unavailable for ${current.dot_id} — ${message} | next: serving this wake as a fenced delegated turn | evidence: ${DOT_WAKE_LEDGER_PATH}`
          );
          return await runFencedWake(current, backend, deps, {
            ledgerReason: 'degraded: tool backend unavailable → fenced proposals',
            receiptReason: 'degraded-fenced',
          });
        }
        throw Object.assign(error instanceof Error ? error : new Error(message), {
          dotPartial: { turns_run: turnsCompleted, tokens_used: partialTokens },
        });
      }
      const tokens = result.goal.budgetStats?.tokensUsed ?? 0;
      recordDotTokenUsage(current.dot_id, tokens, deps);
      const collected = collectDotProposals(proposalInputs);
      const actions = governProposals(current, collected.proposals, deps);
      toolErrors.push(...applyDotWakeOutputs(current, toolOutputs, dotExtCtx(deps)));
      if (deps.trigger?.trigger.kind === 'watch') {
        recordWatchSnapshotFromKey(current, deps.trigger, deps);
      }
      recordDotWakeOutcome(current, deps.trigger, 'delivered', {
        ...deps,
        turns_run: result.turnsRun,
        tokens_used: tokens,
      });
      return {
        dot_id: current.dot_id,
        outcome: 'delivered',
        result,
        actions,
        ...(collected.errors.length ? { proposal_errors: collected.errors } : {}),
        ...(toolErrors.length ? { tool_errors: toolErrors } : {}),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const partial = (error as { dotPartial?: { turns_run: number; tokens_used: number } })
        ?.dotPartial;
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
    }
  } finally {
    wakingDots.delete(charter.dot_id);
  }
}
