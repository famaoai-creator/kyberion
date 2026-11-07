import { describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({ records: [] as Record<string, unknown>[] }));
vi.mock('@agent/core/workforce/artifact-record', () => ({
  listArtifactRecords: () => fixtures.records,
}));
vi.mock('@agent/core/deliverable-inbox', () => ({ listInboxEntries: () => [] }));
vi.mock('@agent/core/mission/mission-state', () => ({
  loadState: () => ({ tenant_slug: 'acme', tier: 'public' }),
}));
vi.mock('./deliverable-review', () => ({ loadDeliverableReviewState: () => null }));
import { collectDeliverableInbox } from './deliverable-inbox';

describe('deliverable custody projection', () => {
  it('never replaces declared owner custody with a mission tenant fallback', () => {
    fixtures.records = [
      {
        artifact_id: 'owned',
        kind: 'report',
        storage_class: 'repo',
        mission_id: 'MSN-ACME',
        owner_nhi: 'alice',
        metadata: { tier: 'public' },
      },
    ];
    expect(collectDeliverableInbox({ tenantSlugs: ['acme'], personIds: ['bob'] })).toEqual([]);
    expect(collectDeliverableInbox({ tenantSlugs: ['acme'], personIds: ['alice'] })).toEqual([
      expect.objectContaining({ artifactId: 'owned', ownerNhi: 'alice', tenantSlug: undefined }),
    ]);
    expect(
      collectDeliverableInbox({
        tenantSlugs: ['acme'],
        personIds: ['alice'],
        requestedTenant: 'acme',
      })
    ).toEqual([]);
  });

  it('does not let the public carve-out rescue malformed aliases', () => {
    for (const binding of [
      { owner_nhi: '', nhi_id: 'alice' },
      { owner_nhi: 'alice', nhi_id: 'bob' },
      { nhi_id: 42 },
    ]) {
      fixtures.records = [
        {
          artifact_id: 'invalid',
          kind: 'report',
          storage_class: 'repo',
          metadata: { tier: 'public' },
          ...binding,
        },
      ];
      expect(collectDeliverableInbox({ tenantSlugs: 'all', personIds: ['alice'] })).toEqual([]);
    }
  });

  it('applies explicit tenant selection to ownerless public records too', () => {
    fixtures.records = [
      {
        artifact_id: 'public',
        kind: 'report',
        storage_class: 'repo',
        metadata: { tier: 'public' },
      },
    ];
    expect(collectDeliverableInbox({ tenantSlugs: ['acme'] })).toHaveLength(1);
    expect(collectDeliverableInbox({ tenantSlugs: ['acme'], requestedTenant: 'acme' })).toEqual([]);
  });
});
