import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentActor } from '../actor.js';
import type { ApprovalGateCharterInput } from './approval-gate-charter.js';

vi.mock('./approval-policy.js', () => ({ resolveApprovalPolicy: vi.fn() }));
vi.mock('../decision-rights.js', () => ({
  resolveDecisionRightsMatrix: vi.fn(() => null),
  evaluateDecisionRights: vi.fn(() => null),
}));
vi.mock('./approval-gate-charter.js', () => ({
  runCharterGate: vi.fn(() => ({ kind: 'none' })),
  isCharterEligiblePolicy: vi.fn(() => true),
}));
vi.mock('./approval-store.js', async (original) => ({
  ...(await original<typeof import('./approval-store.js')>()),
  listApprovalRequests: vi.fn(() => []),
  createApprovalRequest: vi.fn(() => ({ id: 'apr-1' })),
  lookupSessionApprovalCache: vi.fn(() => null),
  recordSessionCacheAutoApproval: vi.fn(),
  evaluateApprovalUsability: vi.fn(() => null),
}));
vi.mock('./audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('./accountability-charter-registry.js', () => ({
  recordCharterExecutionOutcome: vi.fn(),
  recordCharterExecutionStarted: vi.fn(),
  findActiveCharter: vi.fn(() => null),
  loadCharterUsage: vi.fn(),
}));
vi.mock('./external-operation-store.js', () => ({ reserveExternalOperation: vi.fn() }));
vi.mock('../scope-envelope.js', () => ({ currentScopeEnvelope: vi.fn(() => undefined) }));
vi.mock('./governance-action-recorder.js', () => ({ recordGovernanceAction: vi.fn() }));
vi.mock('../surface/operator-notifications.js', () => ({ notifyOperator: vi.fn() }));

import { resolveApprovalPolicy } from './approval-policy.js';
import { runCharterGate } from './approval-gate-charter.js';
import {
  createApprovalRequest,
  listApprovalRequests,
  computeApprovalPayloadHash,
} from './approval-store.js';
import { auditChain } from './audit-chain.js';
import {
  recordCharterExecutionOutcome,
  recordCharterExecutionStarted,
  findActiveCharter,
  loadCharterUsage,
} from './accountability-charter-registry.js';
import { reserveExternalOperation } from './external-operation-store.js';
import type { Charter } from './accountability-charter.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import {
  admitExternalOperation,
  recordExternalOperationOutcome,
  ExternalOperationApprovalRequired,
  type ExternalOperation,
  withExternalOperationAuthority,
  runExternalOperation,
  runExternalOperationSync,
  withExternalOperationApprovalObserver,
} from './external-operation.js';

const charter: ApprovalGateCharterInput = {
  scope: { kind: 'organization', tenant_slug: 'acme' },
  action: {
    actor: agentActor('kyberion://agent/acme/worker', 'user:owner'),
    action_class: 'send_message_external',
    reversible: false,
  },
};
const operation = (overrides: Partial<ExternalOperation> = {}): ExternalOperation => ({
  operationId: 'service:preset:create_issue',
  requiresApproval: true,
  delegable: true,
  effect: { recipient: 'ops', body: 'sensitive-payload' },
  authority: {
    agentId: 'worker',
    tenantSlug: 'acme',
    invocationId: 'inv-1',
    hasHuman: false,
    charter,
  },
  ...overrides,
});

