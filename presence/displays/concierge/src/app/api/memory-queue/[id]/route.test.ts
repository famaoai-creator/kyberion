import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { safeRmSync } from '@agent/core/secure-io';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  loadMemoryPromotionCandidate,
  memoryPromotionCandidateKey,
} from '@agent/core/knowledge/memory-promotion-queue';

const mocks = vi.hoisted(() => ({
  viewer: vi.fn(),
  transport: vi.fn(),
  audit: vi.fn(),
  decider: vi.fn(),
}));
vi.mock('@agent/core/governance/audit-chain', () => ({
  auditChain: { record: vi.fn(() => 'audit:synthetic'), loadAll: mocks.audit },
}));
vi.mock('../../../../lib/api-guard', () => ({
  requireConciergeMutationAccess: () => null,
}));
vi.mock('../../../../lib/viewer-context', () => ({
  resolveConciergeViewer: mocks.viewer,
}));
vi.mock('../../../../lib/front-desk-member', () => ({
  conciergeDecisionDenied: () => null,
  resolveConciergeDecidedBy: mocks.decider,
}));
vi.mock('@agent/core/secure-io', async (original) => ({
  ...(await original<typeof import('@agent/core/secure-io')>()),
  safeExecResult: mocks.transport,
}));
import { POST as conciergeReject } from './route';

const viewer = {
  role: 'localadmin' as const,
  source: 'token' as const,
  principalId: 'user:reviewer',
  tenantSlugs: ['review-tenant'],
  organizationIds: ['review-org'],
  projectIds: 'all' as const,
  tierAccess: ['public', 'confidential'] as ('public' | 'confidential')[],
  includeUntenanted: false,
};
let queuePath: string;
beforeEach(() => {
  vi.clearAllMocks();
  queuePath = `active/shared/tmp/test-memory-rejection-${randomUUID()}.jsonl`;
  vi.stubEnv('KYBERION_MEMORY_QUEUE_PATH', queuePath);
  mocks.viewer.mockReturnValue({ context: viewer });
  mocks.decider.mockReturnValue({
    id: 'user:reviewer',
    display_name: 'Reviewer',
    role: 'approver',
  });
  mocks.audit.mockReturnValue([{ id: 'synthetic', tenantSlug: 'review-tenant' }]);
});
afterEach(() => {
  safeRmSync(queuePath, { force: true });
  vi.unstubAllEnvs();
});

