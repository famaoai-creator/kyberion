import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// finishMission fires real operator notifications (deliverable_ready /
// mission_completed); without this mock every battery run appends phantom
// entries to the REAL inbox (dev-practices §3).
vi.mock('@agent/core', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agent/core');
  return { ...actual, notifyOperator: vi.fn().mockResolvedValue(true) };
});

import {
  customerResolver,
  emitIntentSnapshot,
  hashArtifactForReview,
  pathResolver,
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  transitionStatus,
} from '@agent/core';
import {
  evaluateMissionFinishExitGate,
  finishMission,
  reconcileLifecycleClosureCriteria,
  verifyMission,
} from './mission-lifecycle.js';

const missionId = 'MSN-LIFECYCLE-GATE-001';
const missionPath = pathResolver.missionDir(missionId, 'public');

interface MissionTaskSnapshot {
  task_id?: string;
  status?: string;
  artifact_review_receipt?: string;
  last_review_invalidation?: { reason?: string };
}

function prepareMissionState(
  status: 'completed' | 'distilling' | 'active' = 'completed',
  missionType?: string,
  tenantSlug?: string,
  outcomeContract?: {
    requested_result: string;
    success_criteria: string[];
    deliverable_kind: string;
    evidence_required: boolean;
    expected_artifacts: Array<{ kind: string; storage_class: string }>;
    verification_method: 'self_check' | 'review_gate' | 'human_acceptance' | 'test';
  }
): void {
  const latestCommit = safeExec('git', ['rev-parse', 'HEAD'], {
    cwd: pathResolver.rootDir(),
  }).trim();
  if (!safeExistsSync(missionPath)) safeMkdir(missionPath, { recursive: true });
  safeWriteFile(
    `${missionPath}/mission-state.json`,
    JSON.stringify(
      {
        mission_id: missionId,
        tier: 'public',
        ...(missionType ? { mission_type: missionType } : {}),
        ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
        status,
        execution_mode: 'local',
        priority: 1,
        assigned_persona: 'tester',
        confidence_score: 1,
        git: {
          branch: 'test',
          start_commit: 'abc123',
          latest_commit: latestCommit,
          checkpoints: [],
        },
        history: [],
        context: {},
        ...(outcomeContract
          ? {
              outcome_contract: {
                outcome_id: `outcome-${missionId}`,
                ...outcomeContract,
              },
            }
          : {}),
      },
      null,
      2
    )
  );
}

function seedMissionEvidence(fileName: string, contents: string): void {
  const evidenceDir = `${missionPath}/evidence`;
  if (!safeExistsSync(evidenceDir)) safeMkdir(evidenceDir, { recursive: true });
  safeWriteFile(`${evidenceDir}/${fileName}`, contents);
}

beforeEach(() => {
  if (!safeExistsSync(missionPath)) safeMkdir(missionPath, { recursive: true });
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_PERSONA = 'worker';
});

afterEach(() => {
  safeRmSync(pathResolver.rootResolve(`active/shared/tmp/mission-archives/${missionId}`));
  safeRmSync(pathResolver.rootResolve('customer/demo'), { recursive: true, force: true });
  safeRmSync(missionPath, { recursive: true, force: true });
});

