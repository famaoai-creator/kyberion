import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
const mocks = vi.hoisted(() => ({ candidate: vi.fn(), scoped: vi.fn() }));
vi.mock('@agent/core/knowledge/scoped-learning-approval-visibility', () => ({
  isScopedLearningApprovalRequest: mocks.scoped,
  resolveScopedLearningApprovalCandidate: mocks.candidate,
}));
import { scopedLearningApprovalVisibleToViewer } from './scoped-learning-approval-visibility';
const scope = {
  tier: 'confidential' as const,
  tenant_slug: 'acme',
  organization_id: 'org-a',
  project_id: 'proj-a',
};
const row = { candidate_id: 'MEM-SCOPE', sensitivity_tier: 'confidential', scope };
const record = { id: 'request-one', scope } as ApprovalRequestRecord;
const viewer = {
  role: 'localadmin',
  source: 'token',
  principalId: 'user:one',
  tenantSlugs: ['acme'],
  organizationIds: ['org-a'],
  projectIds: ['proj-a'],
  tierAccess: ['public', 'confidential'],
  includeUntenanted: false,
} as Parameters<typeof scopedLearningApprovalVisibleToViewer>[1];
beforeEach(() => {
  mocks.scoped.mockReturnValue(true);
  mocks.candidate.mockReturnValue(row);
});
describe('scoped learning approval full viewer scope', () => {
  it('allows only the currently bound candidate in authorized scope', () => {
    expect(scopedLearningApprovalVisibleToViewer(record, viewer)).toBe(true);
  });
  it.each([
    { tenant_slug: 'other' },
    { organization_id: 'org-b' },
    { project_id: 'proj-b' },
    { owner_nhi: 'user:other' },
    { allowed_audience: ['user:other'] },
  ])('withholds scoped review for %j', (restriction) => {
    mocks.candidate.mockReturnValue({ ...row, scope: { ...scope, ...restriction } });
    expect(scopedLearningApprovalVisibleToViewer(record, viewer)).toBe(false);
  });
  it('withholds source-tier content from a lower-tier viewer', () => {
    expect(
      scopedLearningApprovalVisibleToViewer(record, { ...viewer!, tierAccess: ['public'] })
    ).toBe(false);
  });
  it('does not let changed, missing or duplicated bound content fall back to legacy', () => {
    mocks.candidate.mockReturnValue(null);
    expect(scopedLearningApprovalVisibleToViewer(record, viewer)).toBe(false);
  });
  it('leaves unrelated existing approval authorization to its existing adapter', () => {
    mocks.scoped.mockReturnValue(false);
    mocks.candidate.mockReturnValue(null);
    expect(scopedLearningApprovalVisibleToViewer(record, viewer)).toBe(true);
  });
});