function fixture(domain: 'organization' | 'unclassified' = 'unclassified') {
  const candidate = createMemoryPromotionCandidate({
    candidateId: `MEM-REJECTION-${randomUUID()}`,
    sourceType: 'task_session',
    sourceRef: 'task_session:rejection-test',
    proposedMemoryKind: 'sop',
    knowledgeDomain: domain,
    summary: `A queued ${domain} SOP that an authorized reviewer declines.`,
    evidenceRefs: ['artifact:rejection-test'],
    sensitivityTier: 'confidential',
    scope: { tier: 'confidential', tenant_slug: 'review-tenant', organization_id: 'review-org' },
  });
  enqueueMemoryPromotionCandidate({ ...candidate, audit_ref: 'audit:synthetic' });
  return candidate;
}
describe('Concierge exact scoped memory decisions with real queue and review', () => {
  it('rejects through Concierge using exact scope without an id-only controller subprocess', async () => {
    const candidate = fixture();
    const request = (body: Record<string, unknown>) =>
      ({ headers: new Headers(), json: async () => body }) as unknown as NextRequest;
    const params = { params: Promise.resolve({ id: candidate.candidate_id }) };
    expect((await conciergeReject(request({ decision: 'reject' }), params)).status).toBe(409);
    expect(
      (
        await conciergeReject(
          request({ decision: 'reject', candidateKey: memoryPromotionCandidateKey(candidate) }),
          params
        )
      ).status
    ).toBe(200);
    expect(loadMemoryPromotionCandidate(candidate.candidate_id, candidate.scope)?.status).toBe(
      'rejected'
    );
    expect(
      loadMemoryPromotionCandidate(candidate.candidate_id, candidate.scope)?.decided_by
    ).toEqual({
      id: 'user:reviewer',
      display_name: 'Reviewer',
      role: 'approver',
      kind: 'human',
    });
    expect(mocks.transport).not.toHaveBeenCalled();
  });
  it('approves the exact non-SOP scope among sibling IDs and preserves the server-resolved decider', async () => {
    const base = fixture();
    const sibling = {
      ...base,
      audit_ref: 'audit:synthetic',
      content_hash: undefined,
      candidate_id: 'MEM-SIBLING',
      proposed_memory_kind: 'heuristic' as const,
      knowledge_domain: 'organization' as const,
      summary: 'A non-SOP sibling candidate for exact review.',
      scope: { ...base.scope!, tenant_slug: 'other-tenant' },
    };
    const selected = { ...sibling, scope: base.scope };
    enqueueMemoryPromotionCandidate(sibling);
    enqueueMemoryPromotionCandidate(selected);
    const request = {
      headers: new Headers(),
      json: async () => ({
        decision: 'approve',
        candidateKey: memoryPromotionCandidateKey(selected),
      }),
    } as unknown as NextRequest;
    const result = await conciergeReject(request, {
      params: Promise.resolve({ id: selected.candidate_id }),
    });
    expect(result.status).toBe(200);
    expect(loadMemoryPromotionCandidate(sibling.candidate_id, sibling.scope)?.status).toBe(
      'queued'
    );
    const stored = loadMemoryPromotionCandidate(selected.candidate_id, selected.scope)!;
    expect(stored.status).toBe('approved');
    expect(stored.decided_by).toEqual({
      id: 'user:reviewer',
      display_name: 'Reviewer',
      role: 'approver',
      kind: 'human',
    });
    expect(mocks.transport).not.toHaveBeenCalled();
  });
  it('retains the real audit/readiness floor before approving an exact non-SOP candidate', async () => {
    const base = fixture();
    const candidate = {
      ...base,
      audit_ref: 'audit:synthetic',
      content_hash: undefined,
      candidate_id: 'MEM-NO-AUDIT',
      proposed_memory_kind: 'heuristic' as const,
      knowledge_domain: 'organization' as const,
      summary: 'An exact non-SOP candidate lacking audit evidence.',
    };
    enqueueMemoryPromotionCandidate(candidate);
    mocks.audit.mockReturnValue([]);
    const request = {
      headers: new Headers(),
      json: async () => ({
        decision: 'approve',
        candidateKey: memoryPromotionCandidateKey(candidate),
      }),
    } as unknown as NextRequest;
    expect(
      (await conciergeReject(request, { params: Promise.resolve({ id: candidate.candidate_id }) }))
        .status
    ).toBe(500);
    expect(loadMemoryPromotionCandidate(candidate.candidate_id, candidate.scope)?.status).toBe(
      'queued'
    );
    expect(mocks.transport).not.toHaveBeenCalled();
  });
  it('preserves approval of a unique public unscoped product SOP through the real review floor', async () => {
    const candidate = createMemoryPromotionCandidate({
      candidateId: 'MEM-PUBLIC-PRODUCT',
      sourceType: 'task_session',
      sourceRef: 'task_session:public',
      proposedMemoryKind: 'sop',
      knowledgeDomain: 'product',
      sensitivityTier: 'public',
      summary: 'A public reusable product procedure.',
      evidenceRefs: ['knowledge/public/browser-scenarios/README.md'],
    });
    enqueueMemoryPromotionCandidate({ ...candidate, audit_ref: 'audit:synthetic' });
    const request = {
      headers: new Headers(),
      json: async () => ({
        decision: 'approve',
        candidateKey: memoryPromotionCandidateKey(candidate),
      }),
    } as unknown as NextRequest;
    mocks.viewer.mockReturnValue({
      context: { ...viewer, tenantSlugs: 'all', organizationIds: 'all' },
    });
    expect(
      (await conciergeReject(request, { params: Promise.resolve({ id: candidate.candidate_id }) }))
        .status
    ).toBe(200);
    expect(loadMemoryPromotionCandidate(candidate.candidate_id)?.status).toBe('approved');
    expect(mocks.transport).not.toHaveBeenCalled();
  });
});