describe('mission lifecycle finish gate', () => {
  it('resolves circular lifecycle closure criteria from verify and distill history', () => {
    const reconciliation = reconcileLifecycleClosureCriteria(
      {
        satisfied: false,
        delivered: [],
        gaps: [
          'Mission lifecycle reaches completed with verification and distillation.',
          'A customer-visible report is delivered.',
        ],
        confidence: 0.28,
        evidence_refs: ['evidence/report.md'],
      },
      {
        status: 'completed',
        history: [{ event: 'VERIFY' }, { event: 'DISTILL' }],
      }
    );

    expect(reconciliation.satisfied).toBe(false);
    expect(reconciliation.gaps).toEqual(['A customer-visible report is delivered.']);
    expect(reconciliation.delivered).toContain(
      'mission lifecycle verification and distillation recorded'
    );

    const lifecycleOnly = reconcileLifecycleClosureCriteria(
      {
        satisfied: false,
        delivered: [],
        gaps: ['Mission lifecycle reaches completed with verification and distillation.'],
        confidence: 0.28,
      },
      {
        status: 'completed',
        history: [{ event: 'VERIFY' }, { event: 'DISTILL' }],
      }
    );
    expect(lifecycleOnly.satisfied).toBe(true);
    expect(lifecycleOnly.gaps).toEqual([]);
  });

  it('blocks verification when the intent drift gate sees a blocking origin mismatch', async () => {
    prepareMissionState('active');
    safeMkdir(`${missionPath}/evidence`, { recursive: true });
    emitIntentSnapshot({
      missionId,
      stage: 'intake',
      source: 'user_prompt',
      intent: { goal: 'Build a customer onboarding flow' },
      kind: 'origin',
    });
    emitIntentSnapshot({
      missionId,
      stage: 'execution',
      source: 'mission_state',
      intent: { goal: 'Rewrite the release checklist instead' },
    });

    const args = {
      transitionStatus,
      syncProjectLedgerIfLinked: async () => undefined,
    };

    await verifyMission(
      missionId,
      'verified',
      'Scope drift detected during verification.',
      args.transitionStatus,
      args.syncProjectLedgerIfLinked
    );

    const state = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    expect(state.status).toBe('validating');
    expect(state.context.intent_drift_gate_failure_count).toBe(1);
    expect(state.context.intent_drift_gate_last_reason).toContain('intent drift');
    expect(safeExistsSync(`${missionPath}/NEXT_TASKS.json`)).toBe(true);
    const nextTasks = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(nextTasks.some((task: any) => task.task_id === 'repair-intent-drift')).toBe(true);
  });

  it('resumes existing pending work without creating a synthetic finish repair loop', async () => {
    prepareMissionState('completed');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-1',
            status: 'planned',
            assigned_to: { role: 'operator', agent_id: 'implementation-architect' },
            description: 'Close out the mission',
            deliverable: 'evidence/closeout.md',
            target_path: 'evidence/closeout.md',
          },
        ],
        null,
        2
      )
    );

    const args = {
      archiveDir: pathResolver.rootResolve('active/shared/tmp/mission-archives'),
      agentRuntimeEventPath: `${missionPath}/runtime-events.jsonl`,
      getGitHash: (cwd: string) => safeExec('git', ['rev-parse', 'HEAD'], { cwd }).trim(),
      sealMission: async () => undefined,
      syncProjectLedgerIfLinked: async () => undefined,
      transitionStatus,
    };

    await finishMission(missionId, false, args);
    let state = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    expect(state.status).toBe('active');
    expect(state.context.mission_finish_gate_failure_count).toBe(1);
    const nextTasksAfterFirstFailure = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    ) as MissionTaskSnapshot[];
    expect(nextTasksAfterFirstFailure.map((task) => task.task_id)).toEqual(['task-1']);

    await finishMission(missionId, false, args);
    state = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    expect(state.status).toBe('active');
    expect(state.context.mission_finish_gate_failure_count).toBe(1);
    expect(state.context.mission_finish_gate_last_reason).toContain('Pending tasks remain');
    expect(safeExistsSync(`${missionPath}/gates`)).toBe(true);
    const gateFiles = safeReaddir(`${missionPath}/gates`);
    expect(gateFiles.some((name: string) => name.startsWith('finish-exit-'))).toBe(true);
    const nextTasksAfterSecondAttempt = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    ) as MissionTaskSnapshot[];
    expect(nextTasksAfterSecondAttempt.map((task) => task.task_id)).toEqual(['task-1']);
  });

  it('closes system repair and goal-gap tasks after dependencies and evidence are complete', () => {
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-1',
            status: 'completed',
            deliverable: 'evidence/closeout.md',
          },
          {
            task_id: 'repair-finish-exit',
            status: 'planned',
            dependencies: ['task-1'],
            deliverable: 'evidence/repair-finish-exit.md',
          },
          {
            task_id: 'goal-gap-r1-1',
            status: 'planned',
            dependencies: [],
            deliverable: 'evidence/goal-gap-r1-1.md',
          },
          {
            task_id: 'goal-gap-r1-1-review',
            status: 'planned',
            dependencies: ['goal-gap-r1-1'],
            deliverable: 'evidence/REVIEW-goal-gap-r1-1.md',
          },
        ],
        null,
        2
      )
    );
    seedMissionEvidence('repair-finish-exit.md', '# Repair\nAll pending tasks were verified.');
    seedMissionEvidence('goal-gap-r1-1.md', '# Goal gap\nVerification and distillation passed.');
    seedMissionEvidence('REVIEW-goal-gap-r1-1.md', '# Review\nVerified.');

    const gate = evaluateMissionFinishExitGate(missionPath);
    const tasks = JSON.parse(
      String(safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }))
    ) as Array<{ task_id?: string; status?: string }>;

    expect(gate).toEqual({ ok: true, pendingTasks: [] });
    expect(tasks.find((task) => task.task_id === 'repair-finish-exit')?.status).toBe('completed');
    expect(tasks.find((task) => task.task_id === 'goal-gap-r1-1-review')?.status).toBe('completed');
  });

  it('retires stale circular goal repairs for in-flight missions after the lifecycle evidence exists', () => {
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'repair-goal-satisfaction',
            status: 'planned',
            description:
              'Repair mission goal-satisfaction gate failure: Mission lifecycle reaches completed with verification and distillation.',
            deliverable: 'evidence/repair-goal-satisfaction.md',
            dependencies: [],
          },
          {
            task_id: 'repair-finish-exit',
            status: 'planned',
            description: 'Repair the exit gate after goal satisfaction.',
            deliverable: 'evidence/repair-finish-exit.md',
            dependencies: ['repair-goal-satisfaction'],
          },
        ],
        null,
        2
      )
    );
    seedMissionEvidence(
      'repair-finish-exit.md',
      '# Exit repair\nPrior lifecycle evidence verified.'
    );

    const gate = evaluateMissionFinishExitGate(missionPath, {
      status: 'validating',
      history: [{ event: 'VERIFY' }, { event: 'DISTILL' }],
    });
    const tasks = JSON.parse(
      String(safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }))
    ) as Array<{ task_id?: string; status?: string }>;

    expect(gate).toEqual({ ok: true, pendingTasks: [] });
    expect(tasks.every((task) => task.status === 'completed')).toBe(true);
  });

  it('records a completion reconciliation summary when finish succeeds', async () => {
    prepareMissionState('completed', undefined, undefined, {
      requested_result: 'Mission closeout complete.',
      success_criteria: ['The closeout note is saved'],
      deliverable_kind: 'markdown',
      evidence_required: true,
      expected_artifacts: [{ kind: 'markdown', storage_class: 'mission' }],
      verification_method: 'self_check',
    });
    seedMissionEvidence('closeout.md', '# Closeout\nMission closeout complete.');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-1',
            status: 'completed',
            assigned_to: { role: 'operator', agent_id: 'implementation-architect' },
            description: 'Close out the mission',
            deliverable: 'evidence/closeout.md',
            target_path: 'evidence/closeout.md',
          },
        ],
        null,
        2
      )
    );

    const args = {
      archiveDir: pathResolver.rootResolve('active/shared/tmp/mission-archives'),
      agentRuntimeEventPath: `${missionPath}/runtime-events.jsonl`,
      getGitHash: (cwd: string) => safeExec('git', ['rev-parse', 'HEAD'], { cwd }).trim(),
      sealMission: async () => undefined,
      syncProjectLedgerIfLinked: async () => undefined,
      transitionStatus,
    };

    await finishMission(missionId, false, args);

    const state = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    expect(state.status).toBe('archived');
    expect(state.context.mission_completion_summary).toMatchObject({
      requested_result: 'The closeout note is saved',
      satisfied: true,
      next_step: expect.stringContaining('Proceed with archival'),
    });
    expect(state.context.mission_completion_next_action).toMatchObject({
      title: 'Completion confirmed',
      satisfied: true,
      evidence_refs: expect.arrayContaining([`${missionPath}/evidence/closeout.md`]),
    });
  });

  it('finishes a repaired validating mission through the legal distilling transition', async () => {
    prepareMissionState('completed', undefined, undefined, {
      requested_result: 'Deliver mission outcome aligned to the vision.',
      success_criteria: ['Mission lifecycle reaches completed with verification and distillation.'],
      deliverable_kind: 'markdown',
      evidence_required: true,
      expected_artifacts: [{ kind: 'markdown', storage_class: 'mission' }],
      verification_method: 'self_check',
    });
    const state = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    state.status = 'validating';
    state.history = [
      { ts: new Date().toISOString(), event: 'VERIFY', note: 'Verified.' },
      { ts: new Date().toISOString(), event: 'DISTILL', note: 'Distilled.' },
    ];
    safeWriteFile(`${missionPath}/mission-state.json`, JSON.stringify(state, null, 2));
    seedMissionEvidence(
      'closeout.md',
      '# Closeout\nDeliver mission outcome aligned to the vision.'
    );
    safeWriteFile(`${missionPath}/NEXT_TASKS.json`, JSON.stringify([], null, 2));

    await finishMission(missionId, false, {
      archiveDir: pathResolver.rootResolve('active/shared/tmp/mission-archives'),
      agentRuntimeEventPath: `${missionPath}/runtime-events.jsonl`,
      getGitHash: (cwd: string) => safeExec('git', ['rev-parse', 'HEAD'], { cwd }).trim(),
      sealMission: async () => undefined,
      syncProjectLedgerIfLinked: async () => undefined,
      transitionStatus,
    });

    const archivedState = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    expect(archivedState.status).toBe('archived');
    expect(
      archivedState.history.some((entry: { event?: string }) => entry.event === 'FINISH')
    ).toBe(true);
  });

  it('goal satisfaction loop: dispatches gap tasks instead of completing, and escalates after max rounds', async () => {
    prepareMissionState('completed', undefined, undefined, {
      requested_result: 'Deliver the launch summary report',
      success_criteria: ['launch summary report saved as evidence'],
      deliverable_kind: 'markdown',
      evidence_required: true,
      expected_artifacts: [{ kind: 'markdown', storage_class: 'mission' }],
      verification_method: 'self_check',
    });
    // evidence exists but does NOT satisfy the success criteria (字面は完了、目的は未達)
    seedMissionEvidence('notes.md', '# Unrelated working notes');
    safeWriteFile(`${missionPath}/NEXT_TASKS.json`, JSON.stringify([], null, 2));

    const args = {
      archiveDir: pathResolver.rootResolve('active/shared/tmp/mission-archives'),
      agentRuntimeEventPath: `${missionPath}/runtime-events.jsonl`,
      getGitHash: (cwd: string) => safeExec('git', ['rev-parse', 'HEAD'], { cwd }).trim(),
      sealMission: async () => undefined,
      syncProjectLedgerIfLinked: async () => undefined,
      transitionStatus,
    };

    await finishMission(missionId, false, args);

    let state = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    // NOT completed: handed back to the team with concrete gap tasks
    expect(state.status).toBe('active');
    expect(state.context.goal_reconciliation_round).toBe(1);
    expect(state.history.some((entry: any) => entry.event === 'GOAL_GAP_REALIGN')).toBe(true);
    const nextTasks = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    const gapTask = nextTasks.find((task: any) => task.task_id === 'goal-gap-r1-1');
    expect(gapTask).toBeTruthy();
    expect(gapTask.assigned_to.role).toBe('implementer');
    expect(gapTask.acceptance_criteria.join(' ')).toContain('Deliver the launch summary report');
    const reviewTask = nextTasks.find((task: any) => task.task_id === 'goal-gap-r1-1-review');
    expect(reviewTask).toBeTruthy();
    expect(reviewTask.review_target).toBe('goal-gap-r1-1');
    const gateFiles = safeReaddir(`${missionPath}/gates`);
    expect(gateFiles.some((entry: string) => entry.includes('goal-satisfaction'))).toBe(true);

    // Exhausted rounds: the loop stops looping and escalates to the operator.
    state.context.goal_reconciliation_round = 2;
    state.status = 'completed';
    safeWriteFile(`${missionPath}/mission-state.json`, JSON.stringify(state, null, 2));
    safeWriteFile(`${missionPath}/NEXT_TASKS.json`, JSON.stringify([], null, 2));

    await finishMission(missionId, false, args);
    state = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    expect(state.status).toBe('paused');
    expect(state.context.mission_finish_gate_last_reason).toContain(
      'goal not satisfied after 2 gap-closing rounds'
    );
    expect(state.context.mission_finish_gate_requires_operator).toBe(true);
    const repairTasks = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(repairTasks.some((task: any) => task.task_id === 'repair-goal-satisfaction')).toBe(
      false
    );

    const failureCount = state.context.mission_finish_gate_failure_count;
    await finishMission(missionId, false, args);
    state = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    expect(state.status).toBe('paused');
    expect(state.context.mission_finish_gate_failure_count).toBe(failureCount);
  });

  it('pauses for operator action when lifecycle bookkeeping fails quality validation', async () => {
    prepareMissionState('completed', undefined, undefined, {
      requested_result: 'Mission closeout complete.',
      success_criteria: ['The closeout note is saved'],
      deliverable_kind: 'markdown',
      evidence_required: true,
      expected_artifacts: [{ kind: 'markdown', storage_class: 'mission' }],
      verification_method: 'self_check',
    });
    seedMissionEvidence('closeout.md', '# Closeout\nMission closeout complete.');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-1',
            status: 'completed',
            assigned_to: { role: 'operator', agent_id: 'implementation-architect' },
            description: 'Close out the mission',
            deliverable: 'evidence/closeout.md',
            target_path: 'evidence/closeout.md',
          },
        ],
        null,
        2
      )
    );
    const state = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    state.git.latest_commit = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    safeWriteFile(`${missionPath}/mission-state.json`, JSON.stringify(state, null, 2));

    const args = {
      archiveDir: pathResolver.rootResolve('active/shared/tmp/mission-archives'),
      agentRuntimeEventPath: `${missionPath}/runtime-events.jsonl`,
      getGitHash: (cwd: string) => safeExec('git', ['rev-parse', 'HEAD'], { cwd }).trim(),
      sealMission: async () => undefined,
      syncProjectLedgerIfLinked: async () => undefined,
      transitionStatus,
    };

    await finishMission(missionId, false, args);

    const updatedState = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    expect(updatedState.status).toBe('paused');
    expect(updatedState.context.mission_finish_gate_last_reason).toContain('latest_commit');
    expect(updatedState.context.mission_finish_gate_requires_operator).toBe(true);
    const nextTasks = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    ) as MissionTaskSnapshot[];
    expect(nextTasks.some((task) => task.task_id === 'repair-finish-quality')).toBe(false);
    expect(safeExistsSync(`${missionPath}/gates`)).toBe(true);
    const gateFiles = safeReaddir(`${missionPath}/gates`);
    expect(gateFiles.some((name: string) => name.startsWith('finish-quality-'))).toBe(true);
  });

  it('reopens only the invalidated artifact review task when its artifact hash changes', async () => {
    prepareMissionState('completed');
    const artifactPath = `${missionPath}/deliverables/reviewed.md`;
    const receiptPath = `${missionPath}/evidence/reviews/review-content-r1.json`;
    safeMkdir(path.dirname(artifactPath), { recursive: true });
    safeMkdir(path.dirname(receiptPath), { recursive: true });
    safeWriteFile(artifactPath, '# Reviewed content');
    const artifactReference = pathResolver.toRepoRelative(artifactPath);
    const reviewedHash = hashArtifactForReview(artifactPath);
    safeWriteFile(
      receiptPath,
      JSON.stringify(
        {
          kind: 'artifact-review-receipt',
          version: '1.0.0',
          review_id: 'review-content-r1',
          mission_id: missionId,
          review_task_id: 'review-content',
          review_target_task_id: 'implementation',
          artifact: { path: artifactReference, sha256: reviewedHash, kind: 'doc' },
          reviewer: {
            agent_id: 'independent-reviewer',
            team_role: 'reviewer',
            specialist_roles: ['content-reviewer'],
            independent_from: ['implementation-agent'],
            independence_verified: true,
          },
          verdict: 'approved',
          findings: [],
          acceptance_criteria: ['The artifact content is acceptable.'],
          reviewed_at: '2026-07-13T00:00:00.000Z',
        },
        null,
        2
      )
    );
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'implementation',
            status: 'completed',
            assigned_to: { role: 'implementer', agent_id: 'implementation-agent' },
            deliverable: 'deliverables/reviewed.md',
          },
          {
            task_id: 'review-content',
            status: 'completed',
            assigned_to: { role: 'reviewer', agent_id: 'independent-reviewer' },
            review_target: 'implementation',
            artifact_review_receipt: 'evidence/reviews/review-content-r1.json',
            artifact_review_profile: {
              artifact_path: artifactReference,
              artifact_sha256: reviewedHash,
              required_reviewer_roles: ['content-reviewer'],
              independence_required: true,
              implementer_agent_ids: ['implementation-agent'],
            },
          },
        ],
        null,
        2
      )
    );
    safeWriteFile(artifactPath, '# Content changed after review');
    const args = {
      archiveDir: pathResolver.rootResolve('active/shared/tmp/mission-archives'),
      agentRuntimeEventPath: `${missionPath}/runtime-events.jsonl`,
      getGitHash: (cwd: string) => safeExec('git', ['rev-parse', 'HEAD'], { cwd }).trim(),
      sealMission: async () => undefined,
      syncProjectLedgerIfLinked: async () => undefined,
      transitionStatus,
    };

    await finishMission(missionId, false, args);

    const updatedState = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    const tasks = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    ) as MissionTaskSnapshot[];
    expect(updatedState.status).toBe('active');
    expect(tasks.find((task) => task.task_id === 'implementation')?.status).toBe('completed');
    const reviewTask = tasks.find((task) => task.task_id === 'review-content');
    expect(reviewTask).toBeDefined();
    expect(reviewTask?.status).toBe('planned');
    expect(reviewTask?.artifact_review_receipt).toBeUndefined();
    expect(reviewTask?.last_review_invalidation?.reason).toContain(
      'invalidated by artifact change'
    );
    expect(tasks.some((task) => task.task_id === 'repair-finish-quality')).toBe(false);
  });

  it('publishes meeting_facilitation deliverables into the active customer root on finish', async () => {
    const previousCustomer = process.env.KYBERION_CUSTOMER;
    process.env.KYBERION_CUSTOMER = 'demo';
    try {
      const customerRoot = customerResolver.customerRoot('', process.env);
      if (!customerRoot) throw new Error('Expected demo customer root to resolve.');
      safeMkdir(customerRoot, { recursive: true });
      safeMkdir(path.join(customerRoot, 'deliverables'), { recursive: true });

      prepareMissionState('completed', 'meeting_facilitation', 'demo', {
        requested_result: 'Meeting follow-up delivered to customer demo.',
        success_criteria: ['Minutes and action items are delivered'],
        deliverable_kind: 'delivery-pack',
        evidence_required: true,
        expected_artifacts: [{ kind: 'delivery-pack', storage_class: 'customer' }],
        verification_method: 'self_check',
      });
      seedMissionEvidence('minutes.md', '# Minutes\n\n## Summary\nFollow-up summary.\n');
      seedMissionEvidence(
        'action-items.jsonl',
        [
          JSON.stringify({
            item_id: 'AI-MTG-001',
            title: 'Confirm the proposal outline',
          }),
          JSON.stringify({
            item_id: 'AI-MTG-002',
            title: 'Send the revised list',
          }),
        ].join('\n')
      );
      seedMissionEvidence(
        'meeting-followup-pack.json',
        JSON.stringify({ kind: 'meeting-followup-delivery-pack', mission_id: missionId }, null, 2)
      );
      // The goal-satisfaction gate requires the evidence to actually state
      // that the success criteria hold — as a real delivery log would.
      seedMissionEvidence(
        'delivery-log.md',
        '# Delivery\n\nMinutes and action items are delivered to customer demo.\n'
      );
      safeWriteFile(
        `${missionPath}/NEXT_TASKS.json`,
        JSON.stringify(
          [
            {
              task_id: 'task-1',
              status: 'completed',
              assigned_to: { role: 'operator', agent_id: 'implementation-architect' },
              description: 'Close out the mission',
              deliverable: 'evidence/minutes.md',
              target_path: 'evidence/minutes.md',
            },
          ],
          null,
          2
        )
      );

      const args = {
        archiveDir: pathResolver.rootResolve('active/shared/tmp/mission-archives'),
        agentRuntimeEventPath: `${missionPath}/runtime-events.jsonl`,
        getGitHash: (cwd: string) => safeExec('git', ['rev-parse', 'HEAD'], { cwd }).trim(),
        sealMission: async () => undefined,
        syncProjectLedgerIfLinked: async () => undefined,
        transitionStatus,
      };

      await finishMission(missionId, false, args);

      const missionDeliverablesDir = path.join(customerRoot, 'deliverables', missionId);
      expect(safeExistsSync(missionDeliverablesDir)).toBe(true);
      expect(safeExistsSync(path.join(missionDeliverablesDir, 'minutes.md'))).toBe(true);
      expect(safeExistsSync(path.join(missionDeliverablesDir, 'action-items.jsonl'))).toBe(true);
      expect(safeExistsSync(path.join(missionDeliverablesDir, 'delivery-summary.md'))).toBe(true);
      expect(safeExistsSync(path.join(missionDeliverablesDir, 'delivery-pack.json'))).toBe(true);

      const deliveryPack = JSON.parse(
        safeReadFile(path.join(missionDeliverablesDir, 'delivery-pack.json'), {
          encoding: 'utf8',
        }) as string
      );
      expect(deliveryPack).toMatchObject({
        kind: 'delivery-pack',
        pack_id: `${missionId}-meeting-delivery`,
      });
      expect(String(deliveryPack.summary)).toContain('customer demo');

      const deliveryLog = safeReadFile(
        path.join(customerRoot, 'deliverables', 'delivery-log.jsonl'),
        {
          encoding: 'utf8',
        }
      ) as string;
      expect(deliveryLog).toContain(missionId);
      expect(deliveryLog).toContain('customer/demo/deliverables');
    } finally {
      if (previousCustomer === undefined) delete process.env.KYBERION_CUSTOMER;
      else process.env.KYBERION_CUSTOMER = previousCustomer;
    }
  });
});
