import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nowIso } from '@agent/core/foundation/time';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import type { DelegatedExecutionTarget } from '@agent/core/governance/delegated-execution';
import { requestHumanExecutionAuthorization } from './pipeline-execution-part-control.js';
import {
  PipelineSuspendedError,
  type RunStepsOptions,
} from './pipeline-execution-part-bootstrap.js';

const mocks = vi.hoisted(() => ({
  blocked: false,
  create: vi.fn(),
  load: vi.fn(),
  claim: vi.fn(),
  settle: vi.fn(),
  usable: vi.fn(),
}));
vi.mock('@agent/core/governance/delegated-execution', async (original) => ({
  ...(await original<typeof import('@agent/core/governance/delegated-execution')>()),
  delegatedExecutionBindingHash: (target: DelegatedExecutionTarget) => JSON.stringify(target),
  isDelegatedExecutionReplayBlocked: () => mocks.blocked,
}));
vi.mock('@agent/core/governance/approval-store', () => ({
  createApprovalRequest: mocks.create,
  loadApprovalRequest: mocks.load,
  claimApprovalApply: mocks.claim,
  recordApprovalApplyResult: mocks.settle,
  assertApprovalUsable: mocks.usable,
  computeApprovalPayloadHash: () => 'record-hash',
  isApprovalRequestExpired: () => false,
  validateHumanFinalDecision: vi.fn(),
}));
vi.mock('@agent/core/governance/human-execution', () => ({
  assertHumanExecutionNotPreviouslyClaimed: vi.fn(),
  claimHumanExecutionAuthorization: () => mocks.claim(),
  runHumanExecutionAuthorization: (
    _target: unknown,
    _reference: unknown,
    effect: () => Promise<unknown>
  ) => effect(),
}));

const target: DelegatedExecutionTarget = {
  operationId: 'service:preset:example:write',
  params: { amount: 50, token: 'hidden' },
  tenantSlug: 'acme',
  agentId: 'worker',
  source: { taskId: 'task-1' },
  stepId: 'write',
  correlationId: 'original',
};
const step = { id: 'write', op: 'service:preset', params: {} };
const opts: RunStepsOptions = { runId: 'run-original', delegatedExecution: 'require' };
function record(): ApprovalRequestRecord {
  return {
    id: 'approval-1',
    kind: 'mission_gate',
    channel: 'pipeline-execution-acme',
    storageChannel: 'pipeline-execution-acme',
    threadTs: 'write',
    correlationId: 'original',
    requestedBy: 'pipeline:run-original',
    requestedAt: nowIso(),
    title: 'Write',
    summary: 'Exact operation',
    severity: 'high',
    status: 'approved',
    decidedByType: 'human',
    scope: { tier: 'confidential', tenant_slug: 'acme', task_id: 'task-1', scope_kind: 'task' },
    accountability: {
      finalDecision: 'human_only',
      payloadHash: JSON.stringify(target),
      effectBinding: 'write',
    },
    requestedByContext: {
      surface: 'system',
      actorId: 'pipeline:run-original',
      actorRole: 'pipeline',
      pipelineRunId: opts.runId,
      stepId: 'write',
      targetStepId: 'write',
      executionBindingHash: JSON.stringify(target),
    },
  };
}
const selected = { channel: 'pipeline-execution-acme', requestId: 'approval-1' };

describe('exact human execution suspension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.blocked = false;
    mocks.create.mockReturnValue({ id: 'approval-1' });
    mocks.claim.mockReturnValue({ applyClaim: { claimId: 'claim-1' } });
  });

  it('publishes an actionable scoped request and suspends before the effect', async () => {
    const effect = vi.fn();
    await expect(
      requestHumanExecutionAuthorization(step, target, opts, effect)
    ).rejects.toBeInstanceOf(PipelineSuspendedError);
    expect(effect).not.toHaveBeenCalled();
    const request = mocks.create.mock.calls[0]![1];
    expect(request.scope.tenant_slug).toBe('acme');
    expect(request.requestedByContext.pipelineRunId).toBe('run-original');
    expect(request.accountability.finalDecision).toBe('human_only');
    expect(request.draft.details).not.toContain('hidden');
  });

  it('claims the human approval once before executing and records only a real success', async () => {
    mocks.load.mockReturnValue(record());
    const effect = vi.fn(async () => 'done');
    await expect(
      requestHumanExecutionAuthorization(step, target, opts, effect, selected)
    ).resolves.toBe('done');
    expect(mocks.claim).toHaveBeenCalledOnce();
    expect(mocks.settle).toHaveBeenCalledOnce();
    expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(
      effect.mock.invocationCallOrder[0]!
    );
  });

  it('keeps a failed effect claimed rather than declaring nonexecution', async () => {
    mocks.load.mockReturnValue(record());
    await expect(
      requestHumanExecutionAuthorization(
        step,
        target,
        opts,
        async () => {
          throw new Error('unknown');
        },
        selected
      )
    ).rejects.toThrow('unknown');
    expect(mocks.claim).toHaveBeenCalledOnce();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it.each(['payload', 'tenant', 'run', 'actor'])(
    'rejects changed %s bindings before claim',
    async (change) => {
      const approved = record();
      if (change === 'payload') approved.requestedByContext!.executionBindingHash = 'other';
      if (change === 'tenant') approved.scope!.tenant_slug = 'other';
      if (change === 'run') approved.requestedByContext!.pipelineRunId = 'other';
      if (change === 'actor') approved.decidedByType = 'ai_agent';
      mocks.load.mockReturnValue(approved);
      const effect = vi.fn();
      await expect(
        requestHumanExecutionAuthorization(step, target, opts, effect, selected)
      ).rejects.toThrow();
      expect(mocks.claim).not.toHaveBeenCalled();
      expect(effect).not.toHaveBeenCalled();
    }
  );

  it('refuses a new approval for already claimed delegated work', async () => {
    mocks.blocked = true;
    await expect(requestHumanExecutionAuthorization(step, target, opts, vi.fn())).rejects.toThrow(
      'RECONCILIATION_REQUIRED'
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
