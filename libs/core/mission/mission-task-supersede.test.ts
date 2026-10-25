import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../customer-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../customer-resolver.js')>();
  const { customerRootWithSodOverlay } =
    await import('../governance/__tests__/sod-overlay-state.js');
  return { ...actual, customerRoot: customerRootWithSodOverlay(actual.customerRoot) };
});
import { useSeparationOfDutiesOverlay } from '../governance/__tests__/sod-overlay.js';
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  decideApprovalRequest,
} from '../governance/approval-store.js';
import * as pathResolver from '../path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import {
  claimWorkItem,
  clearWorkCoordinationNamespace,
  createWorkItem,
  getWorkItem,
  listActiveWorkLeases,
  setWorkCoordinationNamespace,
  updateWorkItem,
} from '../workforce/work-coordination.js';
import { readCanonicalWorkGraphTasks } from '../workforce/work-graph-projection.js';
import { evaluateMissionFinishExitGate, readMissionNextTasks } from './mission-lifecycle.js';
import { loadState } from './mission-state.js';
import {
  createMissionTaskSupersedeApprovalRequest,
  MISSION_TASK_SUPERSEDE_APPROVAL_CHANNEL,
  supersedeMissionTask,
} from './mission-task-supersede.js';

const missionId = 'MSN-TASK-SUPERSEDE-TEST';
const missionPath = pathResolver.missionDir(missionId, 'public');
const namespace = 'mission-task-supersede-test';
const actorId = 'supersede-test-actor';
const reason = 'The customer decision agenda was withdrawn; the work moves to a new task.';
const approvalIds: string[] = [];
let previousMissionRole: string | undefined;
let previousPersona: string | undefined;

type Task = Record<string, unknown> & { task_id: string };

function defaultTasks(): Task[] {
  return [
    { task_id: 'task-held', status: 'blocked', description: 'Held task', dependencies: [] },
    {
      task_id: 'task-replacement',
      status: 'planned',
      description: 'Replacement task',
      dependencies: [],
    },
    {
      task_id: 'task-after',
      status: 'planned',
      description: 'Depends on the held task',
      dependencies: ['task-held'],
    },
    { task_id: 'task-done', status: 'completed', description: 'Done', dependencies: [] },
  ];
}

function itemId(taskId: string): string {
  return `witem-supersede-${taskId}`;
}

function prepareMission(tasks: Task[] = defaultTasks(), options: { workItems?: boolean } = {}) {
  safeMkdir(missionPath, { recursive: true });
  safeWriteFile(
    nodePath.join(missionPath, 'mission-state.json'),
    JSON.stringify(
      {
        mission_id: missionId,
        tier: 'public',
        status: 'active',
        execution_mode: 'local',
        priority: 1,
        assigned_persona: actorId,
        confidence_score: 1,
        git: { branch: 'test', start_commit: 'start', latest_commit: 'start', checkpoints: [] },
        history: [],
        context: {},
      },
      null,
      2
    )
  );
  safeWriteFile(nodePath.join(missionPath, 'NEXT_TASKS.json'), JSON.stringify(tasks, null, 2));
  if (options.workItems === false) return;
  for (const task of tasks) {
    const status = String(task.status);
    createWorkItem({
      itemId: itemId(task.task_id),
      title: String(task.description || task.task_id),
      description: String(task.description || task.task_id),
      status:
        status === 'completed'
          ? 'done'
          : status === 'blocked'
            ? 'blocked'
            : status === 'superseded'
              ? 'archived'
              : 'ready',
      projectId: missionId,
      source: 'local',
      sourceRef: `mission:${missionId}:${task.task_id}`,
      dependencies: Array.isArray(task.dependencies) ? task.dependencies.map(String) : [],
      context: { mission_id: missionId, project_id: missionId, task_id: task.task_id },
      metadata: {
        task_id: task.task_id,
        mission_id: missionId,
        ...(status === 'superseded' ? { superseded_by: 'task-replacement' } : {}),
      },
    });
  }
}

