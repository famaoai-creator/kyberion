import { writeMissionNextTasks } from './mission-lifecycle-completion.js';
import * as nodePath from 'node:path';
import { withExecutionContext } from '../authority.js';
import { nowIso } from '../foundation/time.js';
import { loadMissionNextTaskObjectsAtPath } from './mission-next-task-reader.js';
import { resolveMissionDir, tryResolveOwnerScope } from '../owner-scope.js';
import { assertSafeRepositoryPath, safeExistsSync } from '../secure-io.js';
import {
  claimWorkItem,
  expireWorkItemLeases,
  getWorkItem,
  listActiveWorkLeases,
  listWorkItemAttempts,
} from '../workforce/work-coordination.js';

export interface MissionRequestedTaskRecoveryRecord {
  task_id: string;
  work_item_id?: string;
  status:
    'waiting' | 'reissued' | 'missing_dispatch' | 'missing_work_item' | 'terminal' | 'skipped';
  lease_id?: string;
  lease_expires_at?: string;
  attempt_count?: number;
  note?: string;
}

export interface MissionRequestedTaskRecoverySummary {
  mission_id: string;
  requested_count: number;
  waiting_count: number;
  reissued_count: number;
  skipped_count: number;
  recovered_task_ids: string[];
  records: MissionRequestedTaskRecoveryRecord[];
}

/** NEXT_TASKS.json of the existing mission; an unknown mission fails closed (write path). */
function nextTasksPath(missionId: string): string {
  const missionPath = resolveMissionDir(missionId);
  return assertSafeRepositoryPath(nodePath.join(missionPath, 'NEXT_TASKS.json'), {
    allowMissingLeaf: true,
  });
}

function readNextTasks(missionId: string): Array<Record<string, unknown>> {
  // Read path: an unknown mission has no tasks to recover.
  if (!tryResolveOwnerScope({ kind: 'mission', id: missionId })) return [];
  const filePath = nextTasksPath(missionId);
  if (!safeExistsSync(filePath)) return [];
  try {
    return (
      loadMissionNextTaskObjectsAtPath(filePath, nodePath.basename(nodePath.dirname(filePath))) ||
      []
    );
  } catch {
    return [];
  }
}

function isTerminalWorkItemStatus(status: unknown): boolean {
  return status === 'done' || status === 'archived' || status === 'blocked';
}