describe('external operation common admission', () => {
  it('protects synchronous transports before execution and preserves their receipt', () => {
    const execute = vi.fn(() => ({ status: 0 }));
    expect(() =>
      runExternalOperationSync(operation({ authority: undefined }), execute, () => 'succeeded')
    ).toThrow(ExternalOperationApprovalRequired);
    expect(execute).not.toHaveBeenCalled();
    vi.mocked(runCharterGate).mockReturnValue({ kind: 'allow', message: 'allow' });
    expect(runExternalOperationSync(operation(), execute, () => 'succeeded')).toEqual({
      status: 0,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ outcome: 'succeeded' }),
      })
    );
  });

  it('stops synchronous attempted effects and absorbed nonzero receipts at the outer observer', () => {
    vi.mocked(runCharterGate).mockReturnValue({ kind: 'allow', message: 'allow' });
    const observer = vi.fn();
    withExternalOperationApprovalObserver(observer, () => {
      expect(() =>
        runExternalOperationSync(
          operation(),
          () => {
            throw new Error('lost git response');
          },
          () => 'succeeded'
        )
      ).toThrow('EXTERNAL_RESULT_UNVERIFIED');
      expect(
        runExternalOperationSync(
          operation(),
          () => ({ status: 1 }),
          () => 'unknown'
        )
      ).toEqual({ status: 1 });
    });
    expect(observer).toHaveBeenCalledTimes(2);
    expect(observer.mock.calls[0]![0].approval.requestId).toBeUndefined();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveApprovalPolicy).mockReturnValue({
      requiresApproval: false,
      missingRequirements: [],
    });
    vi.mocked(runCharterGate).mockReturnValue({ kind: 'none' });
    vi.mocked(listApprovalRequests).mockReturnValue([]);
    vi.mocked(auditChain.record).mockImplementation(() => undefined as never);
    vi.mocked(currentScopeEnvelope).mockReturnValue(undefined);
    vi.mocked(reserveExternalOperation).mockReset();
    vi.mocked(findActiveCharter).mockReturnValue(null);
  });

  it('creates an exact mission gate binding for trusted pipeline resumption', () => {
    const input = operation();
    input.authority = {
      ...input.authority!,
      hasHuman: true,
      charter: undefined,
      pipelineContext: {
        surface: 'system',
        actorId: 'pipeline:run-1',
        actorRole: 'pipeline',
        pipelineRunId: 'run-1',
        stepId: 'send',
        missionId: 'MSN-1',
      },
    };
    expect(() => admitExternalOperation(input)).toThrow(ExternalOperationApprovalRequired);
    const request = vi.mocked(createApprovalRequest).mock.calls[0]![1];
    expect(request).toMatchObject({
      kind: 'mission_gate',
      requestedBy: 'pipeline:run-1',
      channel: 'external-operation',
      requestedByContext: input.authority.pipelineContext,
      correlationId: expect.stringMatching(/^external:[a-f0-9]{64}$/),
      accountability: { effectBinding: input.operationId, payloadHash: expect.any(String) },
    });
    expect(reserveExternalOperation).not.toHaveBeenCalled();
  });

  it('requires admission without a charter even when the base policy allows', () => {
    expect(() => admitExternalOperation(operation({ authority: undefined }))).toThrow(
      ExternalOperationApprovalRequired
    );
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(reserveExternalOperation).not.toHaveBeenCalled();
  });

  it('allows a charter decision and preserves its stop', () => {
    vi.mocked(runCharterGate).mockReturnValue({ kind: 'allow', message: 'within charter' });
    expect(admitExternalOperation(operation()).allowed).toBe(true);
    vi.mocked(runCharterGate).mockReturnValue({ kind: 'stop', message: 'tripwire stopped' });
    expect(() => admitExternalOperation(operation())).toThrow('tripwire stopped');
  });

  it('rejects tenant mismatch before invoking the gate', () => {
    const input = operation();
    input.authority = { ...input.authority!, tenantSlug: 'other' };
    expect(() => admitExternalOperation(input)).toThrow('EXTERNAL_SCOPE_MISMATCH');
    expect(runCharterGate).not.toHaveBeenCalled();
  });

  it('never offers an opaque human-only effect to a charter', () => {
    vi.mocked(runCharterGate).mockReturnValue({ kind: 'allow', message: 'within charter' });
    expect(() => admitExternalOperation(operation({ delegable: false }))).toThrow(
      ExternalOperationApprovalRequired
    );
    expect(runCharterGate).not.toHaveBeenCalled();
  });

  it('preserves a tenant charter stop for human-only opaque operations', () => {
    vi.mocked(findActiveCharter).mockReturnValue({
      charter_id: 'chr-stop',
      appetite: { tripwires: ['external_operation_failure'] },
    } as Charter);
    vi.mocked(loadCharterUsage).mockReturnValue({
      spent_today: 0,
      spent_this_month: 0,
      tripwires_hit: ['external_operation_failure'],
    });
    const input = operation({ delegable: false });
    input.authority = { ...input.authority!, hasHuman: true, charter: undefined };
    expect(() => admitExternalOperation(input)).toThrow('CHARTER_STOP');
    expect(runCharterGate).not.toHaveBeenCalled();
    expect(listApprovalRequests).not.toHaveBeenCalled();
    expect(reserveExternalOperation).not.toHaveBeenCalled();
  });

  it('binds approval to payload without persisting raw contents', () => {
    const input = operation();
    input.authority = { ...input.authority!, hasHuman: true, charter: undefined };
    expect(() => admitExternalOperation(input)).toThrow(ExternalOperationApprovalRequired);
    const draft = vi.mocked(createApprovalRequest).mock.calls[0]![1];
    expect(JSON.stringify(draft)).not.toContain('sensitive-payload');
    expect(draft.accountability?.effectBinding).toBe(input.operationId);
    const originalCorrelation = draft.correlationId;
    vi.mocked(listApprovalRequests).mockReturnValue([
      {
        ...draft,
        id: 'apr-1',
        status: 'approved',
        requestedAt: new Date().toISOString(),
        channel: 'external-operation',
      } as never,
    ]);
    expect(admitExternalOperation(input).allowed).toBe(true);
    expect(() => admitExternalOperation({ ...input, effect: { body: 'edited' } })).toThrow(
      ExternalOperationApprovalRequired
    );
    expect(draft.correlationId).toBe(originalCorrelation);
    expect(draft.accountability?.payloadHash).toBe(
      computeApprovalPayloadHash({
        effect_hash: computeApprovalPayloadHash(input.effect),
        tenant_slug: 'acme',
        rationale: 'Review external operation service:preset:create_issue for tenant acme',
      })
    );
  });

  it('uses a new approval identity for a new invocation', () => {
    const input = operation();
    input.authority = { ...input.authority!, hasHuman: true, charter: undefined };
    expect(() => admitExternalOperation(input)).toThrow();
    const first = vi.mocked(createApprovalRequest).mock.calls[0]![1].correlationId;
    expect(() =>
      admitExternalOperation({ ...input, authority: { ...input.authority, invocationId: 'inv-2' } })
    ).toThrow();
    expect(vi.mocked(createApprovalRequest).mock.calls[1]![1].correlationId).not.toBe(first);
  });

  it('never reuses approvals for an absent or blank invocation identity', () => {
    for (const invocationId of ['', '   ', undefined]) {
      const input = operation();
      input.authority = {
        ...input.authority!,
        hasHuman: true,
        charter: undefined,
        invocationId: invocationId as string,
      };
      expect(() => admitExternalOperation(input)).toThrow('EXTERNAL_IDENTITY_REQUIRED');
    }
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(() => admitExternalOperation(operation({ authority: undefined }))).toThrow();
    const first = vi.mocked(auditChain.record).mock.calls.at(-1)![0];
    expect(() => admitExternalOperation(operation({ authority: undefined }))).toThrow();
    const second = vi.mocked(auditChain.record).mock.calls.at(-1)![0];
    expect(second.metadata?.correlationId).not.toBe(first.metadata?.correlationId);
  });

  it('presents trusted review context and scoped references without the raw effect', () => {
    const input = operation();
    input.authority = {
      ...input.authority!,
      hasHuman: true,
      charter: undefined,
      review: {
        summary: 'Create the agreed follow-up issue in acme operations',
        artifactRefs: ['active/missions/acme/evidence/review.md'],
      },
    };
    expect(() => admitExternalOperation(input)).toThrow();
    const request = vi.mocked(createApprovalRequest).mock.calls[0]![1];
    expect(request.draft.details).toContain(input.authority.review!.summary);
    expect(JSON.stringify(request.draft)).toContain('active/missions/acme/evidence/review.md');
    expect(JSON.stringify(request)).not.toContain('sensitive-payload');
  });

  it('records only hashed evidence and does not throw after telemetry failure', () => {
    const input = operation({ requiresApproval: false });
    admitExternalOperation(input);
    recordExternalOperationOutcome(input, 'unknown');
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          outcome: 'unknown',
          effect_hash: computeApprovalPayloadHash(operation().effect),
        }),
      })
    );
    expect(JSON.stringify(vi.mocked(auditChain.record).mock.calls)).not.toContain(
      'sensitive-payload'
    );
    admitExternalOperation(input);
    vi.mocked(auditChain.record).mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    expect(() => recordExternalOperationOutcome(input, 'succeeded')).not.toThrow();
  });

  it('records charter feedback only from an actual accepted admission, once', () => {
    const accepted = { charter_id: 'chr-acme-proof', scope: charter.scope } as Charter;
    const input = operation();
    recordExternalOperationOutcome(input, 'failed');
    expect(recordCharterExecutionOutcome).not.toHaveBeenCalled();
    vi.mocked(runCharterGate).mockReturnValue({
      kind: 'allow',
      message: 'allowed',
      acceptedCharter: accepted,
    });
    admitExternalOperation(input);
    input.effect.body = 'mutated after admission';
    recordExternalOperationOutcome(input, 'unknown');
    expect(recordCharterExecutionOutcome).toHaveBeenCalledWith(
      accepted,
      expect.objectContaining({
        outcome: 'unknown',
        operation_id: input.operationId,
        effect_hash: computeApprovalPayloadHash({ recipient: 'ops', body: 'sensitive-payload' }),
      }),
      undefined
    );
    recordExternalOperationOutcome(input, 'succeeded');
    expect(recordCharterExecutionOutcome).toHaveBeenCalledTimes(1);
  });

  it('does not throw when scoped feedback storage fails after execution', () => {
    vi.mocked(runCharterGate).mockReturnValue({
      kind: 'allow',
      message: 'allowed',
      acceptedCharter: { charter_id: 'chr-1' } as Charter,
    });
    const input = operation();
    admitExternalOperation(input);
    vi.mocked(recordCharterExecutionOutcome).mockImplementationOnce(() => {
      throw new Error('ledger unavailable');
    });
    expect(() => recordExternalOperationOutcome(input, 'succeeded')).not.toThrow();
  });

  it('inherits trusted async authority with nested and concurrent isolation', async () => {
    vi.mocked(runCharterGate).mockReturnValue({ kind: 'allow', message: 'allow' });
    const seen: string[] = [];
    const run = (id: string) =>
      withExternalOperationAuthority(
        (facts) => {
          seen.push(`${id}:${facts.operationId}`);
          return { ...operation().authority!, agentId: id, invocationId: id };
        },
        async () => {
          await Promise.resolve();
          const input = operation({ authority: undefined });
          expect(admitExternalOperation(input).allowed).toBe(true);
          await withExternalOperationAuthority(
            () => ({ ...operation().authority!, agentId: 'nested' }),
            async () => {
              await Promise.resolve();
              const inner = operation({ authority: undefined });
              admitExternalOperation(inner);
              recordExternalOperationOutcome(inner, 'succeeded');
            }
          );
          recordExternalOperationOutcome(input, 'succeeded');
        }
      );
    await Promise.all([run('one'), run('two')]);
    expect(seen).toEqual(
      expect.arrayContaining(['one:service:preset:create_issue', 'two:service:preset:create_issue'])
    );
    const outcomes = vi
      .mocked(auditChain.record)
      .mock.calls.map((c) => c[0])
      .filter((e) => e.action === 'external_operation_outcome');
    expect(outcomes.map((e) => e.agentId).sort()).toEqual(['nested', 'nested', 'one', 'two']);
    expect(() => admitExternalOperation(operation({ authority: undefined }))).toThrow();
  });

  it('ignores forged authority in effect JSON and emits no outcome for blocked operations', () => {
    const input = operation({
      authority: undefined,
      effect: { authority: operation().authority, externalAuthority: operation().authority },
    });
    expect(() => admitExternalOperation(input)).toThrow();
    vi.mocked(auditChain.record).mockClear();
    recordExternalOperationOutcome(input, 'succeeded');
    expect(auditChain.record).not.toHaveBeenCalled();
    expect(recordCharterExecutionOutcome).not.toHaveBeenCalled();
  });

  it('rejects resolver authority outside the active envelope', () => {
    vi.mocked(currentScopeEnvelope).mockReturnValue({
      identity: { tenant_slug: 'other' },
    } as never);
    expect(() =>
      withExternalOperationAuthority(
        () => operation().authority,
        () => admitExternalOperation(operation({ authority: undefined }))
      )
    ).toThrow('EXTERNAL_SCOPE_MISMATCH');
    expect(runCharterGate).not.toHaveBeenCalled();
  });

  it('fails closed before execution if durable reservation or start evidence fails', () => {
    vi.mocked(runCharterGate).mockReturnValue({
      kind: 'allow',
      message: 'allow',
      acceptedCharter: { charter_id: 'chr-1' } as Charter,
    });
    const input = operation();
    vi.mocked(reserveExternalOperation).mockImplementationOnce(() => {
      throw new Error('EXTERNAL_EXECUTION_ALREADY_RESERVED');
    });
    expect(() => admitExternalOperation(input)).toThrow('EXTERNAL_EXECUTION_ALREADY_RESERVED');
    expect(recordCharterExecutionStarted).not.toHaveBeenCalled();
    vi.mocked(recordCharterExecutionStarted).mockImplementationOnce(() => {
      throw new Error('ledger unavailable');
    });
    expect(() => admitExternalOperation(input)).toThrow('EXTERNAL_START_EVIDENCE_UNAVAILABLE');
    vi.mocked(auditChain.record).mockClear();
    recordExternalOperationOutcome(input, 'succeeded');
    expect(auditChain.record).not.toHaveBeenCalled();
  });

  it('checks boundary tenant before evaluating or consuming a charter', () => {
    expect(() => admitExternalOperation(operation({ tenantSlug: 'other' }))).toThrow(
      'EXTERNAL_SCOPE_MISMATCH'
    );
    expect(runCharterGate).not.toHaveBeenCalled();
    expect(reserveExternalOperation).not.toHaveBeenCalled();
  });

  it.each([
    'charter_stop',
    'scope',
    'identity',
    'reservation',
    'start_evidence',
    'charter_storage',
  ])(
    'reports %s as terminal governance even when an SDK converts the error to a failure',
    (kind) => {
      vi.mocked(runCharterGate).mockReturnValue({
        kind: 'allow',
        message: 'allow',
        acceptedCharter: { charter_id: 'chr-1' } as Charter,
      });
      const input = operation();
      if (kind === 'charter_stop') {
        vi.mocked(findActiveCharter).mockReturnValue({
          appetite: { tripwires: ['stopped'] },
        } as Charter);
        vi.mocked(loadCharterUsage).mockReturnValue({
          spent_today: 0,
          spent_this_month: 0,
          tripwires_hit: ['stopped'],
        });
      }
      if (kind === 'scope') input.tenantSlug = 'other';
      if (kind === 'identity') input.authority = { ...input.authority!, invocationId: '' };
      if (kind === 'reservation')
        vi.mocked(reserveExternalOperation).mockImplementationOnce(() => {
          throw new Error('EXTERNAL_EXECUTION_ALREADY_RESERVED');
        });
      if (kind === 'start_evidence')
        vi.mocked(recordCharterExecutionStarted).mockImplementationOnce(() => {
          throw new Error('storage');
        });
      if (kind === 'charter_storage')
        vi.mocked(findActiveCharter).mockImplementationOnce(() => {
          throw new Error('storage');
        });
      const observer = vi.fn();
      const converted = withExternalOperationApprovalObserver(observer, () => {
        try {
          admitExternalOperation(input);
          return { status: 'success' };
        } catch (error) {
          expect(error).toMatchObject({ adfControlFlow: 'preflight' });
          return { status: 'failure', error: String(error) };
        }
      });
      expect(converted.status).toBe('failure');
      expect(observer).toHaveBeenCalledWith(
        expect.objectContaining({
          approval: expect.objectContaining({
            allowed: false,
            status: 'pending',
            message: expect.any(String),
          }),
          channel: 'external-operation',
          correlationId: expect.stringContaining('external:'),
        })
      );
      expect(observer.mock.calls[0]![0].approval.requestId).toBeUndefined();
      expect(recordCharterExecutionOutcome).not.toHaveBeenCalled();
    }
  );

  it('stops repair of attempted mutations even when an SDK absorbs the error', async () => {
    vi.mocked(runCharterGate).mockReturnValue({ kind: 'allow', message: 'allow' });
    const observer = vi.fn();
    const transport = vi.fn(async () => {
      throw new Error('connection lost');
    });
    await withExternalOperationApprovalObserver(observer, async () => {
      await expect(
        runExternalOperation(operation(), transport, () => 'succeeded')
      ).rejects.toMatchObject({
        adfControlFlow: 'preflight',
        message: expect.stringContaining('EXTERNAL_RESULT_UNVERIFIED'),
      });
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        approval: expect.objectContaining({
          allowed: false,
          message: expect.stringContaining('EXTERNAL_RESULT_UNVERIFIED'),
        }),
      })
    );
    expect(observer.mock.calls[0]![0].approval.requestId).toBeUndefined();
  });

  it.each(['failed', 'unknown'] as const)(
    'propagates %s mutation receipts to the outer verification stop',
    async (outcome) => {
      vi.mocked(runCharterGate).mockReturnValue({ kind: 'allow', message: 'allow' });
      const observer = vi.fn();
      const result = await withExternalOperationApprovalObserver(observer, () =>
        runExternalOperation(
          operation(),
          async () => ({ partial: true }),
          () => outcome
        )
      );
      expect(result).toEqual({ partial: true });
      expect(observer).toHaveBeenCalledTimes(1);
      expect(observer.mock.calls[0]![0].approval.requestId).toBeUndefined();
    }
  );

  it('allows read errors to remain repairable without an external mutation stop', async () => {
    const observer = vi.fn();
    const failure = new Error('read failed');
    await withExternalOperationApprovalObserver(observer, () =>
      expect(
        runExternalOperation(
          operation({ requiresApproval: false }),
          async () => {
            throw failure;
          },
          () => 'unknown'
        )
      ).rejects.toBe(failure)
    );
    expect(observer).not.toHaveBeenCalled();
  });

  it('allows only one delayed execution for an invocation including after unknown outcome', async () => {
    vi.mocked(runCharterGate).mockReturnValue({ kind: 'allow', message: 'allow' });
    const reservations = new Set<string>();
    vi.mocked(reserveExternalOperation).mockImplementation((input) => {
      const key = `${input.tenantSlug}:${input.operationId}:${input.invocationId}`;
      if (reservations.has(key)) throw new Error('EXTERNAL_EXECUTION_ALREADY_RESERVED');
      reservations.add(key);
    });
    let release!: (value: string) => void;
    const effect = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        })
    );
    const first = runExternalOperation(operation(), effect, () => 'unknown');
    await expect(runExternalOperation(operation(), effect, () => 'succeeded')).rejects.toThrow(
      'EXTERNAL_EXECUTION_ALREADY_RESERVED'
    );
    expect(effect).toHaveBeenCalledTimes(1);
    release('ambiguous');
    await first;
    await expect(runExternalOperation(operation(), effect, () => 'succeeded')).rejects.toThrow(
      'EXTERNAL_EXECUTION_ALREADY_RESERVED'
    );
    expect(effect).toHaveBeenCalledTimes(1);
  });
});
