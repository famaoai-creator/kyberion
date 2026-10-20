import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimWorkItem,
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  getWorkItem,
  listActiveWorkLeases,
  releaseWorkItem,
  renewWorkItemLease,
  resumeSuspendedPipelineWorkItem,
  setWorkCoordinationNamespace,
  finalizeDeniedSuspendedPipelineWorkItem,
} from './work-coordination.js';
import type { PipelineRunJournalState } from '../pipeline/pipeline-run-journal.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import { mintScopeEnvelope, withScopeEnvelope } from '../scope-envelope.js';

const fixture = vi.hoisted(() => ({
  journal: undefined as unknown,
  approval: undefined as unknown,
  unknownEffect: false,
  loadJournal: vi.fn(),
  assertApproval: vi.fn(),
}));
vi.mock('../pipeline/pipeline-run-journal.js', () => ({
  loadPipelineRunJournal: (...args: unknown[]) => {
    fixture.loadJournal(...args);
    return fixture.journal;
  },
}));
vi.mock('../governance/approval-store-reader.js', async (original) => ({
  ...(await original<typeof import('../governance/approval-store-reader.js')>()),
  loadApprovalRequest: () => fixture.approval,
}));
vi.mock('../governance/approval-separation-of-duties.js', () => ({
  assertApprovalUsable: fixture.assertApproval,
}));
vi.mock('../governance/accountability-charter-registry.js', async (original) => ({
  ...(await original<typeof import('../governance/accountability-charter-registry.js')>()),
  listCharterIds: () => (fixture.unknownEffect ? ['charter-1'] : []),
  readCharter: () => ({ charter_id: 'charter-1' }),
  readCharterLedger: () => [
    {
      kind: 'delegated_execution',
      permit_id: 'permit-1',
      state: 'unknown',
      source: { workItemId: 'WI-CONTINUE' },
    },
  ],
}));