export function recoverMissionRequestedTasks(
  missionId: string,
  options: { now?: string; leaseTtlMs?: number } = {}
): MissionRequestedTaskRecoverySummary {
  const upperMissionId = String(missionId || '')
    .trim()
    .toUpperCase();
  if (!upperMissionId) {
    return {
      mission_id: upperMissionId,
      requested_count: 0,
      waiting_count: 0,
      reissued_count: 0,
      skipped_count: 0,
      recovered_task_ids: [],
      records: [],
    };
  }

  return withExecutionContext('mission_controller', () => {
    const tasks = readNextTasks(upperMissionId);
    const now = options.now || nowIso();
    expireWorkItemLeases(now);
    const activeLeases = new Map(listActiveWorkLeases().map((lease) => [lease.item_id, lease]));

    const summary: MissionRequestedTaskRecoverySummary = {
      mission_id: upperMissionId,
      requested_count: 0,
      waiting_count: 0,
      reissued_count: 0,
      skipped_count: 0,
      recovered_task_ids: [],
      records: [],
    };

    // Stamped onto the board at write time, under its writer lease.
    const resumeStamps = new Map<string, Record<string, unknown>>();

    for (const task of tasks) {
      const taskStatus = String(task.status || 'planned');
      if (taskStatus !== 'requested') continue;
      summary.requested_count += 1;

      const taskId = String(task.task_id || '').trim();
      const dispatch =
        task.ticket_dispatch && typeof task.ticket_dispatch === 'object'
          ? (task.ticket_dispatch as Record<string, unknown>)
          : undefined;
      const workItemId =
        typeof dispatch?.work_item_id === 'string' ? dispatch.work_item_id.trim() : '';

      if (!workItemId) {
        summary.skipped_count += 1;
        summary.records.push({
          task_id: taskId || 'unknown',
          status: 'missing_dispatch',
          note: 'ticket_dispatch.work_item_id is missing',
        });
        continue;
      }

      const workItem = getWorkItem(workItemId);
      if (!workItem) {
        summary.skipped_count += 1;
        summary.records.push({
          task_id: taskId || 'unknown',
          work_item_id: workItemId,
          status: 'missing_work_item',
          note: 'work item not found',
        });
        continue;
      }

      if (isTerminalWorkItemStatus(workItem.status)) {
        summary.skipped_count += 1;
        summary.records.push({
          task_id: taskId || 'unknown',
          work_item_id: workItemId,
          status: 'terminal',
          note: `work item is already ${workItem.status}`,
        });
        continue;
      }

      const activeLease = activeLeases.get(workItemId);
      if (activeLease) {
        summary.waiting_count += 1;
        summary.records.push({
          task_id: taskId || 'unknown',
          work_item_id: workItemId,
          status: 'waiting',
          lease_id: activeLease.lease_id,
          lease_expires_at: activeLease.expires_at,
          attempt_count: listWorkItemAttempts(workItemId).length,
        });
        continue;
      }

      const attemptCount = listWorkItemAttempts(workItemId).length + 1;
      const claimed = claimWorkItem({
        itemId: workItemId,
        actorPeerId: 'mission_orchestration_worker',
        purpose: `resume requested task ${taskId || workItemId}`,
        ttlMs: options.leaseTtlMs || 15 * 60 * 1000,
        expectedVersion: workItem.version,
        idempotencyKey: `mission-resume:${upperMissionId}:${taskId || workItemId}:${attemptCount}`,
        metadata: {
          mission_id: upperMissionId,
          task_id: taskId || workItemId,
          resume_attempt: attemptCount,
        },
      });

      resumeStamps.set(taskId, {
        ...dispatch,
        work_item_id: workItemId,
        resumed_at: now,
        lease_id: claimed.lease.lease_id,
        lease_expires_at: claimed.lease.expires_at,
        attempt_count: attemptCount,
      });

      summary.reissued_count += 1;
      summary.recovered_task_ids.push(taskId || workItemId);
      summary.records.push({
        task_id: taskId || 'unknown',
        work_item_id: workItemId,
        status: 'reissued',
        lease_id: claimed.lease.lease_id,
        lease_expires_at: claimed.lease.expires_at,
        attempt_count: attemptCount,
      });
    }

    if (resumeStamps.size > 0) {
      // Applied to the board read under its writer lease, so a worker's status
      // write since the read above is kept. A task whose dispatch moved to
      // another WorkItem meanwhile keeps that dispatch.
      writeMissionNextTasks(nodePath.dirname(nextTasksPath(upperMissionId)), (onDisk) => {
        let stamped = false;
        const next = onDisk.map((task) => {
          const stamp = resumeStamps.get(String(task.task_id || '').trim());
          const dispatch =
            task.ticket_dispatch && typeof task.ticket_dispatch === 'object'
              ? (task.ticket_dispatch as Record<string, unknown>)
              : {};
          if (!stamp || String(dispatch.work_item_id || '').trim() !== stamp.work_item_id) {
            return task;
          }
          stamped = true;
          return { ...task, ticket_dispatch: stamp };
        });
        return stamped ? next : undefined;
      });
    }

    return summary;
  });
}

/**
 * Operator-initiated retry for blocked tasks (resume path only): flip
 * `blocked` back to `planned` so the next followup re-runs delegation
 * preflight. Blocked is otherwise terminal, which is right for automated
 * chains, but resume is the operator's explicit retry lever — after fixing
 * the cause (staffing, path scopes) the tasks must be dispatchable again.
 */
export function reissueBlockedMissionTasks(missionId: string): {
  mission_id: string;
  reissued_task_ids: string[];
} {
  const upperMissionId = String(missionId || '')
    .trim()
    .toUpperCase();
  if (!upperMissionId) return { mission_id: upperMissionId, reissued_task_ids: [] };

  return withExecutionContext('mission_controller', () => {
    let reissued: string[] = [];
    if (readNextTasks(upperMissionId).length === 0) {
      return { mission_id: upperMissionId, reissued_task_ids: reissued };
    }
    // Applied to the board read under its writer lease: a worker result
    // written meanwhile is neither lost nor reissued.
    writeMissionNextTasks(nodePath.dirname(nextTasksPath(upperMissionId)), (onDisk) => {
      reissued = [];
      const nextTasks = onDisk.map((task) => {
        if (String(task.status || 'planned') !== 'blocked') return task;
        const taskId = String(task.task_id || '').trim();
        if (taskId) reissued.push(taskId);
        return { ...task, status: 'planned' };
      });
      return reissued.length > 0 ? nextTasks : undefined;
    });
    return { mission_id: upperMissionId, reissued_task_ids: reissued };
  });
}
