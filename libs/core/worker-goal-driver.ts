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
import type { ReasoningBackend, ToolCall, ToolDefinition } from './reasoning-backend.js';
import {
  advanceToolCallRepeatGovernor,
  createToolCallRepeatGovernorState,
  type ToolCallRepeatGovernorConfig,
  type ToolCallRepeatGovernorState,
} from './tool-call-repeat-governor.js';
import {
  applyGoalUpdate,
  buildGoalStatusReminder,
  buildGoalUpdateToolDefinition,
  createGoal,
  demoteActiveOnResume,
  GOAL_UPDATE_TOOL_NAME,
  incrementGoalTurn,
  parseGoalUpdateSignal,
  pauseGoal,
  resumeGoal,
  serializeGoalStateForPersistence,
  type GoalRuntimeState,
  type GoalState,
  type GoalUpdateSignal,
} from './worker-goal.js';
import {
  getDefaultWorkerEventStream,
  type WorkerEventSource,
  type WorkerEventStream,
} from './worker-event-stream.js';

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
      now,
    });
    stream.emit(
      'status_update',
      { goal_event: 'created', goal_id: goal.goalId, state: goal.state },
      source
    );
  }

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

      const result = await backend.generateWithTools(prompt, tools);
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
        continue;
      }

      // continue
      goal = incrementGoalTurn(goal, now);
      stream.emit(
        'turn_end',
        { goal_id: goal.goalId, turn: turnNumber, applied: 'continue' },
        source
      );
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
  };
}
