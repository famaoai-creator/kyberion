import { describe, expect, it } from 'vitest';

import {
  applyGoalUpdate,
  buildGoalStatusReminder,
  buildGoalUpdateToolDefinition,
  createGoal,
  demoteActiveOnResume,
  GOAL_BLOCKED_PERSIST_TURNS,
  GOAL_CANCEL_SYSTEM_REMINDER,
  GOAL_CONTINUATION_REAUDIT_PROMPT,
  GOAL_UPDATE_TOOL_NAME,
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