function approve(input: { taskId?: string; byTaskId?: string; reason?: string } = {}): string {
  const request = createMissionTaskSupersedeApprovalRequest({
    missionId,
    taskId: input.taskId ?? 'task-held',
    byTaskId: input.byTaskId ?? 'task-replacement',
    reason: input.reason ?? reason,
    requestedBy: actorId,
  });
  approvalIds.push(request.id);
  const decided = decideApprovalRequest('mission_controller', {
    channel: request.channel,
    storageChannel: request.storageChannel,
    requestId: request.id,
    decision: 'approved',
    decidedBy: 'human-supersede-operator',
    decidedByRole: 'sovereign',
    authMethod: 'manual',
    decidedByType: 'human',
    authenticated: true,
    payloadHash: request.accountability?.payloadHash,
    effectBinding: request.accountability?.effectBinding,
  });
  return decided.id;
}

function boardTask(taskId: string): Task | undefined {
  return readMissionNextTasks(missionPath).find((task) => task.task_id === taskId) as
    Task | undefined;
}

beforeEach(() => {
  previousMissionRole = process.env.MISSION_ROLE;
  previousPersona = process.env.KYBERION_PERSONA;
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_PERSONA = actorId;
  setWorkCoordinationNamespace(namespace);
  safeRmSync(missionPath, { recursive: true, force: true });
});

