import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryCandidate } from './memory-promotion-queue.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
const mocks = vi.hoisted(() => ({ rows: [] as MemoryCandidate[], list: vi.fn() }));
vi.mock('./memory-promotion-queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./memory-promotion-queue.js')>()),
  listMemoryPromotionCandidates: (...args: unknown[]) => {
    mocks.list(...args);
    return mocks.rows;
  },
}));
import { scopedLearningApprovalBinding } from './scoped-learning-approval-verifier.js';
import {
  isScopedLearningApprovalRequest,
  resolveScopedLearningApprovalCandidate,
} from './scoped-learning-approval-visibility.js';
const scope = {
  tier: 'confidential' as const,
  tenant_slug: 'acme',
  organization_id: 'org-a',
  project_id: 'proj-a',
};
const candidate: MemoryCandidate = {
  candidate_id: 'MEM-VISIBILITY',
  source_type: 'artifact',
  source_ref: 'artifact:one',
  knowledge_domain: 'organization',
  proposed_memory_kind: 'sop',
  summary: 'summary',
  evidence_refs: ['artifact:one'],
  curation: {
    title: 'SOP',
    summary: 'summary',
    content: 'Perform the bounded operation',
    evidence_refs: ['artifact:one'],
  },
  sensitivity_tier: 'confidential',
  ratification_required: true,
  status: 'queued',
  queued_at: '2026-10-20T00:00:00.000Z',
  scope,
};
const binding = scopedLearningApprovalBinding(candidate);
const record = {
  id: 'review-one',
  channel: 'terminal',
  storageChannel: 'terminal',
  correlationId: 'scoped-learning:' + binding.digest,
  source: { taskId: candidate.candidate_id },
  scope,
  accountability: {
    finalDecision: 'human_only',
    payloadHash: binding.digest,
    effectBinding: binding.effect,
  },
  justification: { requestedEffects: [binding.effect] },
} as ApprovalRequestRecord;
beforeEach(() => {
  mocks.rows = [candidate];
  mocks.list.mockClear();
});
describe('scoped learning approval candidate resolution', () => {
  it('resolves an exact current candidate from the request scope only', () => {
    expect(resolveScopedLearningApprovalCandidate(record)).toEqual(candidate);
    expect(mocks.list).toHaveBeenCalledWith(scope);
  });
  it.each(['pending', 'approved', 'rejected', 'cancelled'] as const)(
    'checks binding for %s history too',
    (status) => {
      expect(resolveScopedLearningApprovalCandidate({ ...record, status })).toEqual(candidate);
      mocks.rows = [{ ...candidate, curation: { ...candidate.curation!, content: 'changed' } }];
      expect(resolveScopedLearningApprovalCandidate({ ...record, status })).toBeNull();
    }
  );
  it('never selects the first physical duplicate', () => {
    mocks.rows = [candidate, { ...candidate }];
    expect(resolveScopedLearningApprovalCandidate(record)).toBeNull();
  });
  it.each([
    { tenant_slug: 'other' },
    { organization_id: 'org-b' },
    { project_id: 'proj-b' },
    { owner_nhi: 'user:other' },
    { allowed_audience: ['user:other'] },
  ])('cannot bind another identity %j', (restriction) => {
    mocks.rows = [{ ...candidate, scope: { ...scope, ...restriction } }];
    expect(resolveScopedLearningApprovalCandidate(record)).toBeNull();
  });
  it('does not downgrade a corrupted scoped request to a legacy approval', () => {
    const corrupted = {
      ...record,
      accountability: { ...record.accountability!, effectBinding: 'other-effect' },
    };
    expect(isScopedLearningApprovalRequest(corrupted)).toBe(true);
    expect(resolveScopedLearningApprovalCandidate(corrupted)).toBeNull();
  });
  it('fails closed for missing, malformed and detached candidates', () => {
    mocks.rows = [];
    expect(resolveScopedLearningApprovalCandidate(record)).toBeNull();
    expect(resolveScopedLearningApprovalCandidate({ ...record, source: {} })).toBeNull();
    expect(
      resolveScopedLearningApprovalCandidate({ ...record, scope: { tier: 'confidential' } })
    ).toBeNull();
    expect(
      isScopedLearningApprovalRequest({
        ...record,
        correlationId: undefined,
        accountability: undefined,
      })
    ).toBe(false);
  });
});
