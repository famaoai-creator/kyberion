import { describe, expect, it } from 'vitest';

import {
  accrueGoalBudgetUsage,
  applyGoalUpdate,
  blockGoalOnBudget,
  buildGoalStatusReminder,
  buildGoalUpdateToolDefinition,
  checkGoalBudgetReached,
  createGoal,
  createGoalBudgetStats,
  demoteActiveOnResume,
  GOAL_BLOCKED_PERSIST_TURNS,
  GOAL_BUDGET_GRACE_STEP_PROMPT,
  GOAL_CANCEL_SYSTEM_REMINDER,
  GOAL_CONTINUATION_REAUDIT_PROMPT,
  GOAL_CONVERGENCE_MODE_PROMPT,
  GOAL_CONVERGENCE_THRESHOLD_RATIO,
  GOAL_STEADY_PROGRESS_PROMPT,
  GOAL_UPDATE_TOOL_NAME,
  goalBudgetUsageRatio,
  incrementGoalTurn,
  parseGoalUpdateSignal,
  pauseGoal,
  restoreGoalState,
  resumeGoal,
  serializeGoalStateForPersistence,
  type GoalRuntimeState,
} from './worker-goal.js';

const fixedNow = () => '2026-07-20T00:00:00.000Z';

function activeGoal(overrides: Partial<GoalRuntimeState> = {}): GoalRuntimeState {
  return {
    ...createGoal({ goalId: 'g1', objective: 'do the thing', now: fixedNow }),
    ...overrides,
  };
}

describe('parseGoalUpdateSignal', () => {
  it('accepts the three valid statuses and ignores unknown fields', () => {
    expect(parseGoalUpdateSignal({ status: 'continue' })).toEqual({ status: 'continue' });
    expect(parseGoalUpdateSignal({ status: 'complete', reason: 'verified' })).toEqual({
      status: 'complete',
      reason: 'verified',
    });
    expect(
      parseGoalUpdateSignal({ status: 'blocked', reason: 'need key', impossible: true })
    ).toEqual({
      status: 'blocked',
      reason: 'need key',
      impossible: true,
    });
  });

  it('rejects malformed / absent signals (null => treated as continue by the driver)', () => {
    expect(parseGoalUpdateSignal(null)).toBeNull();
    expect(parseGoalUpdateSignal({})).toBeNull();
    expect(parseGoalUpdateSignal({ status: 'done' })).toBeNull();
    expect(parseGoalUpdateSignal('complete')).toBeNull();
  });
});

describe('applyGoalUpdate — completion', () => {
  it('transitions to complete only on a structured complete signal', () => {
    const outcome = applyGoalUpdate(
      activeGoal(),
      { status: 'complete', reason: 'all checks pass' },
      {
        now: fixedNow,
      }
    );
    expect(outcome.kind).toBe('complete');
    expect(outcome.state.state).toBe('complete');
    expect(outcome.state.terminalReason).toBe('all checks pass');
  });

  it('continue resets the blocked streak', () => {
    const primed = activeGoal({ blockedStreak: 2, pendingBlockerSignature: 'x' });
    const outcome = applyGoalUpdate(primed, { status: 'continue' }, { now: fixedNow });
    expect(outcome.kind).toBe('continue');
    expect(outcome.state.blockedStreak).toBe(0);
    expect(outcome.state.pendingBlockerSignature).toBeUndefined();
  });
});

