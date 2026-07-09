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
import { finishMission, verifyMission } from './mission-lifecycle.js';

const missionId = 'MSN-LIFECYCLE-GATE-001';
const missionPath = pathResolver.missionDir(missionId, 'public');

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

  it('keeps a mission in validating when pending tasks remain, then realigns on repeated failure', async () => {
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
    expect(state.status).toBe('validating');
    expect(state.context.mission_finish_gate_failure_count).toBe(1);
    const nextTasksAfterFirstFailure = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(
      nextTasksAfterFirstFailure.some((task: any) => task.task_id === 'repair-finish-exit')
    ).toBe(true);

    await finishMission(missionId, false, args);
    state = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    expect(state.status).toBe('active');
    expect(state.context.mission_finish_gate_failure_count).toBe(2);
    expect(state.context.mission_finish_gate_last_reason).toContain('Pending tasks remain');
    expect(safeExistsSync(`${missionPath}/gates`)).toBe(true);
    const gateFiles = safeReaddir(`${missionPath}/gates`);
    expect(gateFiles.some((name: string) => name.startsWith('finish-exit-'))).toBe(true);
    const nextTasksAfterSecondFailure = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(
      nextTasksAfterSecondFailure.filter((task: any) => task.task_id === 'repair-finish-exit')
    ).toHaveLength(1);
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
    expect(state.status).toBe('validating');
    expect(state.context.mission_finish_gate_last_reason).toContain(
      'goal not satisfied after 2 gap-closing rounds'
    );
    const repairTasks = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(repairTasks.some((task: any) => task.task_id === 'repair-goal-satisfaction')).toBe(true);
  });

  it('creates a repair task when finish quality validation fails', async () => {
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
    expect(updatedState.status).toBe('validating');
    expect(updatedState.context.mission_finish_gate_last_reason).toContain('latest_commit');
    const nextTasks = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(nextTasks.some((task: any) => task.task_id === 'repair-finish-quality')).toBe(true);
    expect(safeExistsSync(`${missionPath}/gates`)).toBe(true);
    const gateFiles = safeReaddir(`${missionPath}/gates`);
    expect(gateFiles.some((name: string) => name.startsWith('finish-quality-'))).toBe(true);
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
