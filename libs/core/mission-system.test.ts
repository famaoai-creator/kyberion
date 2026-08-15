import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ensureMissionTeamRuntimeViaSupervisor } = vi.hoisted(() => ({
  ensureMissionTeamRuntimeViaSupervisor: vi.fn(),
}));

vi.mock('./agent-runtime-supervisor.js', () => ({
  ensureMissionTeamRuntimeViaSupervisor,
}));

import { buildMissionSystem } from './mission-system.js';
import * as pathResolver from './path-resolver.js';
import {
  claimWorkItem,
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  listCoordinationEvents,
  listWorkItemAttempts,
  listWorkItems,
  setWorkCoordinationNamespace,
} from './work-coordination.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

describe('mission system work-item handoff', () => {
  beforeEach(() => {
    setWorkCoordinationNamespace('mission-system-handoff-test');
    clearWorkCoordinationStore();
    ensureMissionTeamRuntimeViaSupervisor.mockReset();
    ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue({});
  });

  afterEach(() => {
    clearWorkCoordinationStore();
    clearWorkCoordinationNamespace();
  });

  it('hands off every unfinished canonical item and records attempt and lease transitions', async () => {
    const missionId = 'MSN-HANDOFF-TEST';
    const unfinished = createWorkItem({
      itemId: 'handoff-item-1',
      title: 'Unfinished mission item',
      description: 'Continue the mission item',
      projectId: missionId,
      status: 'ready',
      metadata: { mission_id: missionId },
    });
    createWorkItem({
      itemId: 'handoff-item-2',
      title: 'Unclaimed mission item',
      description: 'Must remain visible as unfinished',
      projectId: missionId,
      status: 'ready',
    });
    createWorkItem({
      itemId: 'handoff-done',
      title: 'Completed item',
      description: 'Not eligible',
      projectId: missionId,
      status: 'done',
    });
    claimWorkItem({
      itemId: unfinished.item_id,
      actorPeerId: 'peer-old',
      purpose: 'implementation',
      expectedVersion: unfinished.version,
      idempotencyKey: 'claim-old',
    });

    const result = await buildMissionSystem().handoffMissionWorkItems({
      missionId,
      fromPeerId: 'peer-old',
      toPeerId: 'peer-new',
      purpose: 'continue implementation',
    });

    expect(result.handed_off).toHaveLength(1);
    expect(result.skipped.map((item) => item.item_id)).toEqual(['handoff-item-2']);
    expect(result.handed_off[0].item).toMatchObject({
      item_id: unfinished.item_id,
      claimed_by_peer_id: 'peer-new',
      metadata: {
        handoff_packet: {
          work_item_id: unfinished.item_id,
          attempt_id: expect.any(String),
        },
      },
    });
    expect(ensureMissionTeamRuntimeViaSupervisor).toHaveBeenCalledWith({
      missionId,
      requestedBy: 'mission_controller',
      reason: 'Prepare receiving peer peer-new for mission handoff.',
    });
    expect(listWorkItems().find((item) => item.item_id === unfinished.item_id)).toMatchObject({
      current_attempt_id: expect.any(String),
    });
    expect(listWorkItemAttempts(unfinished.item_id).map((attempt) => attempt.status)).toEqual([
      'released',
      'running',
    ]);
    expect(listCoordinationEvents({ event_type: 'handoff_written' })).toHaveLength(1);
    expect(listCoordinationEvents({ event_type: 'handoff_consumed' })).toHaveLength(1);
  });

  it('fails closed before handoff when runtime readiness fails', async () => {
    const missionId = 'MSN-RUNTIME-TEST';
    const leased = createWorkItem({
      itemId: 'runtime-item',
      title: 'Runtime handoff item',
      description: 'Receiver may be absent',
      projectId: missionId,
      status: 'ready',
    });
    claimWorkItem({
      itemId: leased.item_id,
      actorPeerId: 'peer-old',
      purpose: 'runtime readiness',
      expectedVersion: leased.version,
      idempotencyKey: 'runtime-claim',
    });
    const before = listWorkItems()[0];
    const beforeAttempts = listWorkItemAttempts(before.item_id);

    ensureMissionTeamRuntimeViaSupervisor.mockRejectedValueOnce(new Error('receiver absent'));
    const result = await buildMissionSystem().handoffMissionWorkItems({
      missionId,
      fromPeerId: 'peer-old',
      toPeerId: 'peer-new',
      purpose: 'runtime readiness',
    });

    expect(result.runtime_requested).toBe(true);
    expect(result.runtime_error).toBe('receiver absent');
    expect(result.handed_off).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(ensureMissionTeamRuntimeViaSupervisor).toHaveBeenCalledWith({
      missionId,
      requestedBy: 'mission_controller',
      reason: 'Prepare receiving peer peer-new for mission handoff.',
    });
    expect(listWorkItems()[0]).toMatchObject({
      item_id: before.item_id,
      lease_id: before.lease_id,
      claimed_by_peer_id: before.claimed_by_peer_id,
      current_attempt_id: before.current_attempt_id,
      status: before.status,
    });
    expect(listWorkItemAttempts(before.item_id)).toEqual(beforeAttempts);
    expect(listWorkItems()[0]).toMatchObject({
      metadata: {
        pending_handoff: {
          packet: {
            work_item_id: before.item_id,
            attempt_id: expect.any(String),
          },
          source_peer_id: 'peer-old',
          target_peer_id: 'peer-new',
          retry_marker: expect.stringMatching(/^runtime-unavailable:/),
        },
      },
    });
    expect(listCoordinationEvents({ event_type: 'handoff_written' })).toHaveLength(1);
    expect(listCoordinationEvents({ event_type: 'handoff_consumed' })).toHaveLength(0);

    ensureMissionTeamRuntimeViaSupervisor.mockResolvedValueOnce({});
    const retry = await buildMissionSystem().handoffMissionWorkItems({
      missionId,
      fromPeerId: 'peer-old',
      toPeerId: 'peer-new',
      purpose: 'runtime readiness',
    });
    expect(retry.handed_off).toHaveLength(1);
    expect(retry.handed_off[0].item).toMatchObject({
      item_id: before.item_id,
      claimed_by_peer_id: 'peer-new',
    });
    expect(listCoordinationEvents({ event_type: 'handoff_consumed' })).toHaveLength(1);
  });

  it('filters mission handoff candidates by the mission tenant', async () => {
    const missionId = 'MSN-HANDOFF-TENANT-TEST';
    const missionPath = pathResolver.missionDir(missionId, 'confidential');
    const previousRole = process.env.MISSION_ROLE;
    const previousPersona = process.env.KYBERION_PERSONA;
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'sovereign';
    try {
      safeMkdir(missionPath, { recursive: true });
      safeWriteFile(
        `${missionPath}/mission-state.json`,
        JSON.stringify({
          mission_id: missionId,
          tier: 'confidential',
          tenant_slug: 'tenant-a',
        })
      );
      const tenantItem = createWorkItem({
        itemId: 'handoff-tenant-a',
        title: 'Tenant A item',
        description: 'Only the mission tenant item may be handed off.',
        projectId: missionId,
        status: 'ready',
        context: {
          tenant_slug: 'tenant-a',
          mission_id: missionId,
          project_id: missionId,
          work_shape: 'improvement_experiment',
        },
      });
      createWorkItem({
        itemId: 'handoff-tenant-b',
        title: 'Tenant B item',
        description: 'A different tenant must remain outside the handoff.',
        projectId: missionId,
        status: 'ready',
        context: {
          tenant_slug: 'tenant-b',
          mission_id: missionId,
          project_id: missionId,
          work_shape: 'improvement_experiment',
        },
      });
      claimWorkItem({
        itemId: tenantItem.item_id,
        actorPeerId: 'peer-old',
        purpose: 'tenant-scoped handoff',
        expectedVersion: tenantItem.version,
        idempotencyKey: 'claim-tenant-a',
      });

      const result = await buildMissionSystem().handoffMissionWorkItems({
        missionId,
        fromPeerId: 'peer-old',
        toPeerId: 'peer-new',
        purpose: 'tenant-scoped handoff',
        ensureRuntime: false,
      });

      expect(result.handed_off.map((entry) => entry.item.item_id)).toEqual(['handoff-tenant-a']);
      expect(listWorkItems().find((item) => item.item_id === 'handoff-tenant-b')).toMatchObject({
        status: 'ready',
        context: { tenant_slug: 'tenant-b' },
      });
    } finally {
      safeRmSync(missionPath, { recursive: true, force: true });
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
      if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = previousPersona;
    }
  });
});