describe('applyGoalUpdate — blocked persistence threshold', () => {
  it('rejects a blocker until it recurs for the threshold count, then allows it', () => {
    let goal = activeGoal();
    // Turns 1..(threshold-1): rejected, goal stays active.
    for (let turn = 1; turn < GOAL_BLOCKED_PERSIST_TURNS; turn += 1) {
      const outcome = applyGoalUpdate(
        goal,
        { status: 'blocked', reason: 'waiting on API key' },
        {
          now: fixedNow,
        }
      );
      expect(outcome.kind).toBe('blocked_rejected');
      expect(outcome.state.state).toBe('active');
      expect(outcome.blockedStreak).toBe(turn);
      goal = outcome.state;
    }
    // Threshold turn: allowed.
    const final = applyGoalUpdate(
      goal,
      { status: 'blocked', reason: 'waiting on API key' },
      {
        now: fixedNow,
      }
    );
    expect(final.kind).toBe('blocked');
    expect(final.state.state).toBe('blocked');
    expect(final.state.terminalKind).toBe('business');
    expect(final.blockedStreak).toBe(GOAL_BLOCKED_PERSIST_TURNS);
  });

  it('a changed blocker restarts the streak', () => {
    let goal = activeGoal();
    goal = applyGoalUpdate(
      goal,
      { status: 'blocked', reason: 'reason A' },
      { now: fixedNow }
    ).state;
    const outcome = applyGoalUpdate(
      goal,
      { status: 'blocked', reason: 'reason B' },
      { now: fixedNow }
    );
    expect(outcome.kind).toBe('blocked_rejected');
    expect(outcome.blockedStreak).toBe(1);
  });

  it('an intrinsically impossible objective is blocked immediately (bypasses the threshold)', () => {
    const outcome = applyGoalUpdate(
      activeGoal(),
      { status: 'blocked', reason: 'objective contradicts itself', impossible: true },
      { now: fixedNow }
    );
    expect(outcome.kind).toBe('blocked');
    expect(outcome.state.state).toBe('blocked');
  });
});

describe('pause / resume / resume-demotion', () => {
  it('pauses only an active goal (technical terminal kind)', () => {
    const paused = pauseGoal(activeGoal(), 'provider failure', fixedNow);
    expect(paused.state).toBe('paused');
    expect(paused.terminalKind).toBe('technical');
    // Terminal goals are inert.
    expect(pauseGoal(paused, 'again', fixedNow)).toBe(paused);
  });

  it('demotes a replayed active goal to paused', () => {
    const demoted = demoteActiveOnResume(activeGoal({ turnCount: 3 }), fixedNow);
    expect(demoted.state).toBe('paused');
    expect(demoted.terminalKind).toBe('technical');
    expect(demoted.turnCount).toBe(3);
  });

  it('restoreGoalState demotes active but leaves blocked/paused untouched', () => {
    expect(restoreGoalState(activeGoal(), fixedNow).state).toBe('paused');
    const blocked = activeGoal({ state: 'blocked', terminalKind: 'business' });
    expect(restoreGoalState(blocked, fixedNow)).toEqual(blocked);
  });

  it('resumeGoal reactivates only a paused goal', () => {
    const paused = pauseGoal(activeGoal(), 'interrupt', fixedNow);
    const resumed = resumeGoal(paused, fixedNow);
    expect(resumed.state).toBe('active');
    expect(resumed.terminalReason).toBeUndefined();
  });
});

describe('persistence hygiene', () => {
  it('never persists a completed goal (complete is transient)', () => {
    const completed = applyGoalUpdate(
      activeGoal(),
      { status: 'complete' },
      { now: fixedNow }
    ).state;
    expect(serializeGoalStateForPersistence(completed)).toBeNull();
  });

  it('persists paused/blocked goals verbatim', () => {
    const paused = pauseGoal(activeGoal(), 'interrupt', fixedNow);
    expect(serializeGoalStateForPersistence(paused)).toEqual(paused);
  });
});

describe('turn accounting + prompt fragments', () => {
  it('increments the completed-turn counter', () => {
    expect(incrementGoalTurn(activeGoal({ turnCount: 4 }), fixedNow).turnCount).toBe(5);
  });

  it('exposes the goal_update tool and re-audit contract wording', () => {
    const tool = buildGoalUpdateToolDefinition();
    expect(tool.name).toBe(GOAL_UPDATE_TOOL_NAME);
    expect(tool.inputSchema.properties.status.enum).toEqual(['continue', 'complete', 'blocked']);
    expect(GOAL_CONTINUATION_REAUDIT_PROMPT).toContain('ONE bounded slice');
    expect(GOAL_CONTINUATION_REAUDIT_PROMPT).toContain(`${GOAL_BLOCKED_PERSIST_TURNS} consecutive`);
    expect(GOAL_CONTINUATION_REAUDIT_PROMPT).toContain('is NOT complete');
    expect(GOAL_CANCEL_SYSTEM_REMINDER).toContain('Ignore all earlier active-goal reminders');
  });

  it('status reminder omits the objective text (framed separately) and shows streak/checkpoints', () => {
    const reminder = buildGoalStatusReminder(activeGoal({ blockedStreak: 2 }), ['ckpt-0']);
    expect(reminder).toContain('goal_state: active');
    expect(reminder).toContain('blocked_streak: 2/');
    expect(reminder).toContain('rewind_checkpoints: ckpt-0');
    expect(reminder).not.toContain('do the thing');
  });
});

