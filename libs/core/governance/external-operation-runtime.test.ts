import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../workforce/artifact-store.js', () => ({
  writeScopedArtifact: vi.fn(() => ({
    repo_relative_path: 'active/shared/artifacts/confidential/runtime-tenant/review.json',
  })),
}));
import type { ExternalOperationAuthority } from './external-operation.js';

vi.mock('../scope-context.js', () => ({
  resolveScopeContext: vi.fn(() => ({ tier: 'confidential', tenant_slug: 'runtime-tenant' })),
}));
vi.mock('../scope-envelope.js', () => ({
  currentScopeEnvelope: vi.fn(() => null),
  runtimeScopeIdentity: vi.fn(() => ({ tier: 'confidential', tenant_slug: 'runtime-tenant' })),
}));
vi.mock('./accountability-charter-registry.js', () => ({ findActiveCharter: vi.fn() }));
vi.mock('./approval-gate.js', () => ({ enforceApprovalGate: vi.fn() }));
vi.mock('./audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('./external-operation-store.js', () => ({ reserveExternalOperation: vi.fn() }));
vi.mock('../pipeline/op-preflight.js', async (original) => ({
  ...(await original<typeof import('../pipeline/op-preflight.js')>()),
  runOpPreflight: vi.fn(async ({ params }) => ({
    decision: 'allow',
    input: params,
    listener_ids: [],
    guard_ids: [],
  })),
}));
vi.mock('../pipeline/op-preflight-defaults.js', () => ({
  ensureDefaultOpPreflight: vi.fn(),
  assertBuiltinOnlyOpPreflight: vi.fn(),
}));
vi.mock('../../../scripts/pipeline-execution-part-bootstrap.js', async (original) => ({
  ...(await original<typeof import('../../../scripts/pipeline-execution-part-bootstrap.js')>()),
  loadActuatorDispatch: vi.fn(),
  assertPipelineStepCapabilityAvailable: vi.fn(),
  validatePipelineOpInput: vi.fn(),
}));

import { currentScopeEnvelope } from '../scope-envelope.js';
import { writeScopedArtifact } from '../workforce/artifact-store.js';
import { findActiveCharter } from './accountability-charter-registry.js';
import { enforceApprovalGate } from './approval-gate.js';
import { externalApprovalFixture } from '../../../tests/helpers/external-approval-fixture.js';
vi.mock('./approval-store.js', async (original) => ({
  ...(await original<typeof import('./approval-store.js')>()),
  evaluateApprovalUsability: () => null,
  loadApprovalRequest: (_channel: string, id: string) => {
    const params = vi.mocked(enforceApprovalGate).mock.calls.at(-1)?.[0];
    return params ? externalApprovalFixture(params, id) : null;
  },
}));
import {
  withExternalOperationAuthority,
  withExplicitExternalApprovalRequest,
  admitExternalOperation,
  runExternalOperation,
  assertExternalOperationBatchResumable,
  assertExternalOperationReplayIdentity,
} from './external-operation.js';
import {
  createRuntimeExternalOperationAuthority,
  externalOperationReplayKey,
  withRuntimeExternalOperationAuthority,
} from './external-operation-runtime.js';
import { loadActuatorDispatch } from '../../../scripts/pipeline-execution-part-bootstrap.js';
import { dispatchLeafOp } from '../../../scripts/pipeline-execution-part-control.js';
import { PipelineSuspendedError } from '../../../scripts/pipeline-execution-part-bootstrap.js';
import { runWithRepair } from '../../../scripts/pipeline-step-repair.js';

const facts = {
  operationId: 'meeting:chat',
  effect: { text: 'hello' },
  requiresApproval: true,
  delegable: true,
};

describe('trusted external authority at production pipeline dispatch', () => {
  it('marks production runs as outer checkpoints and refuses uncheckpointed inner effects', () => {
    expect(() =>
      withRuntimeExternalOperationAuthority({ runId: 'run', stepId: 'send' }, () =>
        assertExternalOperationBatchResumable(2)
      )
    ).toThrow('EXTERNAL_BATCH_CHECKPOINT_REQUIRED');
    expect(() =>
      withRuntimeExternalOperationAuthority({ stepId: 'direct' }, () =>
        assertExternalOperationBatchResumable(2)
      )
    ).not.toThrow();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(currentScopeEnvelope).mockReturnValue(undefined);
    vi.mocked(findActiveCharter).mockReturnValue(null);
    vi.mocked(enforceApprovalGate).mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: '00000000-0000-4000-8000-000000000001',
    });
  });

  it('requires replay-stable identity only at a trusted resumable run boundary', () => {
    expect(() =>
      withRuntimeExternalOperationAuthority({ runId: 'run', stepId: 'voice' }, () =>
        assertExternalOperationReplayIdentity(false, 'Supply a stable voice request_id')
      )
    ).toThrow('EXTERNAL_REPLAY_IDENTITY_REQUIRED');
    expect(() =>
      withRuntimeExternalOperationAuthority({ stepId: 'direct' }, () =>
        assertExternalOperationReplayIdentity(false, 'Supply a stable voice request_id')
      )
    ).not.toThrow();
  });

  it('provides stable run-and-step artifact identity without reading caller params', () => {
    const key = (runId: string, stepId: string) =>
      withRuntimeExternalOperationAuthority({ runId, stepId }, () =>
        externalOperationReplayKey('voice')
      );
    expect(key('run', 'step')).toBe(key('run', 'step'));
    expect(key('run', 'step')).not.toBe(key('run', 'other'));
    expect(key('run', 'step')).not.toBe(key('other', 'step'));
    expect(externalOperationReplayKey('voice')).toBeUndefined();
  });

  it('binds stable run/step/effect identity and varies foreach effects and fresh runs', () => {
    const one = createRuntimeExternalOperationAuthority({
      runId: 'run-1',
      stepId: 'send',
      hasHuman: false,
    });
    const two = createRuntimeExternalOperationAuthority({ runId: 'run-1', stepId: 'send' });
    expect(one(facts)?.invocationId).toBe(two(facts)?.invocationId);
    expect(one(facts)?.invocationId).toBe(
      one({ ...facts, effect: { text: 'other' } })?.invocationId
    );
    expect(one(facts)?.invocationId).not.toBe(
      one({ ...facts, effect: { params: { channel: 'other' } } })?.invocationId
    );
    expect(one(facts)?.invocationId).not.toBe(
      createRuntimeExternalOperationAuthority({ runId: 'run-1', stepId: 'other' })(facts)
        ?.invocationId
    );
    expect(
      createRuntimeExternalOperationAuthority({ stepId: 'send' })(facts)?.invocationId
    ).not.toBe(createRuntimeExternalOperationAuthority({ stepId: 'send' })(facts)?.invocationId);
  });

  it('uses envelope identity and gives only explicitly mapped operations conservative charter facts', () => {
    vi.mocked(currentScopeEnvelope).mockReturnValue({
      identity: { tenant_slug: 'envelope-tenant' },
    } as never);
    vi.mocked(findActiveCharter).mockReturnValue({ accountable: { actor: 'user:owner' } } as never);
    const resolver = createRuntimeExternalOperationAuthority({ runId: 'run', stepId: 'step' });
    const result = resolver(facts)!;
    expect(result.tenantSlug).toBe('envelope-tenant');
    expect(result.charter?.action).toMatchObject({
      decision_type: 'external_reply',
      information_flow: { recipient_class: 'unknown', categories: ['unknown'] },
    });
    expect(result.charter?.action.actor.on_behalf_of).toBe('user:owner');
    expect(
      resolver({ ...facts, operationId: 'service:other:preset:post_message' })?.charter
    ).toBeUndefined();
    expect(resolver({ ...facts, operationId: 'meeting:join' })?.charter).toBeUndefined();
  });

  it('preserves a trusted embedding resolver', () => {
    const authority: ExternalOperationAuthority = {
      agentId: 'embedding',
      tenantSlug: 'runtime-tenant',
      invocationId: 'bound',
    };
    withExternalOperationAuthority(
      () => authority,
      () =>
        withRuntimeExternalOperationAuthority({ stepId: 'fallback' }, () =>
          admitExternalOperation({ ...facts })
        )
    );
    expect(enforceApprovalGate).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'embedding', hasHuman: false })
    );
  });

  it('forwards trusted interactive presence to the concrete approval gate', () => {
    withRuntimeExternalOperationAuthority(
      { runId: 'interactive', stepId: 'send', hasHuman: true },
      () =>
        admitExternalOperation({
          ...facts,
          operationId: 'service:other:api:send',
          delegable: false,
        })
    );
    expect(enforceApprovalGate).toHaveBeenCalledWith(
      expect.objectContaining({
        hasHuman: true,
        requireApproval: true,
        payload: expect.objectContaining({ tenant_slug: 'runtime-tenant' }),
      })
    );
    expect(vi.mocked(enforceApprovalGate).mock.calls[0]![0].charter).toBeUndefined();
  });

  it('binds scoped inspectable review artifacts while redacting secrets', () => {
    const resolver = createRuntimeExternalOperationAuthority({
      runId: 'review-run',
      stepId: 'send',
      hasHuman: true,
    });
    const authority = resolver({
      ...facts,
      effect: {
        params: {
          channel: 'customer-channel',
          text: 'Proposed meeting minutes',
          api_key: 'secret-key',
          headers: { Authorization: 'Bearer secret-token' },
        },
      },
    });
    expect(writeScopedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { tenant: 'runtime-tenant' },
        tier: 'confidential',
        content: expect.objectContaining({
          effect: {
            params: {
              channel: 'customer-channel',
              text: 'Proposed meeting minutes',
              api_key: '[REDACTED_SECRET]',
              headers: { Authorization: '[REDACTED_SECRET]' },
            },
          },
        }),
      })
    );
    expect(authority?.review?.artifactRefs).toEqual([
      'active/shared/artifacts/confidential/runtime-tenant/review.json',
    ]);
    admitExternalOperation({ ...facts, authority });
    expect(enforceApprovalGate).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          artifact_refs: authority?.review?.artifactRefs,
        }),
      })
    );
  });

  it('defers review artifact writes to an explicit approval request host', () => {
    const resolver = createRuntimeExternalOperationAuthority({
      runId: 'review-run',
      stepId: 'send',
      hasHuman: true,
    });
    withExplicitExternalApprovalRequest(
      {
        operationId: facts.operationId,
        reviewArtifacts: () => [
          'active/shared/artifacts/confidential/runtime-tenant/host-review.json',
        ],
      },
      () => {
        const authority = resolver({ ...facts });
        expect(writeScopedArtifact).not.toHaveBeenCalled();
        expect(authority?.review?.artifactRefs).toEqual([]);
        admitExternalOperation({ ...facts });
      }
    );
    expect(enforceApprovalGate).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          artifact_refs: ['active/shared/artifacts/confidential/runtime-tenant/host-review.json'],
        }),
      })
    );
  });

  it('installs authority around the actual actuator dispatch without using context tenant or flags', async () => {
    vi.mocked(loadActuatorDispatch).mockResolvedValue(async (_op, _params, ctx) => {
      admitExternalOperation({ ...facts });
      return { handled: true, ctx };
    });
    await dispatchLeafOp(
      {
        id: 'send',
        op: 'meeting:chat',
        params: { text: 'hello', tenant_slug: 'forged', hasHuman: true },
      } as never,
      { tenant_slug: 'forged', externalAuthority: { tenantSlug: 'forged' }, hasHuman: true },
      '.',
      'zsh' as never,
      { runId: 'real-run', hasHuman: false },
      {} as never
    );
    expect(enforceApprovalGate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'pipeline-external-worker',
        hasHuman: false,
        payload: expect.objectContaining({ tenant_slug: 'runtime-tenant' }),
      })
    );
    expect(loadActuatorDispatch).toHaveBeenCalledTimes(1);
  });

  it('suspends an actual pending approval even when the actuator SDK absorbs the error', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({
      allowed: false,
      status: 'pending',
      requestId: 'approval-runtime',
      requestStatus: 'created',
    });
    vi.mocked(loadActuatorDispatch).mockResolvedValue(async (_op, _params, ctx) => {
      try {
        admitExternalOperation({ ...facts });
      } catch {
        /* SDK returns a failed result. */
      }
      return { handled: true, ctx: { ...ctx, status: 'failed' } };
    });
    const step = { id: 'send', op: 'meeting:chat', params: { text: 'hello' } } as never;
    const execution = () =>
      dispatchLeafOp(
        step,
        {},
        '.',
        'zsh' as never,
        { runId: 'real-run', hasHuman: true },
        {} as never
      );
    const error = await execution().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PipelineSuspendedError);
    expect((error as PipelineSuspendedError).suspension).toMatchObject({
      step_id: 'send',
      approval_request_id: 'approval-runtime',
      storage_channel: 'external-operation',
      approval_correlation_id: expect.stringMatching(/^external:[a-f0-9]{64}$/),
    });
    expect(enforceApprovalGate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'mission_gate',
        requestedByContext: expect.objectContaining({
          actorId: 'pipeline:real-run',
          pipelineRunId: 'real-run',
          stepId: 'send',
        }),
      })
    );
    const attempts = vi.fn(execution);
    await expect(
      runWithRepair(step, { runId: 'real-run' }, {} as never, attempts)
    ).rejects.toBeInstanceOf(PipelineSuspendedError);
    expect(attempts).toHaveBeenCalledTimes(1);
  });

  it.each(['receipt', 'exception'] as const)(
    'stops SDK-absorbed unverified %s without repair or another approval',
    async (kind) => {
      vi.mocked(loadActuatorDispatch).mockResolvedValue(async () => {
        try {
          await runExternalOperation(
            facts,
            async () => {
              if (kind === 'exception') throw new Error('response lost after send');
              return { partial: true };
            },
            () => 'unknown'
          );
        } catch {
          /* SDK failure envelope */
        }
        return { handled: true, ctx: { status: 'succeeded' } };
      });
      const step = { id: 'send', op: 'meeting:chat', params: {} } as never;
      const attempts = vi.fn(() =>
        dispatchLeafOp(
          step,
          {},
          '.',
          'zsh' as never,
          { runId: 'verify-run', hasHuman: true },
          {} as never
        )
      );
      await expect(runWithRepair(step, {}, {} as never, attempts)).rejects.toMatchObject({
        adfControlFlow: 'preflight',
        message: expect.stringContaining('EXTERNAL_RESULT_UNVERIFIED'),
      });
      expect(attempts).toHaveBeenCalledTimes(1);
      expect(enforceApprovalGate).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['human_required', 'rejected', 'expired', 'effect_mismatch'] as const)(
    'does not repair or re-prompt %s results',
    async (requestStatus) => {
      vi.mocked(enforceApprovalGate).mockReturnValue({
        allowed: false,
        status: 'pending',
        requestStatus,
        message: 'external admission blocked',
      });
      vi.mocked(loadActuatorDispatch).mockResolvedValue(async (_op, _params, ctx) => {
        try {
          admitExternalOperation({ ...facts });
        } catch {
          /* SDK failure envelope. */
        }
        return { handled: true, ctx: { ...ctx, status: 'failed' } };
      });
      const step = { id: 'send', op: 'meeting:chat', params: {} } as never;
      const attempts = vi.fn(() =>
        dispatchLeafOp(
          step,
          {},
          '.',
          'zsh' as never,
          { runId: 'real-run', hasHuman: false },
          {} as never
        )
      );
      await expect(runWithRepair(step, {}, {} as never, attempts)).rejects.toMatchObject({
        adfControlFlow: 'preflight',
      });
      expect(attempts).toHaveBeenCalledTimes(1);
    }
  );
});
