import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_CHANGE_INSTRUCTION_MAX,
  VITEST_APPROVAL_STORE_ROOT,
  approvalActionCacheKey,
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  approvalStoreRoots,
  computeApprovalPayloadHash,
  claimApprovalApply,
  recordApprovalApplyResult,
  createApprovalRequest,
  cancelApprovalRequest,
  loadApprovalRequest,
  decideApprovalRequest,
  expireApprovalRequest,
  listApprovalRequests,
  resolveApprovalAssuranceMode,
  validateHumanFinalDecision,
} from './approval-store.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from '../secure-io.js';
import { withExecutionContext } from '../authority.js';

describe('approval-store test isolation', () => {
  const channel = `isolation-probe-${process.pid}`;

  afterEach(() => {
    withExecutionContext('mission_controller', () => {
      for (const root of Object.values(approvalStoreRoots())) {
        const dir = pathResolver.rootResolve(`${root}/${channel}`);
        if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('keeps the live store layout outside vitest', () => {
    expect(approvalStoreRoots({})).toEqual({
      coordination: 'active/shared/coordination/channels',
      observability: 'active/shared/observability/channels',
    });
  });

  it('routes every approval path under the isolated root during vitest', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(approvalStoreRoots({ VITEST: 'true' }).coordination).toBe(
      `${VITEST_APPROVAL_STORE_ROOT}/coordination/channels`
    );
    expect(approvalStoreRoots({ VITEST: 'true', VITEST_POOL_ID: '3' }).coordination).toBe(
      `${VITEST_APPROVAL_STORE_ROOT}/pool-3/coordination/channels`
    );
    expect(
      approvalStoreRoots({ VITEST: 'true', VITEST_POOL_ID: '3', KYBERION_VITEST_RUN_ID: 'r/../9' })
        .coordination
    ).toBe(`${VITEST_APPROVAL_STORE_ROOT}/run-r9/pool-3/coordination/channels`);
    const roots = approvalStoreRoots();
    expect(roots.coordination.startsWith(`${VITEST_APPROVAL_STORE_ROOT}/`)).toBe(true);
    expect(approvalRequestLogicalPath('terminal', id)).toBe(
      `${roots.coordination}/terminal/approvals/requests/${id}.json`
    );
    expect(approvalEventLogicalPath('terminal')).toBe(
      `${roots.observability}/terminal/approvals.jsonl`
    );
  });

  it('never writes test approvals into the live approval store', () => {
    const record = createApprovalRequest('mission_controller', {
      channel,
      threadTs: '1',
      correlationId: 'isolation-probe',
      requestedBy: 'approval-store-test',
      draft: { title: 'isolation probe', summary: 'written by approval-store.test.ts' },
    });

    expect(
      safeExistsSync(pathResolver.rootResolve(approvalRequestLogicalPath(channel, record.id)))
    ).toBe(true);
    expect(safeExistsSync(pathResolver.rootResolve(approvalEventLogicalPath(channel)))).toBe(true);
    expect(
      safeExistsSync(
        pathResolver.rootResolve(
          `active/shared/coordination/channels/${channel}/approvals/requests/${record.id}.json`
        )
      )
    ).toBe(false);
    expect(
      safeExistsSync(
        pathResolver.rootResolve(`active/shared/observability/channels/${channel}/approvals.jsonl`)
      )
    ).toBe(false);
    expect(listApprovalRequests({ storageChannels: [channel] }).map((r) => r.id)).toEqual([
      record.id,
    ]);
  });

  it.each(['rejected', 'cancelled', 'expired'] as const)(
    'CAS preserves a concurrent %s transition',
    (transition) => {
      const record = createApprovalRequest('mission_controller', {
        channel,
        threadTs: '1',
        correlationId: 'cas-probe',
        requestedBy: 'test',
        draft: { title: 'CAS', summary: 'Fixture only' },
      });
      const expectedRecordHash = computeApprovalPayloadHash({ record });
      if (transition === 'rejected')
        decideApprovalRequest('mission_controller', {
          channel,
          requestId: record.id,
          decision: 'rejected',
          decidedBy: 'user:owner',
        });
      else if (transition === 'cancelled')
        cancelApprovalRequest('mission_controller', { channel, requestId: record.id });
      else expireApprovalRequest('mission_controller', { channel, requestId: record.id });
      expect(() =>
        decideApprovalRequest('mission_controller', {
          channel,
          requestId: record.id,
          decision: 'approved',
          decidedBy: 'user:owner',
          expectedRecordHash,
        })
      ).toThrow('changed since review');
      expect(loadApprovalRequest(channel, record.id)?.status).toBe(transition);
    }
  );
  it('commits an unchanged CAS snapshot and never overwrites it with later cancellation/expiry', () => {
    const record = createApprovalRequest('mission_controller', {
      channel,
      threadTs: '1',
      correlationId: 'cas-commit',
      requestedBy: 'test',
      draft: { title: 'CAS', summary: 'Fixture only' },
    });
    decideApprovalRequest('mission_controller', {
      channel,
      requestId: record.id,
      decision: 'approved',
      decidedBy: 'user:owner',
      expectedRecordHash: computeApprovalPayloadHash({ record }),
    });
    expect(
      cancelApprovalRequest('mission_controller', { channel, requestId: record.id }).status
    ).toBe('approved');
    expect(
      expireApprovalRequest('mission_controller', { channel, requestId: record.id }).status
    ).toBe('approved');
  });

  it('refuses to decide a request that was expired without an expiresAt', () => {
    const record = createApprovalRequest('mission_controller', {
      channel,
      threadTs: '1',
      correlationId: 'stale-probe',
      requestedBy: 'approval-store-test',
      draft: { title: 'stale probe', summary: 'swept as stale_pending' },
    });
    expireApprovalRequest('infrastructure_sentinel', {
      channel,
      requestId: record.id,
      reason: 'stale_pending',
    });

    expect(() =>
      decideApprovalRequest('mission_controller', {
        channel,
        requestId: record.id,
        decision: 'approved',
        decidedBy: 'operator',
        decidedByType: 'human',
        authenticated: true,
      })
    ).toThrow('has expired');
  });
});

describe('approval-store decision card and change requests', () => {
  const channel = `decision-card-probe-${process.pid}`;
  const card = {
    question: 'Ship it?',
    recommendation: 'Approve.',
    riskTier: 'approve' as const,
    riskReasons: ['touches billing'],
    reversible: false,
    evidence: [{ label: 'PR', ref: 'https://example.com/pr/1' }],
  };

  afterEach(() => {
    withExecutionContext('mission_controller', () => {
      for (const root of Object.values(approvalStoreRoots())) {
        const dir = pathResolver.rootResolve(`${root}/${channel}`);
        if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
      }
    });
  });

  function create(decisionCard?: typeof card) {
    return createApprovalRequest('mission_controller', {
      channel,
      threadTs: '1',
      correlationId: 'decision-card-probe',
      requestedBy: 'approval-store-test',
      draft: { title: 'card probe', summary: 'written by approval-store.test.ts' },
      ...(decisionCard ? { decisionCard } : {}),
    });
  }

  it('stores a valid card and refuses a malformed one', () => {
    expect(create(card).decisionCard).toEqual(card);
    expect(() => create({ ...card, evidence: [{ label: 'x', ref: '../outside.json' }] })).toThrow(
      /evidence/u
    );
  });

  it('records a change instruction only on a rejection', () => {
    const record = create(card);
    expect(() =>
      decideApprovalRequest('mission_controller', {
        channel,
        requestId: record.id,
        decision: 'approved',
        decidedBy: 'operator',
        changeInstruction: 'shorten it',
      })
    ).toThrow();
    expect(() =>
      decideApprovalRequest('mission_controller', {
        channel,
        requestId: record.id,
        decision: 'rejected',
        decidedBy: 'operator',
        changeInstruction: 'x'.repeat(APPROVAL_CHANGE_INSTRUCTION_MAX + 1),
      })
    ).toThrow();

    const decided = decideApprovalRequest('mission_controller', {
      channel,
      requestId: record.id,
      decision: 'rejected',
      decidedBy: 'operator',
      changeInstruction: '  shorten the summary  ',
    });
    expect(decided.status).toBe('rejected');
    expect(decided.changeRequest).toMatchObject({
      instruction: 'shorten the summary',
      requestedBy: 'operator',
    });
  });
});

describe('approval-store path normalization', () => {
  it('rejects invalid approval channels', () => {
    expect(() =>
      approvalRequestLogicalPath('../secret', '123e4567-e89b-12d3-a456-426614174000')
    ).toThrow('Invalid approval channel');
    expect(() => approvalEventLogicalPath('terminal/../slack')).toThrow('Invalid approval channel');
  });

  it('rejects invalid approval request ids', () => {
    expect(() => approvalRequestLogicalPath('terminal', '../escape')).toThrow(
      'Invalid approval request id'
    );
  });

  it('binds human final approval to an authenticated decider and exact effect', () => {
    const payloadHash = computeApprovalPayloadHash({ amount: 100, target: 'vendor-a' });
    const accountability = {
      finalDecision: 'human_only' as const,
      payloadHash,
      effectBinding: 'payment:create',
    };

    expect(() => validateHumanFinalDecision({ accountability })).toThrow('human decider');
    expect(() =>
      validateHumanFinalDecision({ accountability, decidedByType: 'ai_agent', authenticated: true })
    ).toThrow('human decider');
    expect(() =>
      validateHumanFinalDecision({
        accountability,
        decidedByType: 'human',
        authenticated: true,
        authMethod: 'surface_session',
        payloadHash: 'changed',
        effectBinding: 'payment:create',
      })
    ).toThrow('payload hash');
    expect(() =>
      validateHumanFinalDecision({
        accountability,
        decidedByType: 'human',
        authenticated: true,
        authMethod: 'surface_session',
        payloadHash,
        effectBinding: 'payment:create',
      })
    ).not.toThrow();
  });

  describe('HA-03 assurance allow-list', () => {
    const human = { decidedByType: 'human' as const, authenticated: true };
    const humanOnly = { finalDecision: 'human_only' as const };

    afterEach(() => {
      withExecutionContext('mission_controller', () => {
        for (const root of Object.values(approvalStoreRoots())) {
          const dir = pathResolver.rootResolve(`${root}/assurance-test`);
          if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
        }
      });
    });

    it('rejects a missing or unrecognised authMethod in every mode', () => {
      for (const mode of ['warn', 'enforce'] as const) {
        expect(() =>
          validateHumanFinalDecision({ accountability: humanOnly, ...human, mode })
        ).toThrow('recognised authMethod (got none)');
        expect(() =>
          validateHumanFinalDecision({
            accountability: humanOnly,
            ...human,
            authMethod: 'sms' as never,
            mode,
          })
        ).toThrow('recognised authMethod (got sms)');
      }
    });

    it('refuses local-credential methods for human-only decisions in every mode', () => {
      for (const authMethod of ['local_token', 'local_admin_token'] as const) {
        for (const mode of ['warn', 'enforce'] as const) {
          expect(() =>
            validateHumanFinalDecision({ accountability: humanOnly, ...human, authMethod, mode })
          ).toThrow(`${authMethod} is not sufficient`);
        }
      }
    });

    it('defaults to A2 and accepts methods at or above it', () => {
      for (const authMethod of [
        'surface_session',
        'terminal_attested',
        'totp',
        'passkey',
      ] as const) {
        expect(
          validateHumanFinalDecision({
            accountability: humanOnly,
            ...human,
            authMethod,
            mode: 'enforce',
          })
        ).toBeUndefined();
      }
    });

    it('warn mode lets a below-level method through and reports the shortfall', () => {
      for (const authMethod of ['manual', 'channel_identity'] as const) {
        expect(
          validateHumanFinalDecision({
            accountability: humanOnly,
            ...human,
            authMethod,
            mode: 'warn',
          })
        ).toEqual({ required: 'A2', provided: 'A1', authMethod, mode: 'warn' });
      }
    });

    it('enforce mode rejects a below-level method', () => {
      expect(() =>
        validateHumanFinalDecision({
          accountability: humanOnly,
          ...human,
          authMethod: 'manual',
          mode: 'enforce',
        })
      ).toThrow('requires assurance A2; manual provides A1');
      expect(() =>
        validateHumanFinalDecision({
          accountability: { ...humanOnly, min_assurance: 'A3' },
          ...human,
          authMethod: 'surface_session',
          mode: 'enforce',
        })
      ).toThrow('requires assurance A3; surface_session provides A2');
    });

    it('takes the rollout mode from KYBERION_APPROVAL_ASSURANCE', () => {
      expect(resolveApprovalAssuranceMode({})).toBe('warn');
      expect(resolveApprovalAssuranceMode({ KYBERION_APPROVAL_ASSURANCE: 'enforce' })).toBe(
        'enforce'
      );
      expect(resolveApprovalAssuranceMode({ KYBERION_APPROVAL_ASSURANCE: 'bogus' })).toBe('warn');
    });

    it('does not re-grade assurance on recheck, but keeps the hard rules', () => {
      expect(
        validateHumanFinalDecision({
          accountability: humanOnly,
          ...human,
          phase: 'recheck',
          mode: 'enforce',
        })
      ).toBeUndefined();
      expect(() =>
        validateHumanFinalDecision({
          accountability: humanOnly,
          ...human,
          authMethod: 'local_token',
          phase: 'recheck',
        })
      ).toThrow('local_token is not sufficient');
    });

    it('stamps min_assurance A2 on human-only requests and rejects unknown levels', () => {
      const record = createApprovalRequest('mission_controller', {
        channel: 'assurance-test',
        threadTs: '1',
        correlationId: 'assurance-default',
        requestedBy: 'assurance-test-agent',
        draft: { title: 'Assurance default', summary: 'HA-03 fixture' },
        accountability: { finalDecision: 'human_only' },
      });
      expect(record.accountability?.min_assurance).toBe('A2');
      expect(() =>
        createApprovalRequest('mission_controller', {
          channel: 'assurance-test',
          threadTs: '1',
          correlationId: 'assurance-invalid',
          requestedBy: 'assurance-test-agent',
          draft: { title: 'Assurance invalid', summary: 'HA-03 fixture' },
          accountability: { finalDecision: 'human_only', min_assurance: 'A9' as never },
        })
      ).toThrow('Invalid approval min_assurance');
    });

    it('lets a requester raise but never lower the human-only floor', () => {
      const create = (min_assurance: 'A0' | 'A3', correlationId: string) =>
        createApprovalRequest('mission_controller', {
          channel: 'assurance-test',
          threadTs: '1',
          correlationId,
          requestedBy: 'assurance-test-agent',
          draft: { title: 'Assurance floor', summary: 'HA-03 fixture' },
          accountability: { finalDecision: 'human_only', min_assurance },
        });
      expect(create('A0', 'assurance-lowered').accountability?.min_assurance).toBe('A2');
      expect(create('A3', 'assurance-raised').accountability?.min_assurance).toBe('A3');
    });

    it('records a warn-mode shortfall on the record and in the event log', () => {
      const record = createApprovalRequest('mission_controller', {
        channel: 'assurance-test',
        threadTs: '1',
        correlationId: 'assurance-shortfall',
        requestedBy: 'assurance-test-agent',
        draft: { title: 'Assurance shortfall', summary: 'HA-03 fixture' },
        accountability: { finalDecision: 'human_only' },
      });
      const decided = decideApprovalRequest('mission_controller', {
        channel: record.channel,
        requestId: record.id,
        decision: 'approved',
        decidedBy: 'operator',
        decidedByType: 'human',
        authenticated: true,
        authMethod: 'manual',
      });
      expect(decided.status).toBe('approved');
      expect(decided.assuranceShortfall).toEqual({
        required: 'A2',
        provided: 'A1',
        authMethod: 'manual',
        mode: 'warn',
      });
      const events = withExecutionContext('mission_controller', () =>
        safeReadFile(pathResolver.rootResolve(approvalEventLogicalPath('assurance-test')), {
          encoding: 'utf8',
        })
      ) as string;
      const decidedEvent = events
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((event) => event.request_id === record.id && event.event === 'approved');
      expect(decidedEvent.assurance_shortfall).toMatchObject({ required: 'A2', provided: 'A1' });
    });

    it('rejects the same decision in enforce mode without persisting it', () => {
      vi.stubEnv('KYBERION_APPROVAL_ASSURANCE', 'enforce');
      try {
        const record = createApprovalRequest('mission_controller', {
          channel: 'assurance-test',
          threadTs: '1',
          correlationId: 'assurance-enforce',
          requestedBy: 'assurance-test-agent',
          draft: { title: 'Assurance enforce', summary: 'HA-03 fixture' },
          accountability: { finalDecision: 'human_only' },
        });
        expect(() =>
          decideApprovalRequest('mission_controller', {
            channel: record.channel,
            requestId: record.id,
            decision: 'approved',
            decidedBy: 'operator',
            decidedByType: 'human',
            authenticated: true,
            authMethod: 'channel_identity',
          })
        ).toThrow('requires assurance A2; channel_identity provides A1');
        expect(loadApprovalRequest(record.channel, record.id)?.status).toBe('pending');
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it('canonicalizes payload key order before hashing', () => {
    expect(computeApprovalPayloadHash({ b: 2, a: 1 })).toBe(
      computeApprovalPayloadHash({ a: 1, b: 2 })
    );
  });

  it('normalizes session action cache keys by case and whitespace (KC-03)', () => {
    expect(approvalActionCacheKey({ action: ' Secret:Set ', targetClass: 'Service:GitHub' })).toBe(
      approvalActionCacheKey({ action: 'secret:set', targetClass: 'service:github' })
    );
    expect(approvalActionCacheKey({ action: 'secret:set', targetClass: 'service:github' })).toBe(
      'secret:set::service:github'
    );
  });

  it('rejects session action descriptors missing action or target class (KC-03)', () => {
    expect(() => approvalActionCacheKey({ action: '', targetClass: 'service:github' })).toThrow(
      'action and targetClass'
    );
    expect(() => approvalActionCacheKey({ action: 'secret:set', targetClass: '  ' })).toThrow(
      'action and targetClass'
    );
  });
});

describe('durable approval apply claims', () => {
  function approved() {
    const record = createApprovalRequest('mission_controller', {
      channel: 'apply-claim-test',
      threadTs: '1',
      correlationId: 'claim-test',
      requestedBy: 'claim-test-operator',
      kind: 'secret_mutation',
      draft: { title: 'Claim fixture', summary: 'Hermetic apply claim fixture' },
    });
    return decideApprovalRequest('mission_controller', {
      channel: record.channel,
      requestId: record.id,
      decision: 'approved',
      decidedBy: 'operator',
    });
  }
  function claim(record: ReturnType<typeof approved>) {
    return claimApprovalApply('mission_controller', {
      channel: record.channel,
      requestId: record.id,
      appliedBy: 'claim-test-operator',
      expectedRecordHash: computeApprovalPayloadHash({ record }),
    });
  }
  it('persists an apply-start claim without pretending the effect completed', () => {
    const record = approved();
    const claimed = claim(record);
    expect(claimed.status).toBe('approved');
    expect(claimed.applyResult).toBeUndefined();
    expect(claimed.applyClaim.startedBy).toBe('claim-test-operator');
    const reloaded = loadApprovalRequest(record.channel, record.id)!;
    expect(reloaded.applyClaim).toEqual(claimed.applyClaim);
    expect(() => claim(reloaded)).toThrow('already started; recovery required');
  });
  it('rejects a stale checked snapshot before claiming', () => {
    const record = approved();
    claim(record);
    expect(() => claim(record)).toThrow('changed before apply');
  });
  it('requires the claim ID for the receipt and never overwrites a terminal receipt', () => {
    const record = approved();
    const claimed = claim(record);
    const params = {
      channel: record.channel,
      requestId: record.id,
      applyResult: { result: 'success' as const, appliedBy: 'claim-test-operator' },
    };
    expect(() => recordApprovalApplyResult('mission_controller', params)).toThrow(
      'claim does not match'
    );
    expect(() =>
      recordApprovalApplyResult('mission_controller', { ...params, claimId: 'wrong' })
    ).toThrow('claim does not match');
    const applied = recordApprovalApplyResult('mission_controller', {
      ...params,
      claimId: claimed.applyClaim.claimId,
    });
    expect(applied.status).toBe('applied');
    expect(applied.applyClaim).toEqual(claimed.applyClaim);
    expect(() =>
      recordApprovalApplyResult('mission_controller', {
        ...params,
        claimId: claimed.applyClaim.claimId,
        applyResult: { result: 'failed' },
      })
    ).toThrow('already recorded');
    expect(loadApprovalRequest(record.channel, record.id)?.applyResult?.result).toBe('success');
  });
  it('rejects a receipt claiming an attempt that never started', () => {
    const record = approved();
    expect(() =>
      recordApprovalApplyResult('mission_controller', {
        channel: record.channel,
        requestId: record.id,
        claimId: 'missing',
        applyResult: { result: 'success' },
      })
    ).toThrow('claim is missing');
  });
  it('preserves legacy receipt callers that did not opt into a claim', () => {
    const record = approved();
    expect(
      recordApprovalApplyResult('mission_controller', {
        channel: record.channel,
        requestId: record.id,
        applyResult: { result: 'success' },
      }).status
    ).toBe('applied');
  });
});
