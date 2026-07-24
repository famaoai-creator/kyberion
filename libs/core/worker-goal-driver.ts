/**
 * Worker Goal autonomous driver (KD-01).
 *
 * The multi-turn engine that turns a chain of `generateWithTools` turns into an
 * autonomous pursuit of a {@link GoalRuntimeState}. One iteration = one turn =
 * one bounded work slice. On turn end, while the goal is still `active`, the
 * driver injects the continuation re-audit contract at the turn boundary and
 * launches the next turn. The model can only terminate the goal via the
 * structured {@link GOAL_UPDATE_TOOL_NAME} signal — a natural-language "done"
 * carries no signal and is treated as `continue`.
 *
 * This is the multi-turn loop KC-07 (context rewind) was waiting to be wired
 * into: each turn takes a checkpoint and exposes the `context_rewind` tool
 * (its existing guards intact), so the model can collapse a dead-end from
 * inside a goal turn.
 *
 * There was no pre-existing main-worker multi-turn tool loop in the repo
 * (`InSessionDispatcher` is single-shot subagent dispatch; the anthropic
 * backend's `generateWithTools` is one call). KD-01 introduces this loop and
 * wires it to the REAL runtime singletons by default: `getReasoningBackend()`,
 * `getDefaultWorkerEventStream()`, the dynamic-injection registry, a real
 * `RewindableWorkerContext`, and the KC-01 repeat governor. Goal tools are
 * built here for the MAIN worker only and are never handed to a subagent
 * dispatch path (which continues to expose only `invoke_agent`).
 *
 * ## KD-02: opt-in goal budgets
 *
 * When `options.budget` is set (see {@link GoalBudgetLimits} — strictly
 * opt-in, a different layer from the pipeline step budget, see the doc
 * comment in `worker-goal.ts`), this driver adds three mechanisms:
 *
 *  1. **Grace step** — once a token/turn budget is reached, if the
 *     just-finished turn ended in tool calls, one more turn runs with the
 *     {@link GOAL_BUDGET_GRACE_STEP_PROMPT} reminder injected and every tool
 *     call it makes synthetically rejected (never executed, never applied);
 *     the goal then settles to `blocked` carrying that turn's prose as the
 *     final report. If the just-finished turn had no tool calls, its own text
 *     already serves as the report and the goal settles to `blocked`
 *     immediately (no extra turn).
 *  2. **Convergence mode** — handled entirely inside
 *     {@link buildGoalStatusReminder} (worker-goal.ts): once
 *     `goalBudgetUsageRatio(...) >= GOAL_CONVERGENCE_THRESHOLD_RATIO`, the
 *     injected status line flips wording. Nothing to do here beyond keeping
 *     `goal.budgetStats` current before each turn's injection is collected.
 *  3. **Wall-clock deadline** — when `budget.wallClockBudgetMs` is set, each
 *     turn's `generateWithTools` call is raced against a timer armed for the
 *     remaining budget via an injectable {@link GoalWallClockScheduler} (real
 *     `setTimeout` by default). If the timer wins the race, the in-flight
 *     turn is treated as cancelled (its eventual real resolution, if any, is
 *     never awaited or applied) and the goal settles to `blocked` at once —
 *     no grace step, since a genuinely cancelled call has no prose to report.
 *
 * Token usage is not observable from `ReasoningBackend.generateWithTools()`
 * (see the {@link estimateGoalTurnTokensFromText} doc comment for the seam);
 * turn/wall-clock stats accrue only while the goal is `active`
 * (`accrueGoalBudgetUsage` in worker-goal.ts enforces this).
 */

