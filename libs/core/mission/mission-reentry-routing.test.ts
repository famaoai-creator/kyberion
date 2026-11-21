import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '../secure-io.js';
import type { ReviewReentryRequest } from '../workforce/review-reentry.js';

const boardState = vi.hoisted(() => ({
  tasks: [] as Array<Record<string, unknown>>,
}));

vi.mock('./mission-lifecycle-completion.js', () => ({
  isTaskSuperseded: (task: { status?: unknown } | null | undefined) =>
    String(task?.status || '').toLowerCase() === 'superseded',
  writeMissionNextTasks: (
    _missionDir: string,
    tasksOrUpdater:
      | Array<Record<string, unknown>>
      | ((current: Array<Record<string, unknown>>) => Array<Record<string, unknown>>)
  ) => {
    boardState.tasks =
      typeof tasksOrUpdater === 'function'
        ? tasksOrUpdater(structuredClone(boardState.tasks))
        : tasksOrUpdater;
    return true;
  },
}));

const {
  dispatchReviewReentryWithPolicy,
  isChangeLevelReentryRoutingEnabled,
  upsertChangeLevelReentryTasks,
} = await import('./mission-reentry-routing.js');

function makeRequest(
  overrides: Partial<ReviewReentryRequest> & {
    reason_category?: ReviewReentryRequest['reason_category'];
  }
): ReviewReentryRequest {
  return {
    request_id: `req-${randomUUID()}`,
    mission_id: 'MSN-REENTRY-TEST',
    artifact_id: 'artifact-v1',
    verdict: 'reject',
    comment: 'needs revision',
    reviewer: 'human:tester',
    requested_at: '2026-11-21T00:00:00.000Z',
    status: 'pending',
    ...overrides,
  };
}