afterEach(() => {
  process.env.MISSION_ROLE = 'mission_controller';
  for (const approvalId of approvalIds.splice(0)) {
    safeRmSync(approvalRequestLogicalPath(MISSION_TASK_SUPERSEDE_APPROVAL_CHANNEL, approvalId), {
      force: true,
    });
  }
  safeRmSync(approvalEventLogicalPath(MISSION_TASK_SUPERSEDE_APPROVAL_CHANNEL), { force: true });
  safeRmSync(missionPath, { recursive: true, force: true });
  safeRmSync(pathResolver.shared(`runtime/work-coordination/${namespace}`), {
    recursive: true,
    force: true,
  });
  safeRmSync(pathResolver.shared(`observability/work-coordination/${namespace}`), {
    recursive: true,
    force: true,
  });
  clearWorkCoordinationNamespace();
  if (previousMissionRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = previousMissionRole;
  if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
  else process.env.KYBERION_PERSONA = previousPersona;
});

useSeparationOfDutiesOverlay(
  pathResolver.sharedTmp(`sod-overlay-mission-task-supersede-${process.pid}.json`)
);

describe('mission_controller supersede-task', () => {
  it('requires the mission controller role', async () => {
    prepareMission();
    process.env.MISSION_ROLE = 'worker';
    await expect(
      supersedeMissionTask({
        missionId,
        taskId: 'task-held',
        byTaskId: 'task-replacement',
        reason,
        dryRun: true,
      })
    ).rejects.toThrow(/Mission controller authority/u);
  });

  it('never applies without an approval request id, and a dry run mutates nothing', async () => {
    prepareMission();
    await expect(
      supersedeMissionTask({ missionId, taskId: 'task-held', byTaskId: 'task-replacement', reason })
    ).rejects.toThrow(/requires --approval-request-id/u);

    const dry = await supersedeMissionTask({
      missionId,
      taskId: 'task-held',
      byTaskId: 'task-replacement',
      reason,
      dryRun: true,
    });
    expect(dry.status).toBe('dry_run_ready');
    expect(dry.rewritten_dependent_task_ids).toEqual(['task-after']);
    expect(boardTask('task-held')?.status).toBe('blocked');
    expect(boardTask('task-after')?.dependencies).toEqual(['task-held']);
  });

  it('applies with an authenticated human approval: closes the task, moves dependents, keeps the reason in the receipt only', async () => {
    prepareMission();
    const approvalRequestId = approve();
    const result = await supersedeMissionTask({
      missionId,
      taskId: 'task-held',
      byTaskId: 'task-replacement',
      reason,
      approvalRequestId,
    });
    expect(result.status).toBe('applied');
    expect(result.rewritten_dependent_task_ids).toEqual(['task-after']);
    expect(result.work_item_ids_updated.sort()).toEqual(
      [itemId('task-held'), itemId('task-after')].sort()
    );
    // No decision case for this mission: nothing to mark.
    expect(result.customer_decision_lock).toMatchObject({ case_found: false, marked: false });

    const held = boardTask('task-held');
    expect(held?.status).toBe('superseded');
    expect(held?.superseded).toMatchObject({
      by_task_id: 'task-replacement',
      actor_id: actorId,
      approval_request_id: approvalRequestId,
      reason_sha256: result.reason_sha256,
    });
    const after = boardTask('task-after');
    expect(after?.dependencies).toEqual(['task-replacement']);
    expect(after?.dependencies_rewritten_from).toEqual([
      expect.objectContaining({ from: 'task-held', to: 'task-replacement' }),
    ]);

    const oldItem = getWorkItem(itemId('task-held'));
    expect(oldItem?.status).toBe('archived');
    expect(oldItem?.metadata?.superseded_by).toBe('task-replacement');
    expect(getWorkItem(itemId('task-after'))?.dependencies).toEqual(['task-replacement']);
    // The canonical projection says superseded (not completed).
    const projected = readCanonicalWorkGraphTasks(missionId);
    expect(projected.find((task) => task.task_id === 'task-held')?.status).toBe('superseded');

    const receipt = JSON.parse(
      String(
        safeReadFile(nodePath.join(missionPath, 'evidence/task-supersede/task-held.json'), {
          encoding: 'utf8',
        })
      )
    ) as Record<string, unknown>;
    expect(receipt.reason).toBe(reason);
    const ledger = String(
      safeReadFile(nodePath.join(missionPath, 'execution-ledger.jsonl'), { encoding: 'utf8' })
    );
    expect(ledger).toContain('"event_type":"task_superseded"');
    expect(ledger).not.toContain(reason);
    const state = loadState(missionId);
    const history = state?.history.find((entry) => entry.event === 'TASK_SUPERSEDED');
    expect(history?.note).toContain('task-held superseded by task-replacement');
    expect(history?.note).not.toContain(reason);

    // The finish gate no longer waits for the superseded task; it still waits
    // for the replacement and the moved dependent.
    expect(evaluateMissionFinishExitGate(missionPath)).toMatchObject({
      ok: false,
      pendingTasks: ['task-replacement', 'task-after'],
    });

    // Re-running with the same approval only retries the lock mark.
    const rerun = await supersedeMissionTask({
      missionId,
      taskId: 'task-held',
      byTaskId: 'task-replacement',
      reason,
      approvalRequestId,
    });
    expect(rerun.status).toBe('already_superseded');
  });

  it('refuses an approval bound to another replacement or reason, and a pending one', async () => {
    prepareMission([
      ...defaultTasks(),
      { task_id: 'task-other', status: 'planned', description: 'Other', dependencies: [] },
    ]);
    const forOther = approve({ byTaskId: 'task-other' });
    await expect(
      supersedeMissionTask({
        missionId,
        taskId: 'task-held',
        byTaskId: 'task-replacement',
        reason,
        approvalRequestId: forOther,
      })
    ).rejects.toThrow(/different replacement or reason/u);
    const otherReason = approve({ reason: 'another reason' });
    await expect(
      supersedeMissionTask({
        missionId,
        taskId: 'task-held',
        byTaskId: 'task-replacement',
        reason,
        approvalRequestId: otherReason,
      })
    ).rejects.toThrow(/different replacement or reason/u);

    const pending = createMissionTaskSupersedeApprovalRequest({
      missionId,
      taskId: 'task-held',
      byTaskId: 'task-replacement',
      reason,
      requestedBy: actorId,
    });
    approvalIds.push(pending.id);
    await expect(
      supersedeMissionTask({
        missionId,
        taskId: 'task-held',
        byTaskId: 'task-replacement',
        reason,
        approvalRequestId: pending.id,
      })
    ).rejects.toThrow(/approved mission_gate request/u);
    expect(boardTask('task-held')?.status).toBe('blocked');
  });

  it('refuses impossible supersedes before a human is asked', () => {
    prepareMission([
      ...defaultTasks(),
      {
        task_id: 'task-chained',
        status: 'planned',
        description: 'Waits on task-after',
        dependencies: ['task-after'],
      },
      {
        task_id: 'task-superseded',
        status: 'superseded',
        description: 'Already replaced',
        dependencies: [],
      },
    ]);
    const request = (taskId: string, byTaskId: string) => () =>
      createMissionTaskSupersedeApprovalRequest({
        missionId,
        taskId,
        byTaskId,
        reason,
        requestedBy: actorId,
      });
    expect(request('task-held', 'task-held')).toThrow(/by itself/u);
    expect(request('task-missing', 'task-replacement')).toThrow(/not found/u);
    expect(request('task-held', 'task-missing')).toThrow(/add it to NEXT_TASKS first/u);
    expect(request('task-done', 'task-replacement')).toThrow(/already completed/u);
    expect(request('task-superseded', 'task-replacement')).toThrow(/already superseded/u);
    expect(request('task-held', 'task-superseded')).toThrow(/itself superseded/u);
    // task-chained → task-after → task-held: transitively dependent.
    expect(request('task-held', 'task-chained')).toThrow(/depends \(transitively\)/u);
  });

  it('refuses a task with a live WorkItem lease and a task reviewed by a live review task', () => {
    prepareMission([
      ...defaultTasks(),
      {
        task_id: 'review-held',
        status: 'planned',
        description: 'Review the held task',
        assigned_to: { role: 'reviewer' },
        review_target: 'task-held',
        deliverable: 'evidence/REVIEW-task-held.md',
        dependencies: ['task-held'],
      },
    ]);
    expect(() =>
      createMissionTaskSupersedeApprovalRequest({
        missionId,
        taskId: 'task-held',
        byTaskId: 'task-replacement',
        reason,
        requestedBy: actorId,
      })
    ).toThrow(/review-held reviews task-held/u);

    const replacementItem = getWorkItem(itemId('task-replacement'))!;
    claimWorkItem({
      itemId: replacementItem.item_id,
      actorPeerId: 'test-worker',
      purpose: 'test lease',
      expectedVersion: replacementItem.version,
    });
    expect(() =>
      createMissionTaskSupersedeApprovalRequest({
        missionId,
        taskId: 'task-replacement',
        byTaskId: 'task-done',
        reason,
        requestedBy: actorId,
      })
    ).toThrow(/in progress|live WorkItem lease/u);
  });

  it('supersedes a held task whose blocked attempt still holds its scheduling lease', async () => {
    prepareMission();
    // The worker blocks a held task after claiming it; the lease outlives the block.
    const heldItem = getWorkItem(itemId('task-held'))!;
    const claimed = claimWorkItem({
      itemId: heldItem.item_id,
      actorPeerId: 'mission-orchestration-worker',
      purpose: 'dispatch',
      expectedVersion: heldItem.version,
    });
    updateWorkItem({
      itemId: claimed.item.item_id,
      expectedVersion: claimed.item.version,
      status: 'blocked',
      metadata: { blocked_reason: 'customer_decision_unresolvable' },
    });
    const approvalRequestId = approve();
    const result = await supersedeMissionTask({
      missionId,
      taskId: 'task-held',
      byTaskId: 'task-replacement',
      reason,
      approvalRequestId,
    });
    expect(result.status).toBe('applied');
    expect(getWorkItem(itemId('task-held'))?.status).toBe('archived');
    expect(listActiveWorkLeases().some((lease) => lease.item_id === itemId('task-held'))).toBe(
      false
    );
  });

  it('refuses record-evidence on a superseded task', async () => {
    prepareMission();
    const approvalRequestId = approve();
    await supersedeMissionTask({
      missionId,
      taskId: 'task-held',
      byTaskId: 'task-replacement',
      reason,
      approvalRequestId,
    });
    const { recordEvidence } = await import('./mission-maintenance.js');
    await expect(
      recordEvidence({
        missionId,
        taskId: 'task-held',
        note: 'late evidence',
        getGitHash: () => 'hash',
        syncProjectLedgerIfLinked: async () => undefined,
      })
    ).rejects.toThrow(/superseded by task-replacement/u);
    expect(safeExistsSync(nodePath.join(missionPath, 'NEXT_TASKS.json'))).toBe(true);
  });
});
