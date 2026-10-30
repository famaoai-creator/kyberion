import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A worker's status write that lands while a board writer is between its own
// read and its write (inside a WorkItem call): the writer must keep it.
const hooks = vi.hoisted(() => ({ onWorkItemCall: undefined as undefined | (() => void) }));

vi.mock('../workforce/work-coordination.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workforce/work-coordination.js')>();
  const afterCall =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      const result = fn(...args);
      hooks.onWorkItemCall?.();
      return result;
    };
  return {
    ...actual,
    importExternalWorkItem: afterCall(actual.importExternalWorkItem),
    claimWorkItem: afterCall(actual.claimWorkItem),
  };
});

import {
  claimWorkItem,
  clearWorkCoordinationStore,
  setWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import {
  readMissionNextTasks,
  tryAutoCompleteTaskFromEvidence,
  writeMissionNextTasks,
} from './mission-lifecycle-completion.js';
import { recoverMissionRequestedTasks } from './mission-task-recovery.js';
import { dispatchMissionTickets } from './mission-ticket-dispatch.js';
import type { MissionState } from './mission-types.js';

const missionId = 'MSN-BOARD-WRITERS-LEASE-TEST';
const missionPath = pathResolver.missionDir(missionId, 'public');

function makeMissionState(): MissionState {
  return {
    mission_id: missionId,
    mission_type: 'operations',
    tier: 'public',
    status: 'active',
    execution_mode: 'local',
    priority: 1,
    assigned_persona: 'worker',
    confidence_score: 1,
    git: {
      branch: 'mission/board-writers-lease-test',
      start_commit: 'abc123',
      latest_commit: 'abc123',
      checkpoints: [],
    },
    history: [],
  };
}

const implementTask = {
  task_id: 'task-1',
  status: 'planned',
  assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
  description: 'Implement the change',
  deliverable: 'evidence/task-1.md',
  target_path: 'evidence/task-1.md',
};
const workerTask = {
  task_id: 'task-2',
  status: 'in_progress',
  assigned_to: { role: 'implementer', agent_id: 'worker-2' },
  description: 'Work a worker is finishing',
};

/** A worker closing task-2 through the board writer. */
function workerCompletesTask2(): void {
  writeMissionNextTasks(missionPath, (onDisk) =>
    onDisk.map((task) => (task.task_id === 'task-2' ? { ...task, status: 'completed' } : task))
  );
}

function statusOf(taskId: string): unknown {
  return readMissionNextTasks(missionPath).find((task) => task.task_id === taskId)?.status;
}

beforeEach(() => {
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_PERSONA = 'worker';
  setWorkCoordinationNamespace('mission-board-writers-lease-test');
  clearWorkCoordinationStore();
  if (!safeExistsSync(missionPath)) safeMkdir(missionPath, { recursive: true });
  safeWriteFile(`${missionPath}/mission-state.json`, JSON.stringify(makeMissionState(), null, 2));
  safeWriteFile(
    `${missionPath}/NEXT_TASKS.json`,
    JSON.stringify([implementTask, workerTask], null, 2)
  );
});

afterEach(() => {
  hooks.onWorkItemCall = undefined;
  clearWorkCoordinationStore();
  safeRmSync(missionPath, { recursive: true, force: true });
  setWorkCoordinationNamespace(null);
});

describe('board writers keep a worker write made since their read', () => {
  it('ticket dispatch stamps its dispatch onto the board read under the lease', async () => {
    hooks.onWorkItemCall = workerCompletesTask2;
    await dispatchMissionTickets(makeMissionState(), { targets: ['workitem'] });
    expect(statusOf('task-2')).toBe('completed');
    const task1 = readMissionNextTasks(missionPath).find((task) => task.task_id === 'task-1');
    expect(task1?.ticket_dispatch).toMatchObject({ work_item_id: expect.any(String) });
  });

  /** task-1 dispatched, claimed, its claim expired and its task requested again. */
  async function requestedTaskWithExpiredClaim(): Promise<{
    workItemId: string;
    expiredNow: string;
  }> {
    await dispatchMissionTickets(makeMissionState(), { targets: ['workitem'] });
    const tasks = readMissionNextTasks(missionPath);
    const dispatch = tasks[0].ticket_dispatch as Record<string, unknown>;
    const first = claimWorkItem({
      itemId: String(dispatch.work_item_id),
      actorPeerId: 'agent-1',
      purpose: 'initial execution',
      ttlMs: 60_000,
      expectedVersion: 1,
      idempotencyKey: 'initial-claim',
    });
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          { ...tasks[0], status: 'requested', ticket_dispatch: { ...dispatch, attempt_count: 1 } },
          tasks[1],
        ],
        null,
        2
      )
    );
    return {
      workItemId: String(dispatch.work_item_id),
      expiredNow: new Date(Date.parse(first.lease.expires_at) + 1_000).toISOString(),
    };
  }

  it('requested-task recovery stamps its resume onto the board read under the lease', async () => {
    const { workItemId, expiredNow } = await requestedTaskWithExpiredClaim();
    hooks.onWorkItemCall = workerCompletesTask2;
    expect(recoverMissionRequestedTasks(missionId, { now: expiredNow }).reissued_count).toBe(1);
    expect(statusOf('task-2')).toBe('completed');
    expect(readMissionNextTasks(missionPath)[0].ticket_dispatch).toMatchObject({
      work_item_id: workItemId,
      attempt_count: 2,
    });
  });

  it('requested-task recovery leaves a task completed while it was claimed as it is', async () => {
    const { expiredNow } = await requestedTaskWithExpiredClaim();
    hooks.onWorkItemCall = () =>
      writeMissionNextTasks(missionPath, (onDisk) =>
        onDisk.map((task) => (task.task_id === 'task-1' ? { ...task, status: 'completed' } : task))
      );
    recoverMissionRequestedTasks(missionId, { now: expiredNow });
    const task1 = readMissionNextTasks(missionPath)[0];
    expect(task1.status).toBe('completed');
    expect(task1.ticket_dispatch).toMatchObject({ attempt_count: 1 });
    expect(task1.ticket_dispatch).not.toHaveProperty('resumed_at');
  });

  /** Is the board's writer lease held right now? */
  function boardLeaseHeld(): boolean {
    const leasePath = `${missionPath}/coordination/writer-lease.json`;
    if (!safeExistsSync(leasePath)) return false;
    const lease = JSON.parse(String(safeReadFile(leasePath, { encoding: 'utf8' })));
    return Number(lease.expires_at_ms) > Date.now();
  }

  it('record-evidence auto-complete checks outside the lease and keeps a write made meanwhile', () => {
    safeMkdir(`${missionPath}/evidence`, { recursive: true });
    safeWriteFile(`${missionPath}/evidence/task-1.md`, '# task-1\n');
    const leaseHeldAtCheck: boolean[] = [];
    const result = tryAutoCompleteTaskFromEvidence(missionPath, 'task-1', {
      isHeld: () => {
        leaseHeldAtCheck.push(boardLeaseHeld());
        // A worker's write between the checks and the write (it takes the lease itself).
        if (leaseHeldAtCheck.length === 1) workerCompletesTask2();
        return false;
      },
    });
    expect(result.completed).toBe(true);
    expect(leaseHeldAtCheck).toEqual([false, false]);
    expect(statusOf('task-1')).toBe('completed');
    expect(statusOf('task-2')).toBe('completed');
  });

  it('record-evidence auto-complete checks under the lease once the board keeps changing', () => {
    safeMkdir(`${missionPath}/evidence`, { recursive: true });
    safeWriteFile(`${missionPath}/evidence/task-1.md`, '# task-1\n');
    const leaseHeldAtCheck: boolean[] = [];
    const result = tryAutoCompleteTaskFromEvidence(missionPath, 'task-1', {
      isHeld: () => {
        leaseHeldAtCheck.push(boardLeaseHeld());
        if (!boardLeaseHeld()) {
          // Every snapshot is outdated by the time it would be written.
          const tasks = readMissionNextTasks(missionPath);
          tasks[1] = { ...tasks[1], touched: leaseHeldAtCheck.length };
          safeWriteFile(`${missionPath}/NEXT_TASKS.json`, JSON.stringify(tasks, null, 2));
        }
        return false;
      },
    });
    expect(result.completed).toBe(true);
    expect(leaseHeldAtCheck).toEqual([false, false, false, true]);
    expect(statusOf('task-1')).toBe('completed');
    expect(readMissionNextTasks(missionPath)[1].touched).toBe(3);
  });
});
