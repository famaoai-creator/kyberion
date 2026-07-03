import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import {
  claimWorkItem,
  expireWorkItemLeases,
  getWorkItem,
  listActiveWorkLeases,
  listWorkItemAttempts,
} from './work-coordination.js';

export interface MissionRequestedTaskRecoveryRecord {
  task_id: string;
  work_item_id?: string;
  status:
    | 'waiting'
    | 'reissued'
    | 'missing_dispatch'
    | 'missing_work_item'
    | 'terminal'
    | 'skipped';
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

function nextTasksPath(missionId: string): string {
  return `${pathResolver.missionDir(missionId, 'public')}/NEXT_TASKS.json`;
}

function readNextTasks(missionId: string): Array<Record<string, unknown>> {
  const filePath = nextTasksPath(missionId);
  if (!safeExistsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeNextTasks(missionId: string, tasks: Array<Record<string, unknown>>): void {
  safeWriteFile(nextTasksPath(missionId), JSON.stringify(tasks, null, 2));
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
    const now = options.now || new Date().toISOString();
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

    let mutated = false;
    const nextTasks = tasks.map((task) => ({ ...task }));

    for (const task of nextTasks) {
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

      task.ticket_dispatch = {
        ...dispatch,
        work_item_id: workItemId,
        resumed_at: now,
        lease_id: claimed.lease.lease_id,
        lease_expires_at: claimed.lease.expires_at,
        attempt_count: attemptCount,
      };

      mutated = true;
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

    if (mutated) {
      writeNextTasks(upperMissionId, nextTasks);
    }

    return summary;
  });
}