describe('opt-in change-level review re-entry routing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = pathResolver.sharedTmp(`kyberion-reentry-route-${process.pid}-${randomUUID()}`);
    safeMkdir(tmpDir, { recursive: true });
    boardState.tasks = [];
  });

  afterEach(() => {
    safeRmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to disabled and honors state context, non-symlink brief, and override', () => {
    expect(isChangeLevelReentryRoutingEnabled({ missionDir: tmpDir })).toBe(false);
    expect(
      isChangeLevelReentryRoutingEnabled({
        missionDir: tmpDir,
        state: { context: { requirements_change_level_routing: true } },
      })
    ).toBe(true);

    const evidenceDir = path.join(tmpDir, 'evidence');
    safeMkdir(evidenceDir, { recursive: true });
    const briefPath = path.join(evidenceDir, 'mission-brief.json');
    safeWriteFile(
      briefPath,
      JSON.stringify({ requirementsGovernance: { changeLevelRouting: true } })
    );
    expect(isChangeLevelReentryRoutingEnabled({ missionDir: tmpDir })).toBe(true);
    expect(isChangeLevelReentryRoutingEnabled({ missionDir: tmpDir, override: false })).toBe(false);

    // Symlink brief must fail closed to disabled.
    const outsidePath = path.join(tmpDir, 'outside-brief.json');
    safeWriteFile(
      outsidePath,
      JSON.stringify({ requirementsGovernance: { changeLevelRouting: true } })
    );
    safeRmSync(briefPath, { force: true });
    safeSymlinkSync(outsidePath, briefPath);
    expect(isChangeLevelReentryRoutingEnabled({ missionDir: tmpDir })).toBe(false);
  });

  it('routes L1 wrong_direction rejections to product_strategist re-alignment and requires re-approval', () => {
    const plan = upsertChangeLevelReentryTasks({
      missionDir: tmpDir,
      round: 1,
      requests: [
        makeRequest({
          reason_category: 'wrong_direction',
          comment: 'Goal drifted away from non-blocking opt-in mandate',
        }),
      ],
      goal: { summary: 'Add opt-in checks', success_condition: 'Legacy loops unchanged' },
    });

    expect(plan.highestLevel).toBe('L1_goal_purpose');
    expect(plan.requiresAlignmentReapproval).toBe(true);
    expect(plan.taskIds).toEqual(['review-l1-r1-1', 'review-l1-r1-1-review']);
    expect(boardState.tasks).toHaveLength(2);
    expect(boardState.tasks[0]).toMatchObject({
      task_id: 'review-l1-r1-1',
      assigned_to: { role: 'product_strategist' },
      phase_kind: 'alignment',
      change_level: 'L1_goal_purpose',
      requires_human_reapproval: true,
    });
    expect(boardState.tasks[1]).toMatchObject({
      task_id: 'review-l1-r1-1-review',
      assigned_to: { role: 'reviewer' },
      dependencies: ['review-l1-r1-1'],
      review_target: 'review-l1-r1-1',
    });
  });

  it('routes L2 scope rejections through product_strategist spec -> implementer -> reviewer', () => {
    const plan = upsertChangeLevelReentryTasks({
      missionDir: tmpDir,
      round: 2,
      requests: [
        makeRequest({ reason_category: 'scope', comment: 'Need CLI flag --strict-framing' }),
      ],
      goal: { summary: 'Alignment framing gate', success_condition: 'CLI & JSON gate aligned' },
    });

    expect(plan.highestLevel).toBe('L2_requirement_process');
    expect(plan.requiresAlignmentReapproval).toBe(false);
    expect(plan.taskIds).toEqual([
      'review-l2-r2-1-spec',
      'review-l2-r2-1',
      'review-l2-r2-1-review',
    ]);
    expect(boardState.tasks[0]).toMatchObject({
      task_id: 'review-l2-r2-1-spec',
      assigned_to: { role: 'product_strategist' },
      change_level: 'L2_requirement_process',
    });
    expect(boardState.tasks[1]).toMatchObject({
      task_id: 'review-l2-r2-1',
      assigned_to: { role: 'implementer' },
      dependencies: ['review-l2-r2-1-spec'],
      change_level: 'L2_requirement_process',
    });
    expect(boardState.tasks[2]).toMatchObject({
      task_id: 'review-l2-r2-1-review',
      assigned_to: { role: 'reviewer' },
      dependencies: ['review-l2-r2-1'],
      review_target: 'review-l2-r2-1',
    });
  });

  it('routes L3 quality/content rejections to bounded implementer fix -> reviewer and preserves superseded tasks', () => {
    boardState.tasks = [
      { task_id: 'review-l3-r1-1', status: 'superseded', assigned_to: { role: 'implementer' } },
    ];
    const plan = upsertChangeLevelReentryTasks({
      missionDir: tmpDir,
      round: 1,
      requests: [
        makeRequest({ reason_category: 'quality', comment: 'Superseded item should stay skipped' }),
        makeRequest({ reason_category: 'incorrect_content', comment: 'Fix typo in output' }),
      ],
      goal: { summary: 'Fix defect', success_condition: 'Tests pass' },
    });

    expect(plan.highestLevel).toBe('L3_implementation_model');
    expect(plan.requiresAlignmentReapproval).toBe(false);
    expect(plan.taskIds).toEqual(['review-l3-r1-2', 'review-l3-r1-2-review']);
    expect(boardState.tasks.find((t) => t.task_id === 'review-l3-r1-1')?.status).toBe('superseded');
    expect(boardState.tasks.find((t) => t.task_id === 'review-l3-r1-1-review')).toBeUndefined();
  });

  it('keeps legacy goal-gap dispatch when opted out and switches to paused L1 dispatch when opted in', () => {
    const legacySpy = vi.fn(() => ['goal-gap-r1-1', 'goal-gap-r1-1-review']);
    const l1Request = makeRequest({ reason_category: 'wrong_direction', comment: 'Wrong goal' });

    const offResult = dispatchReviewReentryWithPolicy({
      missionDir: tmpDir,
      round: 1,
      state: { context: {} },
      pendingReviewReentries: [l1Request],
      rawGoalGaps: ['missing evidence'],
      fallbackAllGaps: ['missing evidence', 'human review reject'],
      goal: { summary: 'Goal', success_condition: 'Done' },
      legacyUpsertGoalGapTasks: legacySpy,
    });
    expect(offResult).toEqual({
      gapTaskIds: ['goal-gap-r1-1', 'goal-gap-r1-1-review'],
      nextStatus: 'active',
      contextPatch: {},
    });

    legacySpy.mockClear();
    const onResult = dispatchReviewReentryWithPolicy({
      missionDir: tmpDir,
      round: 1,
      state: { context: { requirements_change_level_routing: true } },
      pendingReviewReentries: [l1Request],
      rawGoalGaps: ['missing evidence'],
      fallbackAllGaps: ['missing evidence', 'human review reject'],
      goal: { summary: 'Goal', success_condition: 'Done' },
      legacyUpsertGoalGapTasks: legacySpy,
    });
    expect(onResult.nextStatus).toBe('paused');
    expect(onResult.contextPatch).toEqual({
      review_reentry_change_levels: ['L1_goal_purpose'],
      review_reentry_highest_level: 'L1_goal_purpose',
      alignment_reapproval_required: true,
    });
    expect(onResult.gapTaskIds).toEqual([
      'review-l1-r1-1',
      'review-l1-r1-1-review',
      'goal-gap-r1-1',
      'goal-gap-r1-1-review',
    ]);
    expect(legacySpy).toHaveBeenCalledWith(expect.objectContaining({ gaps: ['missing evidence'] }));
  });
});