import { logger } from './core.js';
import { buildContextRewindToolDefinition, RewindableWorkerContext } from './context-rewind.js';
import {
  buildUntrustedDataInjectionProvider,
  DynamicInjectionRegistry,
  getDefaultDynamicInjectionRegistry,
  getMissionDynamicInjectionRegistry,
  renderInjectionsAsSystemReminders,
  type DynamicInjectionProvider,
} from './dynamic-injection.js';
import { getReasoningBackend } from './reasoning-backend.js';
import type {
  GenerateWithToolsResult,
  ReasoningBackend,
  ToolCall,
  ToolDefinition,
} from './reasoning-backend.js';
import {
  advanceToolCallRepeatGovernor,
  createToolCallRepeatGovernorState,
  type ToolCallRepeatGovernorConfig,
  type ToolCallRepeatGovernorState,
} from './tool-call-repeat-governor.js';
import { estimateTokens } from './worker-context-compaction.js';
import {
  accrueGoalBudgetUsage,
  applyGoalUpdate,
  blockGoalOnBudget,
  buildGoalStatusReminder,
  buildGoalUpdateToolDefinition,
  checkGoalBudgetReached,
  createGoal,
  demoteActiveOnResume,
  GOAL_BUDGET_GRACE_STEP_PROMPT,
  GOAL_UPDATE_TOOL_NAME,
  incrementGoalTurn,
  parseGoalUpdateSignal,
  pauseGoal,
  resumeGoal,
  serializeGoalStateForPersistence,
  type GoalBudgetLimits,
  type GoalRuntimeState,
  type GoalState,
  type GoalUpdateSignal,
} from './worker-goal.js';
import {
  getDefaultWorkerEventStream,
  type WorkerEventSource,
  type WorkerEventStream,
} from './worker-event-stream.js';

// ---------------------------------------------------------------------------
// KD-02: wall-clock scheduler seam (injectable so deadline tests are hermetic
// — no real waiting, no fake-timer gymnastics: tests fire the callback
// directly once armed).
// ---------------------------------------------------------------------------

export interface GoalWallClockTimerHandle {
  cancel(): void;
}

export interface GoalWallClockScheduler {
  /** Wall-clock "now" in ms; only used for bookkeeping, not for arming. */
  now(): number;
  /** Arm `callback` to fire after `ms`; returns a cancellable handle. */
  schedule(ms: number, callback: () => void): GoalWallClockTimerHandle;
}

/** Default scheduler: real `Date.now()` + `setTimeout`/`clearTimeout`. */
export function createRealGoalWallClockScheduler(): GoalWallClockScheduler {
  return {
    now: () => Date.now(),
    schedule: (ms, callback) => {
      const handle = setTimeout(callback, Math.max(0, ms));
      return { cancel: () => clearTimeout(handle) };
    },
  };
}

const WALL_CLOCK_DEADLINE = Symbol('goal-wall-clock-deadline');

/** Arm one deadline timer and return a promise that resolves iff it fires first. */
function armWallClockDeadline(
  scheduler: GoalWallClockScheduler,
  remainingMs: number
): { promise: Promise<typeof WALL_CLOCK_DEADLINE>; cancel: () => void } {
  let handle: GoalWallClockTimerHandle | undefined;
  const promise = new Promise<typeof WALL_CLOCK_DEADLINE>((resolve) => {
    handle = scheduler.schedule(Math.max(0, remainingMs), () => resolve(WALL_CLOCK_DEADLINE));
  });
  return { promise, cancel: () => handle?.cancel() };
}

// ---------------------------------------------------------------------------
// KD-02: token-usage estimation seam
// ---------------------------------------------------------------------------

/** Injectable estimator for how many tokens a completed turn cost. */
export type EstimateGoalTurnTokens = (input: {
  prompt: string;
  result: Pick<GenerateWithToolsResult, 'text' | 'toolCalls'>;
}) => number;

/**
 * Default token estimator (KD-02 seam). `ReasoningBackend.generateWithTools()`
 * does not surface usage to its caller — real usage IS metered, but only
 * out-of-band via `metrics.record(...)` inside the backend implementation
 * (see `anthropic-reasoning-backend.ts`'s `recordSdkUsage`), never returned in
 * `GenerateWithToolsResult`. Absent an observable figure at the driver's
 * vantage point, this estimates a turn's token cost from prompt + response
 * text length, reusing the ~3-chars/token heuristic `estimateTokens` already
 * uses for compaction triggering (worker-context-compaction.ts) — a
 * governance-grade approximation, not a billing-grade one. Callers whose
 * backend does expose real usage should inject their own `estimateTurnTokens`
 * via `RunGoalDrivenLoopOptions` instead of relying on this default.
 */
