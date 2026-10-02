/**
 * Dot runtime — evaluates charter attention triggers for due-ness and executes
 * one bounded goal turn per wake.
 *
 * The resident loop lives in `agent-runtime-supervisor`'s daemon sweep; this
 * module is the pure, testable core it calls. Two ledgers under
 * `active/shared/runtime/` give the loop memory:
 *
 * - `dot-wake-ledger.jsonl` — one row per delivered (or attempted) wake, keyed
 *   by a trigger key (`cron:<expr>@<minute>`, `watch:<path>@<mtime>:<size>`,
 *   `wake:<line-hash>`). Presence = already fired, so it is both the due-ness
 *   memory and the audit trail. TriggerRunner adds its own idempotency layer
 *   on top of the same key.
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
import { safeExistsSync, safeLstat, safeMkdir, safeReadFile } from '../secure-io.js';
import { appendJsonLine, readJsonLines, writeJson } from '../foundation/json.js';
import { parseSafeJsonObjectInput } from '../foundation/safe-json.js';
import { getZonedDateParts, matchesCron } from '../pipeline/cron-utils.js';
import { recordDaemonHeartbeat } from '../daemon-heartbeat.js';
import {
  estimateGoalTurnTokensFromText,
  runGoalDrivenLoop,
  type GoalDrivenLoopResult,
  type RunGoalDrivenLoopOptions,
} from '../workforce/worker-goal-driver.js';
import { getReasoningBackend } from '../reasoning/reasoning-backend.js';
import type { ReasoningBackend } from '../reasoning/reasoning-backend-contracts.js';
import {
  listDotCharters,
  type DotCharter,
  type DotTrigger,
  type LoadedDotCharter,
} from './dot-charter.js';

export const DOT_WAKE_LEDGER_PATH = 'active/shared/runtime/dot-wake-ledger.jsonl';
export const DOT_TOKEN_USAGE_PATH = 'active/shared/runtime/dot-token-usage.jsonl';
export const DOT_INBOX_PATH = 'active/shared/runtime/dot-inbox.jsonl';
export const DOT_WATCH_STATE_PATH = 'active/shared/runtime/dot-watch-state.json';

export interface DotWakeLedgerEntry {
  dot_id: string;
  trigger_key: string;
  kind: DotTrigger['kind'] | 'manual';
  fired_at: string;
  outcome: 'delivered' | 'skipped' | 'failed';
  reason?: string;
  turns_run?: number;
  tokens_used?: number;
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
}

export interface DotRuntimeDeps {
  rootDir?: string;
  now?: () => Date;
  /** Injectable for hermetic tests; defaults to runGoalDrivenLoop. */
  runLoop?: (options: RunGoalDrivenLoopOptions) => Promise<GoalDrivenLoopResult>;
  /**
   * Injectable backend; defaults to getReasoningBackend(). When the backend
   * lacks `generateWithTools` (local shell CLIs), the wake degrades to a
   * single `delegateTask` turn instead of failing — the delegated provider
   * runs the bounded objective natively.
   */
  backend?: Pick<ReasoningBackend, 'generateWithTools' | 'delegateTask'>;
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