describe('protected pipeline WorkItem continuation', () => {
  let request: Parameters<typeof resumeSuspendedPipelineWorkItem>[0];
  let originalLeaseId: string;
  let savedGovernance: string | undefined;
  const binding = 'b'.repeat(64);
  beforeEach(() => {
    savedGovernance = process.env.KYBERION_ENTITY_GOVERNANCE;
    delete process.env.KYBERION_ENTITY_GOVERNANCE;
    setWorkCoordinationNamespace(`pipeline-continuation-${randomUUID()}`);
    fixture.unknownEffect = false;
    fixture.loadJournal.mockClear();
    fixture.assertApproval.mockClear();
    createWorkItem({
      itemId: 'WI-CONTINUE',
      title: 'Original pipeline work',
      description: 'Bound original attempt',
      status: 'ready',
      context: { tenant_slug: 'resume-tenant' },
      metadata: { dot_id: 'dot-test', target: 'pipeline:workflow.json' },
    });
    const claimed = claimWorkItem({
      itemId: 'WI-CONTINUE',
      actorPeerId: 'dot:dot-test',
      purpose: 'original pipeline',
    });
    originalLeaseId = claimed.lease.lease_id;
    request = {
      itemId: claimed.item.item_id,
      runId: 'pipeline-original',
      approvalRequestId: 'approval-original',
      storageChannel: 'pipeline-execution-resume-tenant',
      actorPeerId: 'dot:dot-test',
      expectedAttemptId: claimed.item.current_attempt_id!,
      tenantSlug: 'resume-tenant',
      sourceHash: 'a'.repeat(64),
    };
    releaseWorkItem({
      itemId: request.itemId,
      leaseId: originalLeaseId,
      actorPeerId: request.actorPeerId,
      nextStatus: 'blocked',
      metadata: {
        dot_executor: {
          status: 'blocked',
          mode: 'pipeline',
          awaiting_approval: true,
          pipeline_run_id: request.runId,
          approval_request_id: request.approvalRequestId,
          storage_channel: request.storageChannel,
        },
      },
    });
    fixture.approval = {
      id: request.approvalRequestId,
      status: 'approved',
      decidedByType: 'human',
      scope: { tier: 'confidential', tenant_slug: request.tenantSlug },
      requestedByContext: {
        pipelineRunId: request.runId,
        executionBindingHash: binding,
        targetStepId: 'send',
      },
      accountability: { finalDecision: 'human_only', payloadHash: binding },
    } as unknown as ApprovalRequestRecord;
    fixture.journal = {
      run_id: request.runId,
      path: '/protected/library-journal',
      events: [],
      completed_nodes: new Map(),
      started: {
        pipeline_id: 'original',
        input_path: 'workflow.json',
        step_ids: ['send'],
        library_execution: {
          source_sha256: request.sourceHash,
          initial_context: {},
          payload_scope: { tier: 'confidential', tenant_slug: request.tenantSlug },
          identity: { role: 'mission_controller', tenant_slug: request.tenantSlug },
          trust_resolved: true,
          work_item: {
            id: request.itemId,
            tenantSlug: request.tenantSlug,
            agentId: request.actorPeerId,
            attemptId: request.expectedAttemptId,
          },
        },
      },
      suspended: {
        step_id: 'send',
        approval_request_id: request.approvalRequestId,
        storage_channel: request.storageChannel,
        execution_binding_hash: binding,
        on_timeout: 'abort',
      },
    } satisfies PipelineRunJournalState;
  });
  afterEach(() => {
    clearWorkCoordinationStore();
    clearWorkCoordinationNamespace();
    if (savedGovernance === undefined) delete process.env.KYBERION_ENTITY_GOVERNANCE;
    else process.env.KYBERION_ENTITY_GOVERNANCE = savedGovernance;
  });

  it('replaces only the lease, keeps the original attempt/target and uses the exact protected partition', async () => {
    const before = getWorkItem(request.itemId)!;
    const resumed = await resumeSuspendedPipelineWorkItem(request);
    expect(resumed.item.current_attempt_id).toBe(request.expectedAttemptId);
    expect(resumed.item.attempts).toHaveLength(1);
    expect(resumed.item.attempts![0].attempt_id).toBe(before.attempts![0].attempt_id);
    expect(resumed.item.effect_ownership).toEqual(before.effect_ownership);
    expect(resumed.lease.previous_lease_id).toBe(originalLeaseId);
    expect(resumed.lease.lease_id).not.toBe(originalLeaseId);
    expect(fixture.loadJournal).toHaveBeenCalledWith(request.runId, undefined, {
      tier: 'confidential',
      tenantSlug: request.tenantSlug,
    });
    expect(fixture.assertApproval).toHaveBeenCalled();
    expect(() =>
      renewWorkItemLease({
        itemId: request.itemId,
        leaseId: originalLeaseId,
        actorPeerId: request.actorPeerId,
      })
    ).toThrow();
    const completed = releaseWorkItem({
      itemId: request.itemId,
      leaseId: resumed.lease.lease_id,
      actorPeerId: request.actorPeerId,
      nextStatus: 'done',
      effectDisposition: 'completed',
    });
    expect(completed.item.effect_ownership?.settlement).toBe('completed');
    expect(completed.item.attempts).toHaveLength(1);
  });

  it('only admits one runner under concurrent resume requests', async () => {
    const result = await Promise.allSettled([
      resumeSuspendedPipelineWorkItem(request),
      resumeSuspendedPipelineWorkItem(request),
    ]);
    expect(result.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(listActiveWorkLeases()).toHaveLength(1);
    expect(getWorkItem(request.itemId)?.attempts).toHaveLength(1);
  });

  it('rejects cross-tenant, changed source/attempt/actor and unbound or nonhuman approval', async () => {
    const other = mintScopeEnvelope({
      identity: { tenant_slug: 'other-tenant', session_id: 'session-other', tier: 'confidential' },
      policy: { read_tiers: ['confidential'], write_tier: 'confidential', purpose: 'other tenant' },
    });
    await expect(
      withScopeEnvelope(other, () => resumeSuspendedPipelineWorkItem(request))
    ).rejects.toThrow('caller tenant');
    for (const changed of [
      { ...request, tenantSlug: 'other' },
      { ...request, sourceHash: 'c'.repeat(64) },
      { ...request, expectedAttemptId: 'another-attempt' },
      { ...request, actorPeerId: 'other-peer' },
    ]) {
      await expect(resumeSuspendedPipelineWorkItem(changed)).rejects.toThrow('CONTINUATION_DENIED');
    }
    const approval = fixture.approval as ApprovalRequestRecord;
    approval.decidedByType = 'ai_agent';
    await expect(resumeSuspendedPipelineWorkItem(request)).rejects.toThrow('human approval');
    approval.decidedByType = 'human';
    approval.requestedByContext!.executionBindingHash = 'f'.repeat(64);
    await expect(resumeSuspendedPipelineWorkItem(request)).rejects.toThrow('human approval');
    expect(listActiveWorkLeases()).toHaveLength(0);
  });

  it('does not release or reopen an uncertain effect even after a human approves', async () => {
    fixture.unknownEffect = true;
    await expect(resumeSuspendedPipelineWorkItem(request)).rejects.toThrow('reconciliation');
    expect(getWorkItem(request.itemId)?.effect_ownership?.state).toBe('held');
    expect(listActiveWorkLeases()).toHaveLength(0);
  });

  it('archives a rejected original run only after a protected aborted terminal journal', async () => {
    (fixture.approval as ApprovalRequestRecord).status = 'rejected';
    await expect(finalizeDeniedSuspendedPipelineWorkItem(request)).rejects.toThrow(
      'protected original'
    );
    (fixture.journal as PipelineRunJournalState).finished = { status: 'aborted' };
    const item = await finalizeDeniedSuspendedPipelineWorkItem(request);
    expect(item.status).toBe('archived');
    expect(item.effect_ownership?.settlement).toBe('execution_aborted');
    expect(item.effect_ownership?.settlement_evidence_ref).toBe('/protected/library-journal');
    expect(item.attempts).toHaveLength(1);
    expect(item.attempts![0].status).toBe('blocked');
    expect(listActiveWorkLeases()).toHaveLength(0);
  });

  it('never terminalizes denied work with mismatched scope/hash or uncertain effects', async () => {
    (fixture.approval as ApprovalRequestRecord).status = 'cancelled';
    (fixture.journal as PipelineRunJournalState).finished = { status: 'aborted' };
    await expect(
      finalizeDeniedSuspendedPipelineWorkItem({ ...request, sourceHash: 'f'.repeat(64) })
    ).rejects.toThrow('protected original');
    await expect(
      finalizeDeniedSuspendedPipelineWorkItem({ ...request, tenantSlug: 'other' })
    ).rejects.toThrow('tenant');
    fixture.unknownEffect = true;
    await expect(finalizeDeniedSuspendedPipelineWorkItem(request)).rejects.toThrow(
      'reconciliation'
    );
    expect(getWorkItem(request.itemId)?.effect_ownership?.state).toBe('held');
    fixture.unknownEffect = false;
    const item = await finalizeDeniedSuspendedPipelineWorkItem(request);
    expect(item.status).toBe('archived');
    expect(item.effect_ownership?.settlement).toBe('execution_aborted');
  });

  it('settles persisted expiry only after its actual deadline and an aborted protected run', async () => {
    const approval = fixture.approval as ApprovalRequestRecord;
    approval.status = 'expired';
    approval.decidedByType = undefined;
    approval.expiresAt = new Date(Date.now() + 60000).toISOString();
    (fixture.journal as PipelineRunJournalState).finished = { status: 'aborted' };
    await expect(finalizeDeniedSuspendedPipelineWorkItem(request)).rejects.toThrow(
      'human approval'
    );
    approval.expiresAt = new Date(Date.now() - 60000).toISOString();
    expect(
      (await finalizeDeniedSuspendedPipelineWorkItem(request)).effect_ownership?.settlement
    ).toBe('execution_aborted');
  });
});
