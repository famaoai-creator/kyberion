import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import { normalizeEventScope } from '../event-scope.js';
const fixture = vi.hoisted(() => ({ approval: null as ApprovalRequestRecord | null }));
vi.mock('../governance/approval-store-reader.js', () => ({
  loadApprovalRequest: () => fixture.approval,
}));
import {
  claimWorkItem,
  createWorkItem,
  getWorkItem,
  updateWorkItem,
  releaseWorkItem,
  clearWorkCoordinationStore,
  clearWorkCoordinationNamespace,
  setWorkCoordinationNamespace,
  quarantineWorkItemExecution,
  releaseWorkItemEffectOwnership,
  expireWorkItemLeases,
} from './work-coordination.js';
import { workEffectOwnership } from './work-effect-ownership.js';
import type { WorkItem } from './work-coordination-types.js';
beforeEach(() => {
  setWorkCoordinationNamespace('effect-ownership-regression');
  clearWorkCoordinationStore();
  fixture.approval = null;
});
afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
});
function create(id: string, tenant?: string) {
  return createWorkItem({
    itemId: id,
    title: id,
    description: 'isolated',
    status: 'ready',
    ...(tenant ? { context: { tenant_slug: tenant } } : {}),
    metadata: { dot_id: id, target: 'service:shared' },
  });
}
const claim = (id: string) =>
  claimWorkItem({
    itemId: id,
    actorPeerId: 'dot:' + id,
    purpose: 'isolated',
    requireNewLease: true,
  });
