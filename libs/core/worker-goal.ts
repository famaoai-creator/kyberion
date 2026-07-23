/**
 * Worker Goal state machine (KD-01).
 *
 * A runtime-owned, structured goal that turns a chain of ordinary turns into an
 * autonomous multi-turn pursuit. Modeled on kimi-code `goalService.ts`.
 *
 * States: `active / paused / blocked / complete`.
 *  - `paused`  = TECHNICAL stop (interrupt, provider failure, rate limit,
 *    process resume). The old process's turn is no longer alive.
 *  - `blocked` = BUSINESS stop (needs external input, budget reached, hook
 *    block, objective unachievable as stated).
 * Both are the same *resumable* shape; only `terminalKind`/`terminalReason`
 * differ. There is intentionally **no `cancelled` state** — cancelling a goal
 * clears it and delivers exactly one system reminder telling the model to
 * ignore prior active-goal reminders ({@link GOAL_CANCEL_SYSTEM_REMINDER}).
 * `complete` is transient and is never persisted at rest — a completed goal is
 * cleared, and {@link serializeGoalStateForPersistence} refuses to persist it.
 *
 * The model can only terminate a goal via the structured typed signal
 * {@link GOAL_UPDATE_OP} (`goal:update`, surfaced as the {@link
 * GOAL_UPDATE_TOOL_NAME} tool). A natural-language "I'm done" carries no signal
 * and therefore does nothing — the driver treats a signal-less turn as
 * `continue`.
 *
 * Blocked audit: a non-trivial blocker must persist {@link
 * GOAL_BLOCKED_PERSIST_TURNS} consecutive goal turns before `blocked` is
 * allowed (prevents premature abandonment). The counter lives in runtime state,
 * not just prompt text. Intrinsically impossible objectives bypass the counter.
 *
 * This module is the pure state machine + contracts (no I/O, no LLM); the
 * multi-turn engine that drives it lives in `worker-goal-driver.ts`.
 *
 * ## KD-02: opt-in goal budgets
 *
 * A goal may optionally carry a {@link GoalBudgetLimits} (`tokenBudget` /
 * `turnBudget` / `wallClockBudgetMs`) — strictly opt-in, never invented by the
 * runtime. This is a **different layer** from the pipeline step budget
 * (`NormalizedStepBudget` in `scripts/run_pipeline.ts`, mirrored as
 * `ReasoningCallBudget` in `reasoning-backend.ts`): a step/request budget caps
 * one `generateWithTools`/ADF-step call, while a goal budget caps the whole
 * multi-turn autonomous pursuit driven by `worker-goal-driver.ts`. The two are
 * independent and may both be set on the same worker.
 *
 * When a goal budget is reached, `worker-goal-driver.ts` runs a **grace
 * step** (one final turn, with all tool calls synthetically rejected, that
 * lets the model write a brief final status) before settling the goal to
 * `blocked` with a budget reason — budget exhaustion is a summary-bearing
 * `blocked`, never a truncated failure. At 75% of any configured budget
 * ({@link GOAL_CONVERGENCE_THRESHOLD_RATIO}), {@link buildGoalStatusReminder}
 * flips its injected wording from steady-progress to convergence mode.
 */

import type { ToolDefinition } from './reasoning-backend.js';

export const GOAL_STATES = ['active', 'paused', 'blocked', 'complete'] as const;
export type GoalState = (typeof GOAL_STATES)[number];

/** paused => technical, blocked => business. `complete` carries neither. */
export type GoalTerminalKind = 'technical' | 'business';

/** Consecutive goal turns a non-trivial blocker must recur before `blocked`. */
export const GOAL_BLOCKED_PERSIST_TURNS = 3;

