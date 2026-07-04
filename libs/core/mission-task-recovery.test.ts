import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claimWorkItem,
  clearWorkCoordinationStore,
  getWorkItem,
  listActiveWorkLeases,
  listWorkItemAttempts,
  setWorkCoordinationNamespace,
} from './work-coordination.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeReadFile, safeWriteFile } from './secure-io.js';
import { recoverMissionRequestedTasks } from './mission-task-recovery.js';
import { dispatchMissionTickets } from '../../scripts/refactor/mission-ticket-dispatch.js';
import type { MissionState } from '../../scripts/refactor/mission-types.js';

const missionId = 'MSN-RECOVERY-001';
const missionPath = pathResolver.missionDir(missionId, 'public');

function makeMissionState(): MissionState {
  return {
    mission_id: missionId,
    mission_type: 'operations',
    tier: 'public',
    status: 'active',
    execution_mode: 'local',
    relationships: {
      project: {
        project_id: 'PRJ-RECOVERY-001',
        project_path: `active/projects/public/shared/PRJ-RECOVERY-001/project-os`,
        relationship_type: 'supports',
        affected_artifacts: [],
        gate_impact: 'informational',
        traceability_refs: [],
      },
    },
    priority: 1,
    assigned_persona: 'worker',
    confidence_score: 1,
    git: {
      branch: 'mission/recovery-test',
      start_commit: 'abc123',
      latest_commit: 'abc123',
      checkpoints: [],
    },
    history: [],
  };
}

beforeEach(() => {
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_PERSONA = 'worker';
  setWorkCoordinationNamespace('mission-task-recovery-test');
  clearWorkCoordinationStore();
  if (!safeExistsSync(missionPath)) safeMkdir(missionPath, { recursive: true });
  safeWriteFile(`${missionPath}/mission-state.json`, JSON.stringify(makeMissionState(), null, 2));
});

afterEach(() => {
  clearWorkCoordinationStore();
  safeRmSync(missionPath, { recursive: true, force: true });
  setWorkCoordinationNamespace(null);
});

describe('mission task recovery', () => {
  it('waits for active leases and reissues only expired requested tasks', async () => {
    const state = makeMissionState();
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-1',
            status: 'planned',
            assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
            description: 'Implement the recovery flow',
            deliverable: 'libs/core/mission-task-recovery.ts',
            target_path: 'libs/core/mission-task-recovery.ts',
          },
        ],
        null,
        2
      )
    );

    await dispatchMissionTickets(state, { targets: ['workitem'] });
    const plannedTasks = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    const workItemId = plannedTasks[0].ticket_dispatch.work_item_id as string;

    const initialClaim = claimWorkItem({
      itemId: workItemId,
      actorPeerId: 'agent-1',
      purpose: 'initial execution',
      ttlMs: 60_000,
      expectedVersion: 1,
      idempotencyKey: 'initial-claim',
    });
    expect(initialClaim.item.status).toBe('in_progress');
    expect(listWorkItemAttempts(workItemId)).toHaveLength(1);

    plannedTasks[0].status = 'requested';
    plannedTasks[0].ticket_dispatch.attempt_count = 1;
    safeWriteFile(`${missionPath}/NEXT_TASKS.json`, JSON.stringify(plannedTasks, null, 2));

    const waitingNow = new Date(Date.parse(initialClaim.lease.expires_at) - 1_000).toISOString();
    const waiting = recoverMissionRequestedTasks(missionId, { now: waitingNow });
    expect(waiting.waiting_count).toBe(1);
    expect(waiting.reissued_count).toBe(0);
    expect(listWorkItemAttempts(workItemId)).toHaveLength(1);
    expect(listActiveWorkLeases()).toHaveLength(1);

    const expiredNow = new Date(Date.parse(initialClaim.lease.expires_at) + 1_000).toISOString();
    const recovered = recoverMissionRequestedTasks(missionId, { now: expiredNow });
    expect(recovered.reissued_count).toBe(1);
    expect(recovered.waiting_count).toBe(0);
    expect(recovered.recovered_task_ids).toEqual(['task-1']);
    expect(listWorkItemAttempts(workItemId)).toHaveLength(2);
    expect(getWorkItem(workItemId)?.lease_id).toBeDefined();

    const resumedTasks = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(resumedTasks[0].ticket_dispatch).toMatchObject({
      work_item_id: workItemId,
      attempt_count: 2,
      lease_id: expect.any(String),
      lease_expires_at: expect.any(String),
      resumed_at: expect.any(String),
    });
  });
});
