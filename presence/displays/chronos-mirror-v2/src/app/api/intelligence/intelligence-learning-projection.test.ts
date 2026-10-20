import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), visible: vi.fn(), digest: vi.fn() }));
vi.mock('../../../lib/scoped-learning-approval-visibility', () => ({
  scopedLearningApprovalVisibleToViewer: mocks.visible,
}));
vi.mock('../../../lib/intelligence-primitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/intelligence-primitives')>()),
  listApprovalRequests: mocks.list,
}));
vi.mock('@agent/core/governance/approval-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance/approval-store')>()),
  computeApprovalPresentedDigest: mocks.digest,
}));
import { collectPendingApprovals } from './intelligence-control-data';
const viewer = {
  role: 'localadmin' as const,
  source: 'token' as const,
  tenantSlugs: ['acme'],
  organizationIds: ['org-a'],
  projectIds: ['proj-a'],
  tierAccess: ['confidential' as const],
};
const row = {
  id: 'visible',
  title: 'private title',
  summary: 'private summary',
  scope: {
    tier: 'confidential',
    tenant_slug: 'acme',
    organization_id: 'org-a',
    project_id: 'proj-a',
  },
  requestedAt: '2026-10-20T00:00:00Z',
  work_loop: { summary: 'private loop' },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockReturnValue([row]);
  mocks.visible.mockReturnValue(true);
  mocks.digest.mockReturnValue('digest');
});
describe('intelligence scoped approval projection', () => {
  it('removes invisible rows before digest, counts or work-loop projection', () => {
    mocks.visible.mockReturnValue(false);
    expect(collectPendingApprovals(['acme'], ['confidential'], viewer)).toEqual([]);
    expect(mocks.digest).not.toHaveBeenCalled();
    expect(mocks.visible).toHaveBeenCalledWith(row, viewer);
  });
  it('filters before the bounded list and retains the exact authorized row', () => {
    mocks.list.mockReturnValue([
      ...Array.from({ length: 30 }, (_, i) => ({ ...row, id: 'hidden-' + i })),
      row,
    ]);
    mocks.visible.mockImplementation((candidate) => candidate.id === 'visible');
    const result = collectPendingApprovals(['acme'], ['confidential'], viewer);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'visible', presentedDigest: 'digest' });
    expect(mocks.digest).toHaveBeenCalledOnce();
  });
  it('preserves tenant and tier narrowing after the full-scope check', () => {
    expect(collectPendingApprovals(['other'], ['confidential'], viewer)).toEqual([]);
    expect(collectPendingApprovals(['acme'], ['public'], viewer)).toEqual([]);
    expect(mocks.digest).not.toHaveBeenCalled();
  });
});
