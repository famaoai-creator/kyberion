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
import { appendJsonLine, readJsonLines, writeJson } from '../foundation/json.js';
import { parseSafeJsonObjectInput } from '../foundation/safe-json.js';
import { getZonedDateParts, matchesCron } from '../pipeline/cron-utils.js';
import { recordDaemonHeartbeat } from '../daemon-heartbeat.js';
import { getReasoningBackend } from '../reasoning/reasoning-backend.js';
import type {
  ReasoningBackend,
  ToolCall,
  ToolDefinition,
} from '../reasoning/reasoning-backend-contracts.js';
import type { DelegationHandle } from '../delegated-task-observability.js';
import { loadAuthorityRoleIndex } from '../organization/authority-role-registry.js';
import { estimateTokens } from '../workforce/worker-context-compaction.js';
import {
  listDotCharters,
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

const logger = createLogger('dot-runtime');

export const DOT_WAKE_LEDGER_PATH = 'active/shared/runtime/dot-wake-ledger.jsonl';
export const DOT_TOKEN_USAGE_PATH = 'active/shared/runtime/dot-token-usage.jsonl';
export const DOT_WATCH_STATE_PATH = 'active/shared/runtime/dot-watch-state.json';
export const DOT_PROBE_STATE_PATH = 'active/shared/runtime/dot-probe-state.json';
export { DOT_INBOX_PATH } from './dot-inbox.js';
import { DOT_INBOX_PATH } from './dot-inbox.js';

/** A failed wake is retried no sooner than this (per trigger key). */
export const DOT_WAKE_RETRY_AFTER_MS = 5 * 60 * 1000;
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
  /** The proposal tool — the only effectful tool a dot is given. */
  extraTools?: ToolDefinition[];
  executeTool?: (call: ToolCall) => { resultText: string };
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

export interface DotWakeLedgerEntry {
  dot_id: string;
  trigger_key: string;
  kind: DotTrigger['kind'] | 'manual';
  fired_at: string;
  outcome: DotWakeOutcome;
  reason?: string;
  turns_run?: number;
  tokens_used?: number;
  /** The dot's own words (proposal block removed), so "why did it propose nothing?" is answerable. */
  summary?: string;
}

/** Max characters of the dot's reply kept in the wake ledger. */
export const DOT_WAKE_SUMMARY_MAX = 600;

/** Reply text minus the fenced proposal block, whitespace-collapsed and bounded. */
export function dotWakeSummary(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const prose = text
    .replace(new RegExp('```' + DOT_PROPOSALS_FENCE + '[\\s\\S]*?```', 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  trigger: DotTrigger;
  /** Stable dedup key; also used as the TriggerRunner idempotency key suffix. */
  key: string;
  /** Context the wake's goal turn should see (watched path / inbox row). */
  detail?: string;
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

function wakeTriggerKeys(
  charter: DotCharter,
  deps: DotRuntimeDeps
): Array<{ key: string; detail: string }> {
  const declaredChannels = charter.attention.triggers
    .filter((t): t is Extract<DotTrigger, { kind: 'wake' }> => t.kind === 'wake')
    .flatMap((t) => t.channels);
  const handoffSources = charter.team?.accepts_handoffs_from ?? [];
  if (declaredChannels.length === 0 && handoffSources.length === 0) return [];
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
    const handoffFrom =
      row.payload && typeof row.payload === 'object'
        ? (row.payload as Record<string, unknown>).handoff_from
        : undefined;
    // A handoff wakes its target only from a dot the target accepts.
    const addressed =
      row.dot_id === charter.dot_id &&
      (typeof handoffFrom === 'string'
        ? handoffSources.includes(handoffFrom)
        : declaredChannels.length > 0);
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
 * by a delivered or rejected ledger row owned by this dot_id; failed keys
 * become due again after DOT_WAKE_RETRY_AFTER_MS; skipped keys stay due
 * immediately (the event must survive a pause/cap window).
 */
function buildDotDueChecker(charter: DotCharter, now: Date, deps: DotRuntimeDeps) {
  const consumed = new Set<string>();
  const lastFailedAt = new Map<string, number>();
  for (const row of readDotWakeLedger(deps)) {
    if (row.dot_id !== charter.dot_id) continue;
    if (row.outcome === 'delivered' || row.outcome === 'rejected') {
      consumed.add(row.trigger_key);
    } else if (row.outcome === 'failed') {
      const at = Date.parse(row.fired_at);
      if (Number.isFinite(at)) {
        lastFailedAt.set(row.trigger_key, Math.max(lastFailedAt.get(row.trigger_key) ?? 0, at));
      }
    }
  }
  return (key: string): boolean => {
    if (consumed.has(key)) return false;
    const failedAt = lastFailedAt.get(key);
    return failedAt === undefined || now.getTime() - failedAt >= DOT_WAKE_RETRY_AFTER_MS;
  };
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
  const wakeTrigger =
    charter.attention.triggers.find(
      (t): t is Extract<DotTrigger, { kind: 'wake' }> => t.kind === 'wake'
    ) ??
    ((charter.team?.accepts_handoffs_from ?? []).length > 0
      ? ({ kind: 'wake', channels: ['inbox'] } as const)
      : undefined);
  if (wakeTrigger) {
    for (const hit of wakeTriggerKeys(charter, deps)) {
      if (isDue(hit.key)) due.push({ trigger: wakeTrigger, key: hit.key, detail: hit.detail });
    }
  }
  return due;
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
  return due;
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
}

function dotSystemPrompt(charter: DotCharter, mode: 'tool' | 'fence', rootDir?: string): string {
  const signals = dotSignalStatusLines(charter, { rootDir });
  const feedback = dotFeedbackPromptLines(charter.dot_id, { rootDir });
  return [
    `You are the resident dot "${charter.dot_id}" (actor id dot:${charter.dot_id}).`,
    `Standing purpose: ${charter.purpose}`,
    charter.team?.goal_ref ? `Organization goal you contribute to: ${charter.team.goal_ref}` : '',
    charter.goal.success_signals?.length
      ? `Success signals: ${charter.goal.success_signals.join('; ')}`
      : '',
    signals.length ? `Measured signal status:\n${signals.join('\n')}` : '',
    feedback.length
      ? `Recent operator feedback on your proposals (respect it):\n${feedback.join('\n')}`
      : '',
    'You are a coordinator: observe and classify, then propose. Never write outside your role scopes.',
    dotProposalInstructions(mode),
    `Your charter bounds:\n${dotBoundsPromptLines(charter, { rootDir }).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function wakePrompt(
  charter: DotCharter,
  mode: 'tool' | 'fence',
  trigger?: DueDotTrigger,
  rootDir?: string
): string {
  const wakeLine = trigger
    ? `\n\nWake trigger: ${trigger.key}${trigger.detail ? `\nDetail: ${trigger.detail}` : ''}`
    : '';
  return `${dotSystemPrompt(charter, mode, rootDir)}\n\nObjective: ${charter.goal.statement}${wakeLine}`;
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
 * Execute one wake for a charter: per-dot re-entrancy guard → status re-check
 * (a charter paused between evaluation and delivery must not run) → role
 * re-validation (an already-active charter whose role vanished must not run —
 * the activation gate only fires on transitions) → heartbeat → daily token
 * cap → bounded goal turn (runGoalDrivenLoop under toolRole + KD-02 budgets),
 * degrading to one delegateTask turn bounded by wall_clock when the backend
 * lacks tool use.
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
    let current: DotCharter | undefined;
    try {
      current = listDotCharters(deps.rootDir).find(
        (entry) => entry.charter.dot_id === charter.dot_id
      )?.charter;
    } catch {
      current = undefined;
    }
    if (!current || current.status !== 'active') {
      const reason = `charter status is ${current?.status ?? 'unreadable'}, not active`;
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
      const backend = deps.backend ?? getReasoningBackend();
      if (!deps.runLoop && !backend.generateWithTools) {
        // Delegation fallback: local shell backends cannot drive a tool loop,
        // so the wake becomes one delegated turn bounded by the charter's
        // wall clock — same XP-06 degradation shape as agent-dispatch. The
        // delegated child runs without the charter role (SO-03 strips
        // inherited roles at the process boundary), so it only proposes: its
        // fenced proposals are governed here, in this process, under the
        // charter role.
        const prompt = wakePrompt(current, 'fence', deps.trigger, deps.rootDir);
        const text = await runDelegatedWake(
          current,
          backend,
          prompt,
          budget?.wall_clock_ms_per_wake ?? DEFAULT_DELEGATED_WAKE_TIMEOUT_MS
        );
        const tokens = estimateWakeTokensFromText({
          prompt,
          result: { text, toolCalls: [] },
        });
        recordDotTokenUsage(current.dot_id, tokens, deps);
        const parsed = parseDotProposalsFromText(text);
        const actions = governProposals(current, parsed.proposals, deps);
        if (deps.trigger?.trigger.kind === 'watch') {
          recordWatchSnapshotFromKey(current, deps.trigger, deps);
        }
        recordDotWakeOutcome(current, deps.trigger, 'delivered', {
          ...deps,
          reason: `delegated-turn (backend lacks generateWithTools); proposals ${parsed.proposals.length}`,
          turns_run: 1,
          tokens_used: tokens,
          // The wake ledger is a shared system-floor file: tenant prose stays out.
          ...(current.scope.tenant_slug ? {} : { summary: dotWakeSummary(text) }),
        });
        return {
          dot_id: current.dot_id,
          outcome: 'delivered',
          reason: 'delegated-turn',
          actions,
          ...(parsed.errors.length ? { proposal_errors: parsed.errors } : {}),
        };
      }
      const runLoop = deps.runLoop;
      if (!runLoop) {
        throw new Error(
          'runDotWake requires deps.runLoop when the backend supports generateWithTools (orchestration must inject the goal driver)'
        );
      }
      const proposalInputs: unknown[] = [];
      const result = await runLoop({
        objective: wakePrompt(current, 'tool', deps.trigger, deps.rootDir),
        goalId: `dot-${current.dot_id}`,
        systemPrompt: dotSystemPrompt(current, 'tool', deps.rootDir),
        toolRole: current.authority.authority_role,
        extraTools: [buildDotProposeToolDefinition()],
        executeTool: (call) => {
          if (call.name !== DOT_PROPOSE_TOOL_NAME) {
            return { resultText: `Tool ${call.name} is not available to a dot; propose instead.` };
          }
          if (proposalInputs.length >= MAX_DOT_PROPOSALS_PER_WAKE) {
            return {
              resultText: `Proposal limit (${MAX_DOT_PROPOSALS_PER_WAKE}) reached for this wake.`,
            };
          }
          proposalInputs.push(call.input);
          return {
            resultText: 'Proposal recorded; the runtime governs it after this wake.',
          };
        },
        ...(budget?.max_turns_per_wake !== undefined
          ? { maxTurns: budget.max_turns_per_wake }
          : {}),
        ...(budget?.wall_clock_ms_per_wake !== undefined || budget?.max_turns_per_wake !== undefined
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
      const tokens = result.goal.budgetStats?.tokensUsed ?? 0;
      recordDotTokenUsage(current.dot_id, tokens, deps);
      const collected = collectDotProposals(proposalInputs);
      const actions = governProposals(current, collected.proposals, deps);
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
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      recordDotWakeOutcome(current, deps.trigger, 'failed', { ...deps, reason });
      recordDaemonHeartbeat(
        current.runtime.heartbeat_id,
        { status: 'error', details: { dot_id: current.dot_id, error: reason } },
        heartbeatOptions
      );
      return { dot_id: current.dot_id, outcome: 'failed', reason };
    }
  } finally {
    wakingDots.delete(charter.dot_id);
  }
}
