import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestRecord } from './approval-store.js';
import type { DelegatedExecutionTarget } from './delegated-execution.js';
import {
  assertHumanExecutionNotPreviouslyClaimed,
  claimHumanExecutionAuthorization,
  currentHumanExecutionAuthorization,
  runHumanExecutionAuthorization,
} from './human-execution.js';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  usable: vi.fn(),
  list: vi.fn(),
  claim: vi.fn(),
  delegatedClaimed: false,
}));
vi.mock('./approval-store-reader.js', () => ({
  listApprovalRequests: mocks.list,
  loadApprovalRequest: mocks.load,
  isApprovalRequestExpired: () => false,
}));
vi.mock('./approval-apply-claim.js', () => ({ claimApprovalApply: mocks.claim }));
vi.mock('./approval-separation-of-duties.js', () => ({ assertApprovalUsable: mocks.usable }));
vi.mock('./approval-presentation.js', () => ({ computeApprovalPayloadHash: () => 'record-hash' }));
vi.mock('../lock-utils.js', () => ({
  withLockSync: (_name: string, action: () => unknown) => action(),
}));
vi.mock('./delegated-execution.js', () => ({
  isDelegatedExecutionReplayBlocked: () => mocks.delegatedClaimed,
  normalizeDelegatedTarget: (target: DelegatedExecutionTarget) => target,
  delegatedExecutionIdentity: () => 'stable-effect',
  delegatedExecutionBindingHash: (target: DelegatedExecutionTarget) => JSON.stringify(target),
}));
const target: DelegatedExecutionTarget = {
  operationId: 'service:preset:example:write',
  params: { amount: 50 },
  tenantSlug: 'acme',
  agentId: 'worker',
  source: { taskId: 'task' },
  stepId: 'write',
  correlationId: 'attempt',
};
const reference = { channel: 'approval-acme', requestId: 'request', claimId: 'claim' };
function record(): ApprovalRequestRecord {
  return {
    id: 'request',
    kind: 'mission_gate',
    channel: 'approval-acme',
    storageChannel: 'approval-acme',
    threadTs: 'step',
    correlationId: 'attempt',
    requestedBy: 'worker',
    requestedAt: new Date().toISOString(),
    title: 'Approve',
    summary: 'Write',
    severity: 'high',
    status: 'approved',
    decidedByType: 'human',
    authenticated: true,
    decidedAuthMethod: 'surface_session',
    scope: { tier: 'confidential', tenant_slug: 'acme', task_id: 'task', scope_kind: 'task' },
    requestedByContext: {
      surface: 'system',
      actorId: 'worker',
      actorRole: 'owner',
      executionBindingHash: JSON.stringify(target),
      executionIdentity: 'stable-effect',
    },
    accountability: {
      finalDecision: 'human_only',
      payloadHash: JSON.stringify(target),
      effectBinding: 'write',
    },
    applyClaim: { claimId: 'claim', startedBy: 'worker', startedAt: new Date().toISOString() },
  };
}
describe('runtime-owned human execution capability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.load.mockReturnValue(record());
    mocks.list.mockReturnValue([]);
  });
  it('is absent outside a current effect and binds exact operation payload', async () => {
    expect(currentHumanExecutionAuthorization(target.operationId, target.params)).toBeUndefined();
    await runHumanExecutionAuthorization(target, reference, async () => {
      expect(currentHumanExecutionAuthorization(target.operationId, target.params)).toBeDefined();
      expect(
        currentHumanExecutionAuthorization(target.operationId, { amount: 1000 })
      ).toBeUndefined();
      expect(currentHumanExecutionAuthorization('other', target.params)).toBeUndefined();
    });
  });
  it.each(['weak', 'agent', 'tenant', 'claim', 'settled'])(
    'rejects %s approval before effects',
    async (change) => {
      const approved = record();
      if (change === 'weak') approved.decidedAuthMethod = 'local_admin_token';
      if (change === 'agent') approved.decidedByType = 'ai_agent';
      if (change === 'tenant') approved.scope!.tenant_slug = 'other';
      if (change === 'claim') approved.applyClaim!.claimId = 'other';
      if (change === 'settled') approved.applyResult = { result: 'success' };
      mocks.load.mockReturnValue(approved);
      const effect = vi.fn();
      await expect(runHumanExecutionAuthorization(target, reference, effect)).rejects.toThrow(
        'HUMAN_EXECUTION_DENIED'
      );
      expect(effect).not.toHaveBeenCalled();
    }
  );
  it('revalidates revocation after an async boundary', async () => {
    await runHumanExecutionAuthorization(target, reference, async () => {
      await Promise.resolve();
      mocks.usable.mockImplementation(() => {
        throw new Error('revoked');
      });
      expect(currentHumanExecutionAuthorization(target.operationId, target.params)).toBeUndefined();
    });
  });
  it('blocks a new run or changed payload after the original human effect was claimed', () => {
    const prior = { ...record(), storageChannel: 'custom-a' };
    mocks.list.mockImplementation((params?: { storageChannels?: string[] }) =>
      !params?.storageChannels || params.storageChannels.includes('custom-a') ? [prior] : []
    );
    expect(() =>
      assertHumanExecutionNotPreviouslyClaimed({ ...target, params: { amount: 1000 } })
    ).toThrow('RECONCILIATION_REQUIRED');
    expect(() => claimHumanExecutionAuthorization(target, reference)).toThrow(
      'RECONCILIATION_REQUIRED'
    );
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it('serializes claim publication across distinct approval requests for one effect slot', () => {
    const approved = record();
    approved.applyClaim = undefined;
    mocks.load.mockReturnValue(approved);
    mocks.claim.mockImplementation(() => {
      approved.applyClaim = record().applyClaim;
      mocks.list.mockReturnValue([approved]);
      return approved;
    });
    claimHumanExecutionAuthorization(target, reference);
    expect(() =>
      claimHumanExecutionAuthorization(target, { ...reference, requestId: 'new-request' })
    ).toThrow('RECONCILIATION_REQUIRED');
    expect(mocks.claim).toHaveBeenCalledOnce();
  });
  it('cannot switch to human approval after a charter execution claim', () => {
    mocks.delegatedClaimed = true;
    expect(() => claimHumanExecutionAuthorization(target, reference)).toThrow(
      'RECONCILIATION_REQUIRED'
    );
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