describe('KD-02: goal budgets — opt-in, never invented', () => {
  it('createGoal omits `budget` entirely when none is supplied', () => {
    const goal = createGoal({ goalId: 'g-nobudget', objective: 'do the thing', now: fixedNow });
    expect(goal.budget).toBeUndefined();
    expect(goalBudgetUsageRatio(goal.budget, goal.budgetStats)).toBe(0);
    expect(checkGoalBudgetReached(goal.budget, goal.budgetStats)).toEqual({ reached: false });
  });

  it('createGoal carries an explicitly supplied budget verbatim', () => {
    const goal = createGoal({
      goalId: 'g-budget',
      objective: 'do the thing',
      budget: { tokenBudget: 500_000 },
      now: fixedNow,
    });
    expect(goal.budget).toEqual({ tokenBudget: 500_000 });
  });
});

describe('KD-02: goalBudgetUsageRatio / checkGoalBudgetReached', () => {
  it('reports 0 with no stats and ignores unset budget dimensions', () => {
    expect(goalBudgetUsageRatio({ tokenBudget: 1000 }, undefined)).toBe(0);
    expect(
      goalBudgetUsageRatio(
        { tokenBudget: 1000 },
        { tokensUsed: 0, turnsUsed: 999, wallClockMsUsed: 999 }
      )
    ).toBe(0);
  });

  it('takes the max ratio across every configured dimension', () => {
    const stats = { tokensUsed: 100, turnsUsed: 9, wallClockMsUsed: 1000 };
    const ratio = goalBudgetUsageRatio(
      { tokenBudget: 1000, turnBudget: 10, wallClockBudgetMs: 100_000 },
      stats
    );
    expect(ratio).toBeCloseTo(0.9); // turn dimension (9/10) is the tightest
  });

  it('checks token/turn/wall-clock reach in a stable, deterministic order', () => {
    expect(
      checkGoalBudgetReached(
        { tokenBudget: 100 },
        { tokensUsed: 100, turnsUsed: 0, wallClockMsUsed: 0 }
      )
    ).toEqual({ reached: true, reason: 'goal budget reached: token budget 100' });
    expect(
      checkGoalBudgetReached({ turnBudget: 5 }, { tokensUsed: 0, turnsUsed: 5, wallClockMsUsed: 0 })
    ).toEqual({ reached: true, reason: 'goal budget reached: turn budget 5' });
    expect(
      checkGoalBudgetReached(
        { wallClockBudgetMs: 60_000 },
        { tokensUsed: 0, turnsUsed: 0, wallClockMsUsed: 60_000 }
      )
    ).toEqual({ reached: true, reason: 'goal budget reached: wall-clock budget 60000ms' });
    // not yet reached
    expect(
      checkGoalBudgetReached(
        { tokenBudget: 100 },
        { tokensUsed: 99, turnsUsed: 0, wallClockMsUsed: 0 }
      )
    ).toEqual({ reached: false });
  });
});