export interface GoalRuntimeState {
  goalId: string;
  /** Raw, untrusted objective text (framed via KD-04 before injection). */
  objective: string;
  state: GoalState;
  /** Completed goal turns so far (a turn = one bounded work slice). */
  turnCount: number;
  /** Consecutive turns the current blocker signature has recurred. */
  blockedStreak: number;
  /** Normalized signature of the currently-recurring blocker, if any. */
  pendingBlockerSignature?: string;
  terminalKind?: GoalTerminalKind;
  terminalReason?: string;
  missionId?: string;
  createdAt: string;
  updatedAt: string;
  /** KD-02: opt-in multi-turn budgets. Absent = unbounded (KD-01 behavior). */
  budget?: GoalBudgetLimits;
  /** KD-02: running totals; accrues only while `state === 'active'`. */
  budgetStats?: GoalBudgetStats;
}

export interface CreateGoalParams {
  goalId: string;
  objective: string;
  missionId?: string;
  /** KD-02: opt-in multi-turn budgets (never invented — undefined by default). */
  budget?: GoalBudgetLimits;
  now?: () => string;
}

function isoNow(now?: () => string): string {
  return now ? now() : new Date().toISOString();
}

export function createGoal(params: CreateGoalParams): GoalRuntimeState {
  const ts = isoNow(params.now);
  return {
    goalId: params.goalId,
    objective: params.objective,
    state: 'active',
    turnCount: 0,
    blockedStreak: 0,
    missionId: params.missionId,
    createdAt: ts,
    updatedAt: ts,
    ...(params.budget ? { budget: params.budget } : {}),
  };
}

// ---------------------------------------------------------------------------
// Structured termination signal (goal:update op / tool)
// ---------------------------------------------------------------------------

export const GOAL_UPDATE_OP = 'goal:update';
/** Tool-safe surface name for the `goal:update` op (colons are not tool-safe). */
export const GOAL_UPDATE_TOOL_NAME = 'goal_update';

export type GoalUpdateStatus = 'continue' | 'complete' | 'blocked';

export interface GoalUpdateSignal {
  status: GoalUpdateStatus;
  /** For `blocked`: the blocker; for `complete`: the completion evidence. */
  reason?: string;
  /** `blocked` only: the objective is intrinsically impossible — bypasses the
   * consecutive-turn threshold. */
  impossible?: boolean;
}

/**
 * The goal-termination tool. Exposed **only** to the main worker loop — never
 * to subagents (their termination is their own dispatch's concern).
 */
export function buildGoalUpdateToolDefinition(): ToolDefinition {
  return {
    name: GOAL_UPDATE_TOOL_NAME,
    description:
      'Report the structured status of the active goal. This is the ONLY way to end the ' +
      'goal — a natural-language completion claim does nothing. status="continue" to keep ' +
      'working (default if unsure), status="complete" only when every explicit requirement ' +
      'is verifiably met (a plan, summary, first draft, or partial result is NOT complete), ' +
      'status="blocked" when a non-trivial blocker prevents progress. Set impossible=true ' +
      'only when the objective is intrinsically unachievable as stated.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['continue', 'complete', 'blocked'] },
        reason: {
          type: 'string',
          description: 'Blocker description (blocked) or completion evidence (complete).',
        },
        impossible: {
          type: 'boolean',
          description: 'blocked only: the objective is intrinsically impossible as stated.',
        },
      },
      required: ['status'],
    },
  };
}

/**
 * Parse a `goal:update` tool-call input into a signal, or `null` when the input
 * carries no valid structured status (the driver then treats the turn as
 * `continue`, so malformed or absent signals can never end a goal).
 */
export function parseGoalUpdateSignal(input: unknown): GoalUpdateSignal | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const status = record.status;
  if (status !== 'continue' && status !== 'complete' && status !== 'blocked') return null;
  const signal: GoalUpdateSignal = { status };
  if (typeof record.reason === 'string' && record.reason.trim())
    signal.reason = record.reason.trim();
  if (record.impossible === true) signal.impossible = true;
  return signal;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

export type GoalUpdateOutcomeKind = 'continue' | 'complete' | 'blocked' | 'blocked_rejected';

export interface GoalUpdateOutcome {
  kind: GoalUpdateOutcomeKind;
  state: GoalRuntimeState;
  /** For blocked_rejected: how many consecutive turns the blocker has recurred. */
  blockedStreak: number;
  /** For blocked_rejected: the threshold that was not yet met. */
  blockedThreshold: number;
}