describe('durable effect ownership mutations', () => {
  it.each(['active', 'expired'] as const)(
    'settles a generic uncertain %s attempt only with exact authenticated human recovery proof',
    (leaseState) => {
      createWorkItem({
        itemId: 'generic',
        title: 'generic remote task',
        description: 'No dot authority',
        status: 'ready',
      });
      const owned = claimWorkItem({ itemId: 'generic', actorPeerId: 'worker-1', purpose: 'test' });
      expect(() =>
        updateWorkItem({
          itemId: 'generic',
          context: { ...owned.item.context, mission_id: 'MSN-REWRITE-DURING-ASK' },
        })
      ).toThrow('execution scope is immutable');
      expect(() =>
        quarantineWorkItemExecution({
          itemId: 'generic',
          leaseId: owned.lease.lease_id,
          actorPeerId: 'other',
          reason: 'supervisor_response_closed',
        })
      ).toThrow('holder');
      const held = quarantineWorkItemExecution({
        itemId: 'generic',
        leaseId: owned.lease.lease_id,
        actorPeerId: 'worker-1',
        reason: 'supervisor_response_closed',
      });
      expect(() =>
        updateWorkItem({
          itemId: 'generic',
          context: { ...held.context, mission_id: 'MSN-SCOPE-REWRITE' },
        })
      ).toThrow('execution scope is immutable');
      expect(getWorkItem('generic')?.context).toEqual(held.context);
      expect(() =>
        releaseWorkItemEffectOwnership({
          itemId: 'generic',
          expectedVersion: held.version,
          approvalRequestId: 'human-proof',
        })
      ).toThrow('unleased');
      if (leaseState === 'expired')
        expireWorkItemLeases(new Date(Date.now() + 60 * 60_000).toISOString());
      const quarantined =
        leaseState === 'expired'
          ? getWorkItem('generic')!
          : releaseWorkItem({
              itemId: 'generic',
              leaseId: owned.lease.lease_id,
              actorPeerId: 'worker-1',
              nextStatus: 'blocked',
              summary: 'Operator confirmed the exact runtime stopped; effects still require review',
            }).item;
      expect(quarantined.effect_ownership?.state).toBe('held');
      const input = {
        itemId: 'generic',
        expectedVersion: quarantined.version,
        approvalRequestId: 'human-proof',
      };
      expect(() => releaseWorkItemEffectOwnership(input)).toThrow('authenticated human');
      const approvedScope = normalizeEventScope({ ...quarantined.context, tier: 'public' });
      fixture.approval = {
        scope: approvedScope,
        id: 'human-proof',
        status: 'approved',
        decidedBy: 'alice',
        decidedByType: 'human',
        authenticated: true,
        requestedBy: 'worker-1',
        correlationId: `work-effect-release:generic:${held.current_attempt_id}`,
        accountability: {
          finalDecision: 'human_only',
          effectBinding: `work_effect_release:worker-1:generic:${held.current_attempt_id}@v${quarantined.version}`,
        },
      } as ApprovalRequestRecord;
      fixture.approval.authenticated = false;
      expect(() => releaseWorkItemEffectOwnership(input)).toThrow('authenticated human');
      fixture.approval.authenticated = true;
      fixture.approval.scope = { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'other' };
      expect(() => releaseWorkItemEffectOwnership(input)).toThrow('bind');
      fixture.approval.scope = approvedScope;
      fixture.approval.scope = {
        scope_kind: 'project',
        tier: 'public',
        project_id: 'another-project',
      };
      expect(() => releaseWorkItemEffectOwnership(input)).toThrow('entity scope');
      fixture.approval.scope = approvedScope;
      const exactBinding = fixture.approval.accountability!.effectBinding;
      fixture.approval.accountability!.effectBinding = 'work_effect_release:wrong-attempt';
      expect(() => releaseWorkItemEffectOwnership(input)).toThrow('bind');
      fixture.approval.accountability!.effectBinding = exactBinding;
      expect(() =>
        releaseWorkItemEffectOwnership({ ...input, expectedVersion: input.expectedVersion + 1 })
      ).toThrow();
      const restored = releaseWorkItemEffectOwnership(input);
      expect(restored).toMatchObject({
        status: 'ready',
        effect_ownership: {
          state: 'settled',
          settlement: 'human_verified',
          approval_request_id: 'human-proof',
        },
        metadata: { execution_outcome: 'reconciled', recovery_required: false },
      });
      expect(restored.metadata?.dot_executor).toBeUndefined();
      expect(restored.lease_id).toBeUndefined();
      expect(
        claimWorkItem({ itemId: 'generic', actorPeerId: 'worker-1', purpose: 'verified retry' })
          .item.status
      ).toBe('in_progress');
    }
  );

  it('ordinary archive and metadata replacement retain original target and block own reclaim', () => {
    create('a');
    create('b');
    claim('a');
    updateWorkItem({
      itemId: 'a',
      status: 'archived',
      metadata: { dot_id: 'a', target: 'service:changed' },
    });
    expect(getWorkItem('a')?.effect_ownership).toMatchObject({
      target: 'service:shared',
      state: 'held',
    });
    expect(() => claim('b')).toThrow(/ownership/);
    updateWorkItem({ itemId: 'a', status: 'ready' });
    expect(() => claim('a')).toThrow(/ownership/);
  });
  it('validates completion disposition before changing the active lease', () => {
    create('a');
    create('b');
    const owned = claim('a');
    const input = { itemId: 'a', leaseId: owned.lease.lease_id, actorPeerId: 'dot:a' };
    expect(() =>
      releaseWorkItem({ ...input, nextStatus: 'archived', effectDisposition: 'completed' })
    ).toThrow(/settlement/);
    expect(getWorkItem('a')?.lease_id).toBe(owned.lease.lease_id);
    expect(() => claim('b')).toThrow(/ownership/);
    releaseWorkItem({ ...input, nextStatus: 'done', effectDisposition: 'completed' });
    expect(getWorkItem('a')?.effect_ownership?.state).toBe('settled');
    expect(claim('b').item.status).toBe('in_progress');
  });
  it('never accepts a stale owner or duplicate execution claim', () => {
    create('a');
    const first = claim('a');
    expect(() => claim('a')).toThrow();
    expect(() =>
      releaseWorkItem({
        itemId: 'a',
        leaseId: first.lease.lease_id,
        actorPeerId: 'dot:other',
        nextStatus: 'done',
        effectDisposition: 'completed',
      })
    ).toThrow(/owner/);
    expect(getWorkItem('a')?.effect_ownership?.state).toBe('held');
    expect(getWorkItem('a')?.attempts).toHaveLength(1);
  });
  it.each([
    null,
    false,
    0,
    '',
    {},
    { state: 'settled', target: 'x', attempt_id: 'a', actor_id: 'dot:a' },
  ])('fails closed for explicit malformed ownership %j', (value) => {
    expect(() => workEffectOwnership({ effect_ownership: value } as unknown as WorkItem)).toThrow(
      /invalid stored effect/
    );
  });
  it('does not confuse tenantless ownership with tenant ownership', () => {
    create('a');
    claim('a');
    create('b', 'synthetic-tenant');
    expect(claim('b').item.status).toBe('in_progress');
  });
});
