import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { WorkItem } from '../workforce/work-coordination-types.js';
const fixture = vi.hoisted(() => ({
  item: {} as WorkItem,
  mission: 'MSN-ISSUED',
  state: {} as Record<string, unknown>,
  scope: {} as Record<string, unknown>,
  claim: vi.fn(),
  release: vi.fn(),
  quarantine: vi.fn(),
}));
vi.mock('../authority.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../authority.js')>()),
  resolveIdentityContext: () => ({ missionId: fixture.mission }),
}));
vi.mock('../foundation/execution-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../foundation/execution-scope.js')>()),
  currentExecutionScope: () => fixture.scope,
}));
vi.mock('../mission/mission-state.js', () => ({ loadState: () => fixture.state }));
vi.mock('../mission/mission-admission.js', () => ({
  resolveDotMissionAdmission: () => fixture.item.metadata!.mission_admission,
  resolveDotMissionAdmissionScope: () => ({ tenant_slug: 'acme', organization_id: 'support' }),
}));
vi.mock('../workforce/work-coordination.js', () => ({
  getWorkItem: () => fixture.item,
  updateWorkItem: (input: Record<string, unknown>) => {
    fixture.item = {
      ...fixture.item,
      status: input.status as WorkItem['status'],
      metadata: input.metadata as WorkItem['metadata'],
      context: input.context as WorkItem['context'],
      version: fixture.item.version + 1,
    };
    return fixture.item;
  },
  claimWorkItem: (input: Record<string, unknown>) => {
    fixture.claim(input);
    fixture.item = {
      ...fixture.item,
      status: 'in_progress',
      lease_id: 'lease1',
      current_attempt_id: 'attempt1',
      claimed_by_peer_id: 'mission_controller',
    };
    return { item: fixture.item, lease: { lease_id: 'lease1' } };
  },
  releaseWorkItem: fixture.release,
  quarantineWorkItemExecution: fixture.quarantine,
}));
import {
  resolveInformationAssetMissionExecution,
  runInformationAssetMissionWork,
} from './work-mission.js';
beforeEach(() => {
  vi.clearAllMocks();
  fixture.mission = 'MSN-ISSUED';
  fixture.scope = {
    tenantBound: true,
    tenantSlug: 'acme',
    organizationId: 'support',
    assumedRole: 'mission_controller',
    executionIdentity: { missionId: 'MSN-ISSUED' },
  };
  fixture.state = { status: 'active', tenant_slug: 'acme', organization_id: 'support' };
  fixture.item = {
    item_id: 'work1',
    version: 1,
    status: 'done',
    context: { tenant_slug: 'acme', organization_id: 'support', project_id: 'default' },
    metadata: {
      dot_id: 'dot1',
      requested_work_shape: 'mission',
      mission_id: 'MSN-ISSUED',
      mission_admission: { mandate_ref: 'mandate1' },
      information_asset_work: {
        version: 1,
        recipe_id: 'jira.approval_pending',
        recipe_version: 1,
        work_key: 'a'.repeat(64),
        observation: {
          event_id: 'e'.repeat(64),
          scope: { tenant_slug: 'acme', organization_id: 'support' },
          asset_type: 'workflow.approval_request',
          location_id: 'jira',
          binding_id: 'b1',
          service_id: 'jira',
          subject_id: 'SUP-1/approval/2',
          change_id: 'v1',
          event_type: 'approval.observed',
          content_sha256: 'c'.repeat(64),
        },
      },
    },
  } as WorkItem;
});
describe('canonical information asset mission execution', () => {
  it('reuses only the issued active scoped mission', () => {
    expect(resolveInformationAssetMissionExecution('work1')).toMatchObject({
      mission_id: 'MSN-ISSUED',
      work_item_id: 'work1',
    });
    fixture.mission = 'MSN-OTHER';
    expect(() => resolveInformationAssetMissionExecution('work1')).toThrow('BINDING');
  });
  it('refuses inactive mission, foreign tenant, and non-owner execution before claiming', () => {
    fixture.state.status = 'planned';
    expect(() => resolveInformationAssetMissionExecution('work1')).toThrow('SCOPE');
    fixture.state.status = 'active';
    fixture.scope.tenantSlug = 'other';
    expect(() => resolveInformationAssetMissionExecution('work1')).toThrow('SCOPE');
    fixture.scope.tenantSlug = 'acme';
    fixture.scope.assumedRole = 'worker';
    expect(() => resolveInformationAssetMissionExecution('work1')).toThrow('SCOPE');
    expect(fixture.claim).not.toHaveBeenCalled();
  });
  it('claims the original admission WorkItem and releases verified completion through existing lifecycle', async () => {
    const run = vi.fn(async () => ({
      status: 'completed' as const,
      work_item_id: 'work1',
      work_key: 'a'.repeat(64),
      summary: 'Readback verified',
      evidence_sha256: 'b'.repeat(64),
    }));
    await runInformationAssetMissionWork('work1', run);
    expect(fixture.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'work1',
        actorPeerId: 'mission_controller',
        requireNewLease: true,
      })
    );
    expect(run).toHaveBeenCalledWith({
      workItemId: 'work1',
      attemptId: 'attempt1',
      leaseId: 'lease1',
      dotId: 'dot1',
      actorId: 'mission_controller',
    });
    expect(fixture.release).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'work1',
        nextStatus: 'done',
        effectDisposition: 'completed',
      })
    );
    expect(fixture.item.context?.mission_id).toBe('MSN-ISSUED');
  });
  it('keeps existing service approval holds and quarantines uncertain effects', async () => {
    await runInformationAssetMissionWork('work1', async () => ({
      status: 'waiting_approval',
      work_item_id: 'work1',
      work_key: 'a'.repeat(64),
      summary: 'Approval required',
      approval_request_id: 'existing-approval',
    }));
    expect(fixture.release).toHaveBeenCalledWith(
      expect.objectContaining({ nextStatus: 'blocked', effectDisposition: 'pre_effect' })
    );
    fixture.item = { ...fixture.item, lease_id: undefined, status: 'done' };
    await runInformationAssetMissionWork('work1', async () => ({
      status: 'unknown_effect',
      work_item_id: 'work1',
      work_key: 'a'.repeat(64),
      summary: 'Unknown',
    }));
    expect(fixture.quarantine).toHaveBeenCalled();
  });
  it('never reclaims uncertain prior writes', async () => {
    fixture.item.metadata!.information_asset_outcome = { status: 'unknown_effect' };
    await expect(runInformationAssetMissionWork('work1', vi.fn())).rejects.toThrow('UNCERTAIN');
    expect(fixture.claim).not.toHaveBeenCalled();
  });
});