describe('KD-02: accrueGoalBudgetUsage — accrues only while active', () => {
  it('adds usage deltas onto existing stats', () => {
    const goal = activeGoal({ budgetStats: createGoalBudgetStats() });
    const next = accrueGoalBudgetUsage(goal, { tokens: 40, turns: 1, wallClockMs: 250 });
    expect(next.budgetStats).toEqual({ tokensUsed: 40, turnsUsed: 1, wallClockMsUsed: 250 });
    const again = accrueGoalBudgetUsage(next, { tokens: 10, turns: 1, wallClockMs: 50 });
    expect(again.budgetStats).toEqual({ tokensUsed: 50, turnsUsed: 2, wallClockMsUsed: 300 });
  });

  it('is a no-op once the goal is no longer active', () => {
    const blocked = blockGoalOnBudget(
      activeGoal(),
      'goal budget reached: token budget 100',
      fixedNow
    );
    const unchanged = accrueGoalBudgetUsage(blocked, { tokens: 999 });
    expect(unchanged).toBe(blocked); // same reference: guaranteed no mutation attempted
  });
});

describe('KD-02: blockGoalOnBudget — BUSINESS stop, mirrors pauseGoal', () => {
  it('blocks an active goal with a business terminal kind and the given reason', () => {
    const blocked = blockGoalOnBudget(
      activeGoal(),
      'goal budget reached: token budget 500000',
      fixedNow
    );
    expect(blocked.state).toBe('blocked');
    expect(blocked.terminalKind).toBe('business');
    expect(blocked.terminalReason).toBe('goal budget reached: token budget 500000');
  });

  it('is a no-op on an already-terminated goal', () => {
    const paused = pauseGoal(activeGoal(), 'interrupted', fixedNow);
    expect(blockGoalOnBudget(paused, 'goal budget reached', fixedNow)).toBe(paused);
  });
});

describe('KD-02: convergence-mode wording flips exactly at 75%, not before', () => {
  it('shows steady-progress wording below the threshold', () => {
    const goal = activeGoal({
      budget: { tokenBudget: 400 },
      budgetStats: { tokensUsed: 299, turnsUsed: 0, wallClockMsUsed: 0 }, // ratio 0.7475
    });
    expect(goalBudgetUsageRatio(goal.budget, goal.budgetStats)).toBeLessThan(
      GOAL_CONVERGENCE_THRESHOLD_RATIO
    );
    const reminder = buildGoalStatusReminder(goal);
    expect(reminder).toContain(GOAL_STEADY_PROGRESS_PROMPT);
    expect(reminder).not.toContain(GOAL_CONVERGENCE_MODE_PROMPT);
  });

  it('flips to convergence wording at exactly the 75% threshold', () => {
    const goal = activeGoal({
      budget: { tokenBudget: 400 },
      budgetStats: { tokensUsed: 300, turnsUsed: 0, wallClockMsUsed: 0 }, // ratio exactly 0.75
    });
    expect(goalBudgetUsageRatio(goal.budget, goal.budgetStats)).toBe(
      GOAL_CONVERGENCE_THRESHOLD_RATIO
    );
    const reminder = buildGoalStatusReminder(goal);
    expect(reminder).toContain(GOAL_CONVERGENCE_MODE_PROMPT);
    expect(reminder).not.toContain(GOAL_STEADY_PROGRESS_PROMPT);
  });

  it('stays in convergence wording past the threshold', () => {
    const goal = activeGoal({
      budget: { turnBudget: 4 },
      budgetStats: { tokensUsed: 0, turnsUsed: 4, wallClockMsUsed: 0 }, // ratio 1.0
    });
    expect(buildGoalStatusReminder(goal)).toContain(GOAL_CONVERGENCE_MODE_PROMPT);
  });

  it('omits budget-mode wording entirely when no budget is configured', () => {
    const reminder = buildGoalStatusReminder(activeGoal());
    expect(reminder).not.toContain(GOAL_STEADY_PROGRESS_PROMPT);
    expect(reminder).not.toContain(GOAL_CONVERGENCE_MODE_PROMPT);
  });
});

describe('KD-02: grace-step reminder wording', () => {
  it('tells the model tools will be rejected and to write a final status in prose', () => {
    expect(GOAL_BUDGET_GRACE_STEP_PROMPT).toContain('synthetically rejected');
    expect(GOAL_BUDGET_GRACE_STEP_PROMPT).toContain('final status');
    expect(GOAL_BUDGET_GRACE_STEP_PROMPT).toContain('Do not call goal_update');
  });
});
