import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { requestWorkEffectReleaseApproval } from './work-effect-release-request.js';
import { decideApprovalRequest, loadApprovalRequest } from './approval-store.js';
import { approvalStoreRoots } from './approval-store-paths.js';
import { safeRmSync } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import {
  getWorkItem,
  createWorkItem,
  claimWorkItem,
  quarantineWorkItemExecution,
  releaseWorkItem,
  releaseWorkItemEffectOwnership,
  clearWorkCoordinationStore,
  setWorkCoordinationNamespace,
  clearWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';

beforeEach(() => {
  setWorkCoordinationNamespace('generic-effect-request-test');
  clearWorkCoordinationStore();
});
afterEach(() => {
  const roots = approvalStoreRoots();
  safeRmSync(pathResolver.rootResolve(`${roots.coordination}/autonomy`), {
    recursive: true,
    force: true,
  });
  safeRmSync(pathResolver.rootResolve(`${roots.observability}/autonomy`), {
    recursive: true,
    force: true,
  });
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
});

describe('operator work-effect approval request', () => {
  it('creates the existing human-only approval without releasing work, then applies the exact decided proof', () => {
    const item = createWorkItem({
      itemId: 'WI-OPERATOR-RECOVERY',
      title: 'Review a lost response',
      description: 'Synthetic public recovery',
      status: 'ready',
    });
    const claim = claimWorkItem({
      itemId: item.item_id,
      actorPeerId: 'worker-recovery',
      purpose: 'test',
    });
    const held = quarantineWorkItemExecution({
      itemId: item.item_id,
      leaseId: claim.lease.lease_id,
      actorPeerId: 'worker-recovery',
      reason: 'supervisor_response_closed',
    });
    expect(() =>
      requestWorkEffectReleaseApproval({
        itemId: item.item_id,
        expectedVersion: held.version,
        requestedBy: 'operator-requester',
      })
    ).toThrow('scheduling lease');
    const blocked = releaseWorkItem({
      itemId: item.item_id,
      leaseId: claim.lease.lease_id,
      actorPeerId: 'worker-recovery',
      nextStatus: 'blocked',
    }).item;
    const approval = requestWorkEffectReleaseApproval({
      itemId: item.item_id,
      expectedVersion: blocked.version,
      requestedBy: 'operator-requester',
    });
    expect(approval).toMatchObject({
      status: 'pending',
      accountability: {
        finalDecision: 'human_only',
        effectBinding: expect.stringContaining(`@v${blocked.version}`),
      },
    });
    expect(loadApprovalRequest('autonomy', approval.id)?.id).toBe(approval.id);
    expect(getWorkItem(item.item_id)?.effect_ownership?.state).toBe('held');
    const input = {
      itemId: item.item_id,
      expectedVersion: blocked.version,
      approvalRequestId: approval.id,
    };
    expect(() => releaseWorkItemEffectOwnership(input)).toThrow('authenticated human');
    decideApprovalRequest('mission_controller', {
      channel: 'terminal',
      storageChannel: 'autonomy',
      requestId: approval.id,
      decision: 'approved',
      decidedBy: 'alice',
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'surface_session',
      payloadHash: approval.accountability!.payloadHash,
      effectBinding: approval.accountability!.effectBinding,
    });
    expect(releaseWorkItemEffectOwnership(input)).toMatchObject({
      status: 'ready',
      effect_ownership: { state: 'settled', settlement: 'human_verified' },
    });
  });
});