export interface ApplyGoalUpdateConfig {
  blockedPersistTurns?: number;
  now?: () => string;
}

/** Collapse a blocker reason to a stable signature for consecutive-turn tracking. */
function blockerSignature(reason?: string): string {
  const normalized = (reason ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized || 'unspecified';
}

/**
 * Apply one structured `goal:update` to an active goal. The state machine never
 * increments `turnCount` (the driver owns turn accounting); it only advances
 * termination + blocked-streak bookkeeping.
 *
 * `blocked` is granted only when either the objective is intrinsically
 * impossible, or the same blocker signature has recurred for
 * `blockedPersistTurns` consecutive turns. Otherwise the goal stays `active`
 * (outcome `blocked_rejected`) and keeps going.
 */
export function applyGoalUpdate(
  state: GoalRuntimeState,
  signal: GoalUpdateSignal,
  config: ApplyGoalUpdateConfig = {}
): GoalUpdateOutcome {
  const threshold = config.blockedPersistTurns ?? GOAL_BLOCKED_PERSIST_TURNS;
  const ts = isoNow(config.now);

  if (state.state !== 'active') {
    // A terminated goal is inert; report continue without mutation.
    return {
      kind: 'continue',
      state,
      blockedStreak: state.blockedStreak,
      blockedThreshold: threshold,
    };
  }

  if (signal.status === 'continue') {
    // A working turn that made no blocked claim resets the blocker streak.
    const next: GoalRuntimeState = {
      ...state,
      blockedStreak: 0,
      pendingBlockerSignature: undefined,
      updatedAt: ts,
    };
    return { kind: 'continue', state: next, blockedStreak: 0, blockedThreshold: threshold };
  }

  if (signal.status === 'complete') {
    const next: GoalRuntimeState = {
      ...state,
      state: 'complete',
      terminalKind: undefined,
      terminalReason: signal.reason,
      blockedStreak: 0,
      pendingBlockerSignature: undefined,
      updatedAt: ts,
    };
    return { kind: 'complete', state: next, blockedStreak: 0, blockedThreshold: threshold };
  }

  // signal.status === 'blocked'
  if (signal.impossible) {
    const next: GoalRuntimeState = {
      ...state,
      state: 'blocked',
      terminalKind: 'business',
      terminalReason: signal.reason ?? 'objective intrinsically impossible as stated',
      updatedAt: ts,
    };
    return {
      kind: 'blocked',
      state: next,
      blockedStreak: state.blockedStreak,
      blockedThreshold: threshold,
    };
  }

  const signature = blockerSignature(signal.reason);
  const streak = signature === state.pendingBlockerSignature ? state.blockedStreak + 1 : 1;

  if (streak >= threshold) {
    const next: GoalRuntimeState = {
      ...state,
      state: 'blocked',
      terminalKind: 'business',
      terminalReason: signal.reason ?? 'blocker persisted across goal turns',
      blockedStreak: streak,
      pendingBlockerSignature: signature,
      updatedAt: ts,
    };
    return { kind: 'blocked', state: next, blockedStreak: streak, blockedThreshold: threshold };
  }

  // Not yet allowed: stay active, remember the streak, keep working.
  const next: GoalRuntimeState = {
    ...state,
    blockedStreak: streak,
    pendingBlockerSignature: signature,
    updatedAt: ts,
  };
  return {
    kind: 'blocked_rejected',
    state: next,
    blockedStreak: streak,
    blockedThreshold: threshold,
  };
}

/** Advance the completed-turn counter (driver calls this at end of each turn). */
export function incrementGoalTurn(state: GoalRuntimeState, now?: () => string): GoalRuntimeState {
  return { ...state, turnCount: state.turnCount + 1, updatedAt: isoNow(now) };
}

/**
 * TECHNICAL stop: interrupt, provider failure, rate limit, or safety force-stop.
 * Only an `active` goal can be paused; a terminated goal is returned unchanged.
 */
export function pauseGoal(
  state: GoalRuntimeState,
  reason: string,
  now?: () => string
): GoalRuntimeState {
  if (state.state !== 'active') return state;
  return {
    ...state,
    state: 'paused',
    terminalKind: 'technical',
    terminalReason: reason,
    updatedAt: isoNow(now),
  };
}

/**
 * Resume demotion: after a process restart/replay, an `active` goal is always
 * demoted to `paused` — the old process's turn cannot still be alive, so the
 * goal must never self-advance until an explicit resume. `paused`/`blocked`
 * goals are returned unchanged.
 */
export function demoteActiveOnResume(
  state: GoalRuntimeState,
  now?: () => string
): GoalRuntimeState {
  if (state.state !== 'active') return state;
  return {
    ...state,
    state: 'paused',
    terminalKind: 'technical',
    terminalReason: 'process resumed: prior turn is no longer alive',
    updatedAt: isoNow(now),
  };
}

/** Explicit resume of a paused goal back to active (mission-ceremony resume). */
export function resumeGoal(state: GoalRuntimeState, now?: () => string): GoalRuntimeState {
  if (state.state !== 'paused') return state;
  return {
    ...state,
    state: 'active',
    terminalKind: undefined,
    terminalReason: undefined,
    updatedAt: isoNow(now),
  };
}

// ---------------------------------------------------------------------------
// KD-02: opt-in goal budgets (grace step / convergence mode / wall-clock deadline)
// ---------------------------------------------------------------------------

/**
 * Opt-in multi-turn budgets for a goal. Every field is undefined unless the
 * caller explicitly supplies it — the runtime never invents a budget. See the
 * module doc comment for how this differs from the pipeline step budget
 * (`NormalizedStepBudget` / `ReasoningCallBudget`).
 */
export interface GoalBudgetLimits {
  tokenBudget?: number;
  turnBudget?: number;
  wallClockBudgetMs?: number;
}

/** Running totals for a goal's budget. Accrues only while `state === 'active'`. */
export interface GoalBudgetStats {
  tokensUsed: number;
  turnsUsed: number;
  wallClockMsUsed: number;
}

export function createGoalBudgetStats(): GoalBudgetStats {
  return { tokensUsed: 0, turnsUsed: 0, wallClockMsUsed: 0 };
}

/** Fraction of any configured budget's limit consumed so far, at 75% of which
 * (see {@link GOAL_CONVERGENCE_THRESHOLD_RATIO}) convergence mode kicks in.
 * Undefined budget dimensions are ignored; no budget at all => 0. */
export function goalBudgetUsageRatio(
  budget: GoalBudgetLimits | undefined,
  stats: GoalBudgetStats | undefined
): number {
  if (!budget) return 0;
  const s = stats ?? createGoalBudgetStats();
  const ratios: number[] = [];
  if (budget.tokenBudget !== undefined && budget.tokenBudget > 0) {
    ratios.push(s.tokensUsed / budget.tokenBudget);
  }
  if (budget.turnBudget !== undefined && budget.turnBudget > 0) {
    ratios.push(s.turnsUsed / budget.turnBudget);
  }
  if (budget.wallClockBudgetMs !== undefined && budget.wallClockBudgetMs > 0) {
    ratios.push(s.wallClockMsUsed / budget.wallClockBudgetMs);
  }
  return ratios.length > 0 ? Math.max(...ratios) : 0;
}

/** Usage ratio (see {@link goalBudgetUsageRatio}) at/above which the injected
 * goal-status wording flips from steady-progress to convergence mode. */
export const GOAL_CONVERGENCE_THRESHOLD_RATIO = 0.75;

export interface GoalBudgetReachedResult {
  reached: boolean;
  /** e.g. "goal budget reached: token budget 500000". Present iff reached. */
  reason?: string;
}

/**
 * Which (if any) configured budget dimension has been reached/exceeded.
 * Checked in a stable order (token, then turn, then wall-clock) so the
 * reported reason is deterministic when more than one trips at once.
 */
export function checkGoalBudgetReached(
  budget: GoalBudgetLimits | undefined,
  stats: GoalBudgetStats | undefined
): GoalBudgetReachedResult {
  if (!budget) return { reached: false };
  const s = stats ?? createGoalBudgetStats();
  if (budget.tokenBudget !== undefined && s.tokensUsed >= budget.tokenBudget) {
    return { reached: true, reason: `goal budget reached: token budget ${budget.tokenBudget}` };
  }
  if (budget.turnBudget !== undefined && s.turnsUsed >= budget.turnBudget) {
    return { reached: true, reason: `goal budget reached: turn budget ${budget.turnBudget}` };
  }
  if (budget.wallClockBudgetMs !== undefined && s.wallClockMsUsed >= budget.wallClockBudgetMs) {
    return {
      reached: true,
      reason: `goal budget reached: wall-clock budget ${budget.wallClockBudgetMs}ms`,
    };
  }
  return { reached: false };
}

/**
 * Accrue turn/token/wall-clock usage onto a goal's budget stats. A no-op
 * (returns `state` unchanged) unless the goal is `active` — stats must never
 * accrue for a paused/blocked/complete goal.
 */
export function accrueGoalBudgetUsage(
  state: GoalRuntimeState,
  delta: { tokens?: number; turns?: number; wallClockMs?: number }
): GoalRuntimeState {
  if (state.state !== 'active') return state;
  const prev = state.budgetStats ?? createGoalBudgetStats();
  const budgetStats: GoalBudgetStats = {
    tokensUsed: prev.tokensUsed + (delta.tokens ?? 0),
    turnsUsed: prev.turnsUsed + (delta.turns ?? 0),
    wallClockMsUsed: prev.wallClockMsUsed + (delta.wallClockMs ?? 0),
  };
  return { ...state, budgetStats };
}

/**
 * BUSINESS stop: a configured goal budget was reached. Same shape as
 * {@link pauseGoal} (which is the TECHNICAL counterpart) — only an `active`
 * goal can be blocked this way; a terminated goal is returned unchanged.
 */
export function blockGoalOnBudget(
  state: GoalRuntimeState,
  reason: string,
  now?: () => string
): GoalRuntimeState {
  if (state.state !== 'active') return state;
  return {
    ...state,
    state: 'blocked',
    terminalKind: 'business',
    terminalReason: reason,
    updatedAt: isoNow(now),
  };
}

// ---------------------------------------------------------------------------
// Persistence / replay
// ---------------------------------------------------------------------------

/**
 * Prepare a goal for persistence at rest. `complete` is transient — a completed
 * goal is cleared, so this returns `null` for it (never persist a completed
 * goal). All other states are persisted verbatim.
 */
export function serializeGoalStateForPersistence(state: GoalRuntimeState): GoalRuntimeState | null {
  if (state.state === 'complete') return null;
  return { ...state };
}

/**
 * Restore a goal from a persisted record after a process restart. An `active`
 * record means the process died mid-turn, so it is always demoted to `paused`
 * (see {@link demoteActiveOnResume}); `paused`/`blocked` are restored as-is.
 */
export function restoreGoalState(record: GoalRuntimeState, now?: () => string): GoalRuntimeState {
  return demoteActiveOnResume(record, now);
}

// ---------------------------------------------------------------------------
// Prompt fragments (English, like other prompt constants in this repo)
// ---------------------------------------------------------------------------

/**
 * Continuation re-audit contract, injected at every turn boundary. Written as a
 * constant so the audit wording is a single source of truth.
 */
export const GOAL_CONTINUATION_REAUDIT_PROMPT = [
  'ACTIVE GOAL — re-audit this goal before doing anything else this turn:',
  '(a) Re-decide completion and blocked-ness every turn from scratch. If the objective is',
  '    trivially simple, impossible, unsafe, or self-contradictory, terminate it THIS turn',
  '    (goal_update complete or blocked) instead of starting work.',
  '(b) Do exactly ONE bounded slice of work this turn — do not attempt the whole objective at once.',
  '(c) Completion audit: you may only report status="complete" after verifying the result against',
  '    EVERY explicit requirement of the objective. A plan, a summary, a first draft, or a partial',
  '    result is NOT complete. Being close to a budget limit is NEVER a reason to declare complete.',
  '(d) Blocked audit: a non-trivial blocker must genuinely recur before you may report status="blocked"',
  `    — it must persist for ${GOAL_BLOCKED_PERSIST_TURNS} consecutive goal turns first. Do not abandon`,
  '    early. The only exception is an objective that is intrinsically impossible as stated, which you',
  '    may report immediately with impossible=true.',
  'To end the goal you MUST call the goal_update tool with a structured status. Prose alone does nothing.',
].join('\n');

/**
 * One-shot reminder delivered when a goal is cancelled/cleared: the model must
 * disregard any earlier active-goal reminders still in its context (there is no
 * `cancelled` state — a cancelled goal simply stops existing).
 */
export const GOAL_CANCEL_SYSTEM_REMINDER =
  'The previously active goal has been cleared. Ignore all earlier active-goal reminders and ' +
  'continuation instructions; there is no active goal to pursue unless a new one is stated.';

/**
 * KD-02 steady-progress wording: the default per-turn tone while no budget is
 * near its limit (or no budget is configured at all).
 */
export const GOAL_STEADY_PROGRESS_PROMPT =
  'budget_mode: steady — make steady, concrete progress this turn toward the objective.';

/**
 * KD-02 convergence-mode wording: injected once ANY configured budget crosses
 * {@link GOAL_CONVERGENCE_THRESHOLD_RATIO} (75%) of its limit, replacing the
 * steady-progress line above.
 */
export const GOAL_CONVERGENCE_MODE_PROMPT =
  'budget_mode: convergence — a goal budget has reached 75% of its limit. Converge toward a ' +
  'final, verifiable answer using what is already gathered; avoid starting new discretionary work.';

/**
 * KD-02 grace-step reminder: injected for the single extra turn that runs
 * after a goal budget is reached and the prior turn ended in tool calls. All
 * tool calls made during this turn are synthetically rejected by the driver —
 * the model must write its final status in prose instead.
 */
export const GOAL_BUDGET_GRACE_STEP_PROMPT = [
  'GOAL BUDGET REACHED — this is the final turn for this goal.',
  'Any tool call you make this turn will be synthetically rejected and NOT executed.',
  'Do not call goal_update or any other tool. Instead, write a brief final status in prose: what',
  'was accomplished, what remains, and any information a follow-up attempt will need.',
].join('\n');

/**
 * Trusted per-turn goal-status line (state + turn + any available rewind
 * checkpoints + KD-02 budget mode). The objective text itself is NOT included
 * here — it is untrusted and is injected separately through the KD-04 framing
 * provider.
 */
export function buildGoalStatusReminder(
  state: GoalRuntimeState,
  availableCheckpointIds: readonly string[] = []
): string {
  const lines = [
    GOAL_CONTINUATION_REAUDIT_PROMPT,
    '',
    `goal_id: ${state.goalId}`,
    `goal_state: ${state.state}`,
    `goal_turn: ${state.turnCount + 1}`,
  ];
  if (state.blockedStreak > 0) {
    lines.push(
      `blocked_streak: ${state.blockedStreak}/${GOAL_BLOCKED_PERSIST_TURNS} (a blocked report is only accepted once this reaches ${GOAL_BLOCKED_PERSIST_TURNS})`
    );
  }
  if (availableCheckpointIds.length > 0) {
    lines.push(`rewind_checkpoints: ${availableCheckpointIds.join(', ')}`);
  }
  if (state.budget) {
    const ratio = goalBudgetUsageRatio(state.budget, state.budgetStats);
    lines.push(
      '',
      ratio >= GOAL_CONVERGENCE_THRESHOLD_RATIO
        ? GOAL_CONVERGENCE_MODE_PROMPT
        : GOAL_STEADY_PROGRESS_PROMPT
    );
  }
  return lines.join('\n');
}
