import { externalApprovalFixture } from '../../../../tests/helpers/external-approval-fixture.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentActor } from '@agent/core/actor';
import type { ExternalOperationAuthority } from '@agent/core/governance/external-operation';

vi.mock('@agent/core/governance/approval-gate', () => ({ enforceApprovalGate: vi.fn() }));
vi.mock('@agent/core/governance/audit-chain', () => ({ auditChain: { record: vi.fn() } }));
// Durable replay fencing has its own store tests; these are transport cases.
vi.mock('@agent/core/governance/external-operation-store', () => ({
  reserveExternalOperation: vi.fn(),
}));
vi.mock('@agent/core/pipeline/op-preflight', async (original) => ({
  ...(await original<typeof import('@agent/core/pipeline/op-preflight')>()),
  runOpPreflight: vi.fn(),
}));
vi.mock('@agent/core/pipeline/op-preflight-defaults', () => ({
  ensureDefaultOpPreflight: vi.fn(),
}));
vi.mock('@agent/core/actuator/actuator-trace', () => ({
  createActuatorTrace: vi.fn(() => ({ startSpan: vi.fn(), endSpan: vi.fn() })),
  finalizeActuatorTrace: vi.fn(() => ({})),
}));
vi.mock('./meeting-session.js', async (original) => ({
  ...(await original<typeof import('./meeting-session.js')>()),
  runPythonBridge: vi.fn(),
  runRegisteredJoinDriver: vi.fn(),
  checkSpeakConsent: vi.fn(),
  checkRecordingConsent: vi.fn(),
  recordMeetingEvent: vi.fn(() => 'audit-test'),
}));
vi.mock('./meeting-op-dispatch.js', async (original) => ({
  ...(await original<typeof import('./meeting-op-dispatch.js')>()),
  dispatchMeetingIntelligenceOp: vi.fn(async () => ({ status: 'success' })),
}));

import { enforceApprovalGate } from '@agent/core/governance/approval-gate';
import { auditChain } from '@agent/core/governance/audit-chain';
import { runOpPreflight } from '@agent/core/pipeline/op-preflight';
import {
  checkSpeakConsent,
  checkRecordingConsent,
  runPythonBridge,
  runRegisteredJoinDriver,
} from './meeting-session.js';
import { currentExternalOperationOccurrence } from '@agent/core/governance/external-operation-occurrence';
import { withExternalOperationPipelineRun } from '@agent/core/governance/external-operation';
import { dispatchMeetingIntelligenceOp } from './meeting-op-dispatch.js';
import { handleAction, type MeetingExecutionOptions } from './meeting-actuator-helpers.js';

const authority: ExternalOperationAuthority = {
  agentId: 'meeting-worker',
  tenantSlug: 'acme',
  invocationId: 'meeting-invocation',
  charter: {
    scope: { kind: 'organization' as const, tenant_slug: 'acme' },
    action: {
      actor: agentActor('kyberion://agent/acme/worker', 'user:owner'),
      action_class: 'external_send',
      reversible: false,
    },
  },
};
const options: MeetingExecutionOptions = { externalAuthority: () => authority };