export function estimateGoalTurnTokensFromText(input: {
  prompt: string;
  result: Pick<GenerateWithToolsResult, 'text' | 'toolCalls'>;
}): number {
  const responseText = [
    input.result.text ?? '',
    ...(input.result.toolCalls ?? []).map((call) => `${call.name} ${JSON.stringify(call.input)}`),
  ].join(' ');
  return estimateTokens(input.prompt) + estimateTokens(responseText);
}

/** Result of executing a non-goal, non-rewind tool call inside a goal turn. */
export interface GoalToolExecution {
  resultText: string;
  /**
   * Set true when the tool performed a real-world effect (write/apply). It is
   * recorded on the rewind context so a later `context_rewind` cannot rewind
   * across it.
   */
  externalEffect?: boolean;
  effectDescription?: string;
}

export interface GoalTurnContext {
  goal: GoalRuntimeState;
  turnNumber: number;
  checkpointId: string;
}

export interface RunGoalDrivenLoopOptions {
  objective: string;
  goalId?: string;
  missionId?: string;
  /** Stable system framing prepended to every turn's prompt. */
  systemPrompt?: string;
  /** Per-turn instruction appended after the injected goal reminders. */
  turnPrompt?: string;
  /** Extra main-worker tools exposed alongside goal_update + context_rewind. */
  extraTools?: ToolDefinition[];
  /** Execute a non-goal, non-rewind tool call and return its result. */
  executeTool?: (
    call: ToolCall,
    ctx: GoalTurnContext
  ) => Promise<GoalToolExecution> | GoalToolExecution;
  /** Backend override; defaults to the real getReasoningBackend(). */
  backend?: Pick<ReasoningBackend, 'generateWithTools'>;
  /** Event stream override; defaults to the process-wide worker event stream. */
  stream?: WorkerEventStream;
  /** Injection registry override; defaults to mission-scoped or the global one. */
  injectionRegistry?: DynamicInjectionRegistry;
  /** Rewind context override; defaults to a fresh one. */
  rewindContext?: RewindableWorkerContext;
  repeatGovernorConfig?: ToolCallRepeatGovernorConfig;
  blockedPersistTurns?: number;
  /** Hard safety bound on turns; a goal still active at the bound is paused. */
  maxTurns?: number;
  /** KD-02: opt-in multi-turn goal budgets. Never invented — omit to keep
   * KD-01's unbounded-except-maxTurns behavior. */
  budget?: GoalBudgetLimits;
  /** KD-02: injectable token-usage estimator; defaults to
   * {@link estimateGoalTurnTokensFromText} (see its doc comment for the seam). */
  estimateTurnTokens?: EstimateGoalTurnTokens;
  /** KD-02: injectable wall-clock scheduler for the deadline mechanism;
   * defaults to real `setTimeout`. Tests inject a fake one for hermetic runs. */
  wallClockScheduler?: GoalWallClockScheduler;
  /** Resume from a persisted goal (post-restart replay). */
  resumeFrom?: GoalRuntimeState;
  /**
   * Explicitly resume a paused goal. Without it, a resumed `active` goal is
   * demoted to `paused` and the driver does NOT self-advance (returns at once).
   */
  resume?: boolean;
  /**
   * Escalate a blocked goal to its mission. The mission owner mutates
   * `context.blockers` via mission_controller — the worker never mutates
   * mission-wide state directly.
   */
  reportBlockerToMission?: (state: GoalRuntimeState) => void;
  now?: () => string;
}