function appendWakeLedger(entry: DotWakeLedgerEntry, deps: DotRuntimeDeps): void {
  appendJsonlEnsured(DOT_WAKE_LEDGER_PATH, entry, deps);
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

/** Persist the current watch-path stats so unchanged paths stop being due. */
export function recordDotWatchSnapshot(charter: DotCharter, deps: DotRuntimeDeps = {}): void {
  const state = readWatchState(deps);
  const dotState = { ...(state[charter.dot_id] ?? {}) };
  for (const trigger of charter.attention.triggers) {
    if (trigger.kind !== 'watch') continue;
    for (const rel of trigger.paths) {
      try {
        const stat = safeLstat(runtimePath(deps.rootDir, rel));
        dotState[rel] = { mtime_ms: stat.mtimeMs, size: stat.size };
      } catch {
        delete dotState[rel];
      }
    }
  }
  const statePath = runtimePath(deps.rootDir, DOT_WATCH_STATE_PATH);
  safeMkdir(path.dirname(statePath), { recursive: true });
  writeJson(statePath, {
    ...state,
    [charter.dot_id]: dotState,
  });
}

function minuteKey(date: Date, timezone?: string): string {
  const parts = getZonedDateParts(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function watchTriggerKey(charter: DotCharter, rel: string, deps: DotRuntimeDeps): string | null {
  let stat;
  try {
    stat = safeLstat(runtimePath(deps.rootDir, rel));
  } catch {
    return null;
  }
  const snapshot = readWatchState(deps)[charter.dot_id]?.[rel];
  if (snapshot && snapshot.mtime_ms === stat.mtimeMs && snapshot.size === stat.size) {
    return null;
  }
  return `watch:${rel}@${Math.round(stat.mtimeMs)}:${stat.size}`;
}

function wakeTriggerKeys(charter: DotCharter, deps: DotRuntimeDeps): string[] {
  const declaredChannels = charter.attention.triggers
    .filter((t): t is Extract<DotTrigger, { kind: 'wake' }> => t.kind === 'wake')
    .flatMap((t) => t.channels);
  if (declaredChannels.length === 0) return [];
  const rows = readJsonLines<DotInboxEntry & { __line?: string }>(
    runtimePath(deps.rootDir, DOT_INBOX_PATH),
    {
      onMalformed: 'skip',
      map: (value, _line, rawLine) => ({ ...(value as DotInboxEntry), __line: rawLine }),
    }
  );
  const keys: string[] = [];
  for (const row of rows) {
    const addressed = row.dot_id === charter.dot_id;
    const channelHit =
      !row.dot_id && typeof row.channel === 'string' && declaredChannels.includes(row.channel);
    if (!addressed && !channelHit) continue;
    keys.push(`wake:${createHash('sha256').update(String(row.__line)).digest('hex').slice(0, 16)}`);
  }
  return keys;
}

/**
 * Triggers due right now: a trigger is due when its key has no non-failed
 * ledger entry yet (failed wakes stay retryable — they would otherwise be
 * lost until the key changed). Cron fires on matching minutes only — missed
 * occurrences while the host slept are deliberately not caught up (see the
 * model doc's locality caveat).
 */
export function evaluateDotTriggersDue(
  charter: DotCharter,
  deps: DotRuntimeDeps = {}
): DueDotTrigger[] {
  const now = deps.now?.() ?? new Date();
  const fired = new Set(
    readDotWakeLedger(deps)
      .filter((row) => row.outcome !== 'failed')
      .map((row) => row.trigger_key)
  );
  const due: DueDotTrigger[] = [];
  for (const trigger of charter.attention.triggers) {
    if (trigger.kind === 'cron') {
      if (!matchesCron(trigger.cron, now, trigger.timezone)) continue;
      const key = `cron:${trigger.cron}@${minuteKey(now, trigger.timezone)}`;
      if (!fired.has(key)) due.push({ trigger, key });
    } else if (trigger.kind === 'watch') {
      for (const rel of trigger.paths) {
        const key = watchTriggerKey(charter, rel, deps);
        if (key && !fired.has(key)) due.push({ trigger, key });
      }
    } else if (trigger.kind === 'wake') {
      for (const key of wakeTriggerKeys(charter, deps)) {
        if (!fired.has(key)) due.push({ trigger, key });
      }
    }
  }
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
 * `stale_after_ms` comes from `runtime.max_idle_wake_ms`.
 */
export function listActiveDotHeartbeatSpecs(rootDir?: string): DotHeartbeatSpec[] {
  try {
    return listDotCharters(rootDir, { status: 'active' }).map((loaded) => ({
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
  outcome: 'delivered' | 'skipped' | 'failed';
  reason?: string;
  result?: GoalDrivenLoopResult;
}

function dotSystemPrompt(charter: DotCharter): string {
  return [
    `You are the resident dot "${charter.dot_id}".`,
    `Standing purpose: ${charter.purpose}`,
    charter.goal.success_signals?.length
      ? `Success signals: ${charter.goal.success_signals.join('; ')}`
      : '',
    'You are a coordinator: observe, classify, and record findings. Do not write outside your role scopes; escalate decisions to the operator.',
  ]
    .filter(Boolean)
    .join('\n');
}

function ledgerEntry(
  charter: DotCharter,
  trigger: DueDotTrigger | undefined,
  deps: DotRuntimeDeps,
  outcome: DotWakeLedgerEntry['outcome'],
  extra: Partial<DotWakeLedgerEntry> = {}
): DotWakeLedgerEntry {
  return {
    dot_id: charter.dot_id,
    trigger_key: trigger?.key ?? `manual:${(deps.now?.() ?? new Date()).toISOString()}`,
    kind: trigger?.trigger.kind ?? 'manual',
    fired_at: (deps.now?.() ?? new Date()).toISOString(),
    outcome,
    ...extra,
  };
}

/**
 * Execute one wake for a charter: re-check status (a charter paused between
 * trigger evaluation and delivery must not run), enforce the daily token cap,
 * heartbeat, then run one bounded goal turn under the charter's role + budget.
 * `trigger` is the due trigger being delivered; undefined for manual wakes.
 */
export async function runDotWake(
  loaded: LoadedDotCharter,
  deps: DotRuntimeDeps & { trigger?: DueDotTrigger } = {}
): Promise<DotWakeReceipt> {
  const { charter } = loaded;

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
    appendWakeLedger(ledgerEntry(charter, deps.trigger, deps, 'skipped', { reason }), deps);
    return { dot_id: charter.dot_id, outcome: 'skipped', reason };
  }

  if (dotDailyTokenCapReached(current, deps)) {
    const reason = `token_cap_per_day ${current.goal.budget?.token_cap_per_day} reached`;
    appendWakeLedger(ledgerEntry(current, deps.trigger, deps, 'skipped', { reason }), deps);
    return { dot_id: current.dot_id, outcome: 'skipped', reason };
  }

  const heartbeatOptions = deps.rootDir
    ? { rootDir: runtimePath(deps.rootDir, 'active/shared/runtime/heartbeats') }
    : {};
  recordDaemonHeartbeat(
    current.runtime.heartbeat_id,
    {
      status: 'running',
      details: { dot_id: current.dot_id, trigger: deps.trigger?.key ?? 'manual' },
    },
    heartbeatOptions
  );

  const budget = current.goal.budget;
  try {
    const backend = deps.backend ?? getReasoningBackend();
    if (!deps.runLoop && !backend.generateWithTools) {
      // Delegation fallback: local shell backends cannot drive a tool loop, so
      // the wake becomes one delegated turn — the provider CLI runs the
      // bounded objective natively. Fits the dot-as-coordinator model and is
      // how agent-dispatch already degrades (XP-06 pattern).
      const prompt = `${dotSystemPrompt(current)}\n\nObjective: ${current.goal.statement}`;
      const text = await backend.delegateTask(prompt, undefined);
      const tokens = estimateGoalTurnTokensFromText({
        prompt,
        result: { text, toolCalls: [] },
      });
      recordDotTokenUsage(current.dot_id, tokens, deps);
      if (deps.trigger?.trigger.kind === 'watch') recordDotWatchSnapshot(current, deps);
      appendWakeLedger(
        ledgerEntry(current, deps.trigger, deps, 'delivered', {
          turns_run: 1,
          tokens_used: tokens,
          reason: 'delegated-turn (backend lacks generateWithTools)',
        }),
        deps
      );
      return {
        dot_id: current.dot_id,
        outcome: 'delivered',
        reason: 'delegated-turn',
      };
    }
    const runLoop = deps.runLoop ?? runGoalDrivenLoop;
    const result = await runLoop({
      objective: current.goal.statement,
      goalId: `dot-${current.dot_id}`,
      systemPrompt: dotSystemPrompt(current),
      toolRole: current.authority.authority_role,
      ...(budget?.max_turns_per_wake !== undefined ? { maxTurns: budget.max_turns_per_wake } : {}),
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
    if (deps.trigger?.trigger.kind === 'watch') recordDotWatchSnapshot(current, deps);
    appendWakeLedger(
      ledgerEntry(current, deps.trigger, deps, 'delivered', {
        turns_run: result.turnsRun,
        tokens_used: tokens,
      }),
      deps
    );
    return { dot_id: current.dot_id, outcome: 'delivered', result };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    appendWakeLedger(ledgerEntry(current, deps.trigger, deps, 'failed', { reason }), deps);
    recordDaemonHeartbeat(
      current.runtime.heartbeat_id,
      { status: 'error', details: { dot_id: current.dot_id, error: reason } },
      heartbeatOptions
    );
    return { dot_id: current.dot_id, outcome: 'failed', reason };
  }
}
