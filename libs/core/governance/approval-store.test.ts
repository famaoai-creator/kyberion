import { afterEach, describe, expect, it } from 'vitest';
import {
  APPROVAL_CHANGE_INSTRUCTION_MAX,
  VITEST_APPROVAL_STORE_ROOT,
  approvalActionCacheKey,
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  approvalStoreRoots,
  computeApprovalPayloadHash,
  createApprovalRequest,
  decideApprovalRequest,
  expireApprovalRequest,
  listApprovalRequests,
  validateHumanFinalDecision,
} from './approval-store.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeRmSync } from '../secure-io.js';
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
        payloadHash: 'changed',
        effectBinding: 'payment:create',
      })
    ).toThrow('payload hash');
    expect(() =>
      validateHumanFinalDecision({
        accountability,
        decidedByType: 'human',
        authenticated: true,
        payloadHash,
        effectBinding: 'payment:create',
      })
    ).not.toThrow();
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