export interface GoalDrivenLoopResult {
  goalId: string;
  finalState: GoalState;
  goal: GoalRuntimeState;
  /** Number of turns actually driven (turn_begin count). */
  turnsRun: number;
  rewindCount: number;
  /** Goal record fit for persistence at rest (null when complete/cleared). */
  persisted: GoalRuntimeState | null;
  /** KD-02: the grace-step/final-turn prose report, when the goal ended via a
   * budget-reached `blocked` (undefined for every other termination path). */
  finalReport?: string;
}

const DEFAULT_MAX_TURNS = 100;
const CONTEXT_REWIND_TOOL_NAME = 'context_rewind';

/** The tool surface exposed to the MAIN worker goal loop (never to subagents). */
export function buildMainWorkerGoalTools(
  extraTools: readonly ToolDefinition[] = []
): ToolDefinition[] {
  return [buildGoalUpdateToolDefinition(), buildContextRewindToolDefinition(), ...extraTools];
}

function resolveInjectionRegistry(
  override: DynamicInjectionRegistry | undefined,
  missionId: string | undefined
): DynamicInjectionRegistry {
  if (override) return override;
  if (missionId) return getMissionDynamicInjectionRegistry(missionId);
  return getDefaultDynamicInjectionRegistry();
}

/**
 * Drive a goal to a terminal state (`complete` / `blocked` / `paused`).
 *
 * Termination rules:
 *  - `complete`  — model reported structured complete; goal is cleared.
 *  - `blocked`   — model reported a blocker that met the persistence threshold
 *    (or is intrinsically impossible); escalated to the mission when present.
 *  - `paused`    — technical stop: repeat-governor force-stop, or the max-turns
 *    safety bound, or a resume-halt when a paused goal is not explicitly resumed.
 */
