import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn(), verify: vi.fn() }));
vi.mock('./memory-promotion-queue.js', () => ({ loadMemoryPromotionCandidate: mocks.load }));
vi.mock('./scoped-learning-publication.js', () => ({
  assertScopedLearningScope: (scope: unknown) => scope,
  verifyScopedLearningPublication: mocks.verify,
}));
import { resolveScopedLearningRetrieval } from './scoped-learning-retrieval.js';
const sourceScope = {
  tier: 'confidential' as const,
  tenant_slug: 'tenant-a',
  organization_id: 'org-a',
  project_id: 'PRJ-A',
};
const source =
  'knowledge/confidential/tenant-a/organizations/org-a/projects/PRJ-A/evolution/operations/MEM-FB-SOURCE.md';
const publication = {
  version: 1,
  candidate_id: 'MEM-FB-SOURCE',
  scope: sourceScope,
  approved_payload_digest: 'c'.repeat(64),
  record_path: source.replace('.md', '.json'),
  markdown_path: source,
  record_sha256: 'b'.repeat(64),
  markdown_sha256: 'a'.repeat(64),
};
const input = {
  documentPath: source,
  sourceSha256: 'a'.repeat(64),
  candidateId: 'MEM-FB-SOURCE',
  scopeText: JSON.stringify(sourceScope),
  consumerScope: { ...sourceScope, mission_id: 'MSN-READ', task_id: 'T1' },
};
afterEach(() => vi.clearAllMocks());
describe('scoped publication retrieval proof', () => {
  it('loads only the exact source queue and binds proof to the same-read indexed hash', () => {
    mocks.load.mockReturnValue({ candidate_id: 'MEM-FB-SOURCE' });
    mocks.verify.mockReturnValue(publication);
    expect(resolveScopedLearningRetrieval(input)).toEqual({ governed: true, publication });
    expect(mocks.load).toHaveBeenCalledWith('MEM-FB-SOURCE', sourceScope);
    expect(resolveScopedLearningRetrieval({ ...input, sourceSha256: 'd'.repeat(64) })).toEqual({
      governed: true,
    });
  });
  it('does not search queues for a sibling project or an attempted scope widening', () => {
    expect(
      resolveScopedLearningRetrieval({
        ...input,
        consumerScope: { ...input.consumerScope, project_id: 'PRJ-B' },
      })
    ).toEqual({ governed: true });
    expect(
      resolveScopedLearningRetrieval({
        ...input,
        consumerScope: { tier: 'confidential', tenant_slug: 'tenant-a' },
      })
    ).toEqual({ governed: true });
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it('refuses missing canonical publication and malformed declared scope', () => {
    mocks.load.mockReturnValue(null);
    mocks.verify.mockReturnValue(undefined);
    expect(resolveScopedLearningRetrieval(input)).toEqual({ governed: true });
    expect(resolveScopedLearningRetrieval({ ...input, scopeText: '{broken' })).toEqual({
      governed: true,
    });
    expect(resolveScopedLearningRetrieval({ ...input, candidateId: undefined })).toEqual({
      governed: true,
    });
    for (const spelling of ['SOP-123.md', './SOP-123.md', '../operations/SOP-123.md']) {
      expect(
        resolveScopedLearningRetrieval({
          ...input,
          documentPath: source.replace('MEM-FB-SOURCE.md', spelling),
          candidateId: undefined,
          scopeText: undefined,
        })
      ).toEqual({ governed: true });
    }
  });
  it('does not route PR-ratified product/public candidates into confidential SOP proof', () => {
    expect(
      resolveScopedLearningRetrieval({
        ...input,
        documentPath: 'knowledge/product/evolution/operations/MEM-PRODUCT.md',
      })
    ).toEqual({ governed: false });
    expect(mocks.load).not.toHaveBeenCalled();
  });
});