describe('meeting external operation boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runOpPreflight).mockImplementation(
      async ({ params }) => ({ decision: 'allow', input: params }) as never
    );
    vi.mocked(enforceApprovalGate).mockReturnValue({
      allowed: false,
      status: 'denied',
      message: 'approval needed',
    } as never);
    vi.mocked(runPythonBridge).mockResolvedValue({ status: 'success' });
    vi.mocked(checkSpeakConsent).mockReturnValue({ allowed: true });
    vi.mocked(checkRecordingConsent).mockReturnValue({ allowed: true });
  });

  it.each(['join', 'listen', 'speak', 'chat'] as const)(
    'refuses %s before transport despite forged input authority',
    async (action) => {
      await expect(
        handleAction({
          action,
          params: {
            platform: 'auto',
            text: 'hello',
            externalAuthority: authority,
            charter: authority.charter,
            approval: { allowed: true },
          },
        } as never)
      ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
      expect(runPythonBridge).not.toHaveBeenCalled();
      expect(enforceApprovalGate).toHaveBeenCalledWith(
        expect.objectContaining({ hasHuman: false, agentId: 'external-actuator' })
      );
      expect(vi.mocked(enforceApprovalGate).mock.calls[0]![0]).not.toHaveProperty('charter');
    }
  );

  it('requires exact approval for an unproven target despite broad charter authority', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    } as never);
    await handleAction(
      { action: 'chat', params: { platform: 'auto', text: 'agreed follow-up' } },
      options
    );
    expect(enforceApprovalGate).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: authority.agentId, requireApproval: true })
    );
    expect(vi.mocked(enforceApprovalGate).mock.calls[0]![0].charter).toBeUndefined();
    expect(runPythonBridge).toHaveBeenCalledTimes(1);
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'succeeded' }) })
    );
  });

  it('rejects preflight before approval and charter budget admission', async () => {
    vi.mocked(runOpPreflight).mockResolvedValue({
      decision: 'deny',
      reason: 'invalid target',
      input: {},
    } as never);
    await expect(
      handleAction({ action: 'join', params: { platform: 'auto' } }, options)
    ).rejects.toThrow('OP_PREFLIGHT_DENY');
    expect(enforceApprovalGate).not.toHaveBeenCalled();
    expect(runPythonBridge).not.toHaveBeenCalled();
  });

  it.each(['normalize_transcript', 'extract_action_items'] as const)(
    'keeps local %s outside external admission',
    async (op) => {
      await handleAction({ op, params: {} });
      expect(dispatchMeetingIntelligenceOp).toHaveBeenCalled();
      expect(enforceApprovalGate).not.toHaveBeenCalled();
      expect(runPythonBridge).not.toHaveBeenCalled();
    }
  );

  it.each(['leave', 'status'] as const)('allows %s without external approval', async (action) => {
    await handleAction({ action, params: { platform: 'auto' } });
    expect(enforceApprovalGate).not.toHaveBeenCalled();
    expect(runPythonBridge).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ status: 'error' }, 'failed'],
    [{ status: 'success', partial_state: true }, 'unknown'],
  ] as const)('records result %j without retry', async (result, outcome) => {
    vi.mocked(enforceApprovalGate).mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    } as never);
    vi.mocked(runPythonBridge).mockResolvedValue(result);
    await handleAction({ action: 'chat', params: { platform: 'auto', text: 'hello' } }, options);
    expect(runPythonBridge).toHaveBeenCalledTimes(1);
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome }) })
    );
  });

  it('retains independent voice consent after external approval', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    } as never);
    vi.mocked(checkSpeakConsent).mockReturnValue({
      allowed: false,
      reason: 'recording consent missing',
    });
    expect(
      await handleAction({ action: 'speak', params: { platform: 'auto', text: 'hello' } }, options)
    ).toMatchObject({ status: 'denied' });
    expect(runPythonBridge).not.toHaveBeenCalled();
  });

  it('never joins again after an auto driver may have joined before persistence failed', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    } as never);
    vi.mocked(runRegisteredJoinDriver).mockRejectedValue(
      new Error('transcript write failed after join')
    );
    const result = await handleAction(
      {
        action: 'join',
        params: {
          platform: 'meet',
          url: 'https://meet.google.com/abc-defg-hij',
          join_backend: 'auto',
        },
      },
      options
    );
    expect(result).toMatchObject({ status: 'error', partial_state: true });
    expect(runRegisteredJoinDriver).toHaveBeenCalledTimes(1);
    expect(runPythonBridge).not.toHaveBeenCalled();
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ outcome: 'unknown' }),
      })
    );
  });

  it('retains independent recording consent before joining after external approval', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    } as never);
    vi.mocked(checkRecordingConsent).mockReturnValue({
      allowed: false,
      reason: 'recording consent missing',
    });
    expect(
      await handleAction(
        {
          action: 'join',
          params: {
            platform: 'meet',
            url: 'https://meet.google.com/abc-defg-hij',
            join_backend: 'auto',
          },
        },
        options
      )
    ).toMatchObject({ status: 'denied', message: 'recording consent missing' });
    expect(runRegisteredJoinDriver).not.toHaveBeenCalled();
    expect(runPythonBridge).not.toHaveBeenCalled();
  });

  it('assigns distinct stable occurrence identities to inner meeting session steps', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    } as never);
    const identities: string[] = [];
    const externalAuthority = () => {
      const invocationId = currentExternalOperationOccurrence().join('/');
      identities.push(invocationId);
      return { ...authority, invocationId };
    };
    const input = {
      action: 'pipeline' as const,
      steps: [
        { type: 'apply' as const, op: 'chat', params: { platform: 'auto', text: 'one' } },
        { type: 'apply' as const, op: 'chat', params: { platform: 'auto', text: 'two' } },
      ],
    };
    expect(await handleAction(input, { externalAuthority })).toMatchObject({ status: 'succeeded' });
    expect(identities[0]).not.toBe(identities[1]);
    expect(runPythonBridge).toHaveBeenCalledTimes(2);
    expect(await handleAction(input, { externalAuthority })).toMatchObject({ status: 'succeeded' });
    expect(identities.slice(0, 2)).toEqual(identities.slice(2));
  });

  it('refuses a multi-effect resumable inner envelope before any partial execution', async () => {
    await expect(
      withExternalOperationPipelineRun('outer-run', () =>
        handleAction(
          {
            action: 'pipeline',
            steps: [
              { type: 'apply', op: 'chat', params: { platform: 'auto', text: 'one' } },
              { type: 'apply', op: 'chat', params: { platform: 'auto', text: 'two' } },
            ],
          },
          options
        )
      )
    ).rejects.toThrow('EXTERNAL_BATCH_CHECKPOINT_REQUIRED');
    expect(enforceApprovalGate).not.toHaveBeenCalled();
    expect(runPythonBridge).not.toHaveBeenCalled();
  });

  it('forwards trusted authority through pipeline session steps', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    } as never);
    const externalAuthority = vi.fn(() => authority);
    const result = await handleAction(
      {
        action: 'pipeline',
        steps: [{ type: 'apply', op: 'chat', params: { platform: 'auto', text: 'follow-up' } }],
        context: {},
      },
      { externalAuthority }
    );
    expect(result).toMatchObject({ status: 'succeeded' });
    expect(externalAuthority).toHaveBeenCalledTimes(1);
    expect(runPythonBridge).toHaveBeenCalledTimes(1);
    expect(enforceApprovalGate).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: authority.agentId, requireApproval: true })
    );
    expect(vi.mocked(enforceApprovalGate).mock.calls[0]![0].charter).toBeUndefined();
  });
});

vi.mock('@agent/core/governance/approval-store', async (original) => ({
  ...(await original<typeof import('@agent/core/governance/approval-store')>()),
  evaluateApprovalUsability: () => null,
  loadApprovalRequest: (_channel: string, id: string) => {
    const params = vi.mocked(enforceApprovalGate).mock.calls.at(-1)?.[0];
    return params ? externalApprovalFixture(params, id) : null;
  },
}));