export async function runGoalDrivenLoop(
  options: RunGoalDrivenLoopOptions
): Promise<GoalDrivenLoopResult> {
  const stream = options.stream ?? getDefaultWorkerEventStream();
  const backend = options.backend ?? getReasoningBackend();
  if (!backend.generateWithTools) {
    throw new Error(
      '[GOAL_DRIVER] backend lacks generateWithTools — a goal loop needs a tool-use backend'
    );
  }
  const now = options.now;
  const source: WorkerEventSource | undefined = options.missionId
    ? { mission_id: options.missionId }
    : undefined;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;

  // Establish the goal state, honoring a resume from a persisted record.
  let goal: GoalRuntimeState;
  if (options.resumeFrom) {
    // A persisted 'active' means the prior process died mid-turn: demote first.
    goal = demoteActiveOnResume(options.resumeFrom, now);
    if (goal.state === 'paused' && options.resume) {
      goal = resumeGoal(goal, now);
    }
    if (goal.state !== 'active') {
      // Not explicitly resumed (or terminal): do NOT self-advance.
      stream.emit(
        'status_update',
        {
          goal_event: 'resume_paused',
          goal_id: goal.goalId,
          state: goal.state,
          terminal_reason: goal.terminalReason ?? '',
        },
        source
      );
      return {
        goalId: goal.goalId,
        finalState: goal.state,
        goal,
        turnsRun: 0,
        rewindCount: options.rewindContext?.rewindCount ?? 0,
        persisted: serializeGoalStateForPersistence(goal),
      };
    }
  } else {
    goal = createGoal({
      goalId: options.goalId ?? `goal-${Date.now()}`,
      objective: options.objective,
      missionId: options.missionId,
      budget: options.budget,
      now,
    });
    stream.emit(
      'status_update',
      { goal_event: 'created', goal_id: goal.goalId, state: goal.state },
      source
    );
  }
  // KD-02: attach/refresh the opt-in budget even on a resumed goal, so a
  // caller may (re)supply it across a process restart. Absent options.budget,
  // whatever the persisted record already carried (if anything) is kept.
  if (options.budget) {
    goal = { ...goal, budget: options.budget };
  }

  const budgetLimits = goal.budget;
  const wallClockScheduler = options.wallClockScheduler ?? createRealGoalWallClockScheduler();
  const estimateTurnTokens = options.estimateTurnTokens ?? estimateGoalTurnTokensFromText;
  let graceStepUsed = false;
  let finalReport: string | undefined;

  const rewindContext = options.rewindContext ?? new RewindableWorkerContext([], options.missionId);
  const registry = resolveInjectionRegistry(options.injectionRegistry, options.missionId);
  const tools = buildMainWorkerGoalTools(options.extraTools);

  // Live view of the goal + current checkpoints, read by the injection
  // providers so goal state is injected only at the (collected) turn boundary.
  const live: { state: GoalRuntimeState; checkpointIds: string[] } = {
    state: goal,
    checkpointIds: [],
  };

  // Trusted goal-status provider (re-audit contract + state line).
  const statusProvider: DynamicInjectionProvider = {
    id: `worker-goal-status:${goal.goalId}`,
    collect: () => buildGoalStatusReminder(live.state, live.checkpointIds),
  };
  // Untrusted objective provider — framed via KD-04 (buildUntrustedDataInjectionProvider).
  const objectiveProvider = buildUntrustedDataInjectionProvider(
    `worker-goal-objective:${goal.goalId}`,
    'goal objective',
    () => live.state.objective
  );

  const unregister: Array<() => void> = [];
  let govState: ToolCallRepeatGovernorState = createToolCallRepeatGovernorState();
  let turnsRun = 0;

  /**
   * KD-02 mechanism 1 (grace step): called after a turn that left the goal
   * `active` (continue / blocked_rejected). Returns true when the goal was
   * just settled to a budget-reached `blocked` (caller must stop looping).
   */
  async function maybeTerminateOnBudget(
    turnResult: GenerateWithToolsResult,
    hadToolCalls: boolean
  ): Promise<boolean> {
    if (!budgetLimits) return false;
    const check = checkGoalBudgetReached(budgetLimits, goal.budgetStats);
    if (!check.reached) return false;
    const reason = check.reason ?? 'goal budget reached';
    stream.emit(
      'status_update',
      { goal_event: 'budget_reached', goal_id: goal.goalId, reason },
      source
    );

    let report: string | undefined = turnResult.text?.trim() || undefined;

    if (hadToolCalls && !graceStepUsed) {
      graceStepUsed = true;
      const graceTurnNumber = goal.turnCount + 1;
      turnsRun += 1;
      stream.emit(
        'turn_begin',
        { goal_id: goal.goalId, turn: graceTurnNumber, grace_step: true },
        source
      );

      live.state = goal; // keep the status provider's view current for the grace prompt
      const graceInjections = registry.collect({ step: goal.turnCount });
      const gracePrompt = [
        options.systemPrompt ?? '',
        renderInjectionsAsSystemReminders(graceInjections),
        GOAL_BUDGET_GRACE_STEP_PROMPT,
        options.turnPrompt ?? '',
      ]
        .filter((part) => part && part.trim())
        .join('\n\n');

      const graceResult = await backend.generateWithTools(gracePrompt, tools);
      for (const call of graceResult.toolCalls ?? []) {
        // Synthetic rejection: never executed, never applied (not even
        // goal_update) — the model was told tools would be rejected this turn.
        stream.emit(
          'status_update',
          { goal_event: 'grace_tool_rejected', goal_id: goal.goalId, tool: call.name },
          source
        );
      }
      report = graceResult.text?.trim() || report;

      stream.emit(
        'turn_end',
        { goal_id: goal.goalId, turn: graceTurnNumber, applied: 'grace' },
        source
      );
    }

    goal = blockGoalOnBudget(goal, reason, now);
    finalReport = report;
    stream.emit(
      'status_update',
      {
        goal_event: 'blocked',
        goal_id: goal.goalId,
        terminal_reason: reason,
        final_report: report ?? '',
      },
      source
    );
    return true;
  }

  try {
    unregister.push(registry.register(statusProvider));
    unregister.push(registry.register(objectiveProvider));

    while (goal.state === 'active' && goal.turnCount < maxTurns) {
      const turnNumber = goal.turnCount + 1;
      turnsRun += 1;
      rewindContext.beginTurn();
      const checkpointId = rewindContext.checkpoint();
      live.state = goal;
      live.checkpointIds = [checkpointId];

      stream.emit('turn_begin', { goal_id: goal.goalId, turn: turnNumber }, source);

      const injections = registry.collect({ step: goal.turnCount });
      const prompt = [
        options.systemPrompt ?? '',
        renderInjectionsAsSystemReminders(injections),
        options.turnPrompt ?? '',
      ]
        .filter((part) => part && part.trim())
        .join('\n\n');

      let signal: GoalUpdateSignal | null = null;
      let forceStopTool: string | undefined;

      // KD-02 mechanism 3 (wall-clock deadline): race the live turn against a
      // timer armed for the remaining budget. If the timer wins, the turn is
      // treated as cancelled — its eventual real resolution (if the backend
      // ever settles) is never awaited further or applied to the goal.
      const turnStartMs = wallClockScheduler.now();
      let result: GenerateWithToolsResult;
      let wallClockDeadlineHit = false;
      if (budgetLimits?.wallClockBudgetMs !== undefined) {
        const remainingMs =
          budgetLimits.wallClockBudgetMs - (goal.budgetStats?.wallClockMsUsed ?? 0);
        const deadline = armWallClockDeadline(wallClockScheduler, remainingMs);
        const raced = await Promise.race([
          backend.generateWithTools(prompt, tools),
          deadline.promise,
        ]);
        deadline.cancel();
        if (raced === WALL_CLOCK_DEADLINE) {
          wallClockDeadlineHit = true;
          result = {};
        } else {
          result = raced as GenerateWithToolsResult;
        }
      } else {
        result = await backend.generateWithTools(prompt, tools);
      }

      if (wallClockDeadlineHit) {
        const reason = `goal budget reached: wall-clock budget ${budgetLimits!.wallClockBudgetMs}ms`;
        stream.emit(
          'status_update',
          { goal_event: 'budget_reached', goal_id: goal.goalId, reason },
          source
        );
        goal = blockGoalOnBudget(goal, reason, now);
        finalReport = undefined; // a truly cancelled call has no prose to report
        stream.emit(
          'turn_end',
          { goal_id: goal.goalId, turn: turnNumber, applied: 'wallclock_cancelled' },
          source
        );
        stream.emit(
          'status_update',
          { goal_event: 'blocked', goal_id: goal.goalId, terminal_reason: reason },
          source
        );
        break;
      }

      const thisTurnHadToolCalls = (result.toolCalls?.length ?? 0) > 0;
      if (budgetLimits) {
        const elapsedMs = wallClockScheduler.now() - turnStartMs;
        const tokens = estimateTurnTokens({ prompt, result });
        goal = accrueGoalBudgetUsage(goal, { tokens, turns: 1, wallClockMs: elapsedMs });
      }

      for (const call of result.toolCalls ?? []) {
        const decision = advanceToolCallRepeatGovernor(
          govState,
          call.name,
          call.input,
          options.repeatGovernorConfig
        );
        govState = decision.state;
        if (decision.should_force_stop) {
          forceStopTool = call.name;
          break;
        }
        if (call.name === GOAL_UPDATE_TOOL_NAME) {
          const parsed = parseGoalUpdateSignal(call.input);
          if (parsed) signal = parsed; // last structured signal wins
        } else if (call.name === CONTEXT_REWIND_TOOL_NAME) {
          const checkpoint = String((call.input as Record<string, unknown>).checkpoint_id ?? '');
          const lesson = String((call.input as Record<string, unknown>).lesson ?? '');
          // Existing guards (one-per-turn, external-effect, lesson length)
          // stay intact; the module emits its own context_rewind event.
          rewindContext.rewindTo(checkpoint, lesson);
        } else if (options.executeTool) {
          const exec = await options.executeTool(call, { goal, turnNumber, checkpointId });
          if (exec.externalEffect) rewindContext.recordExternalEffect(exec.effectDescription);
        }
      }

      if (forceStopTool) {
        goal = pauseGoal(goal, `tool-call repeat governor force-stop on '${forceStopTool}'`, now);
        stream.emit(
          'status_update',
          { goal_event: 'paused', goal_id: goal.goalId, reason: goal.terminalReason ?? '' },
          source
        );
        break;
      }

      // A signal-less turn (prose only) is a `continue` — completion claims in
      // natural language never end the goal.
      const effectiveSignal: GoalUpdateSignal = signal ?? { status: 'continue' };
      const outcome = applyGoalUpdate(goal, effectiveSignal, {
        blockedPersistTurns: options.blockedPersistTurns,
        now,
      });
      goal = outcome.state;

      if (outcome.kind === 'complete') {
        stream.emit(
          'turn_end',
          { goal_id: goal.goalId, turn: turnNumber, applied: 'complete' },
          source
        );
        stream.emit('status_update', { goal_event: 'completed', goal_id: goal.goalId }, source);
        // `complete` is transient: clear the goal (goal clear).
        stream.emit('status_update', { goal_event: 'cleared', goal_id: goal.goalId }, source);
        break;
      }

      if (outcome.kind === 'blocked') {
        stream.emit(
          'turn_end',
          { goal_id: goal.goalId, turn: turnNumber, applied: 'blocked' },
          source
        );
        stream.emit(
          'status_update',
          {
            goal_event: 'blocked',
            goal_id: goal.goalId,
            terminal_reason: goal.terminalReason ?? '',
          },
          source
        );
        if (options.missionId) {
          // Escalate to the mission; the owner writes context.blockers via
          // mission_controller — the worker never mutates it directly.
          stream.emit(
            'mission_event',
            {
              kind: 'goal_blocked',
              goal_id: goal.goalId,
              blocker: goal.terminalReason ?? '',
            },
            source
          );
          try {
            options.reportBlockerToMission?.(goal);
          } catch (err) {
            logger.warn(
              `[goal-driver] reportBlockerToMission failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        break;
      }

      if (outcome.kind === 'blocked_rejected') {
        stream.emit(
          'status_update',
          {
            goal_event: 'blocked_rejected',
            goal_id: goal.goalId,
            blocked_streak: outcome.blockedStreak,
            blocked_threshold: outcome.blockedThreshold,
          },
          source
        );
        goal = incrementGoalTurn(goal, now);
        stream.emit(
          'turn_end',
          { goal_id: goal.goalId, turn: turnNumber, applied: 'blocked_rejected' },
          source
        );
        if (await maybeTerminateOnBudget(result, thisTurnHadToolCalls)) break;
        continue;
      }

      // continue
      goal = incrementGoalTurn(goal, now);
      stream.emit(
        'turn_end',
        { goal_id: goal.goalId, turn: turnNumber, applied: 'continue' },
        source
      );
      if (await maybeTerminateOnBudget(result, thisTurnHadToolCalls)) break;
    }

    if (goal.state === 'active') {
      // Hit the safety bound with the goal still active: technical pause.
      goal = pauseGoal(goal, `max turns reached (${maxTurns})`, now);
      stream.emit(
        'status_update',
        { goal_event: 'paused', goal_id: goal.goalId, reason: goal.terminalReason ?? '' },
        source
      );
    }
  } finally {
    for (const off of unregister) {
      try {
        off();
      } catch {
        /* registry cleanup is best-effort */
      }
    }
  }

  return {
    goalId: goal.goalId,
    finalState: goal.state,
    goal,
    turnsRun,
    rewindCount: rewindContext.rewindCount,
    persisted: serializeGoalStateForPersistence(goal),
    ...(finalReport !== undefined ? { finalReport } : {}),
  };
}
