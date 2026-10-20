import { describe, expect, it } from 'vitest';
import type { MemoryCandidate } from '@agent/core/knowledge/memory-promotion-queue';
import type { ConciergeViewerContext } from './viewer-context';
import { memoryCandidateVisibleToViewer } from './memory-candidate-visibility';
const viewer: ConciergeViewerContext = {
  role: 'localadmin',
  source: 'token',
  principalId: 'user:owner',
  tenantSlugs: 'all',
  organizationIds: 'all',
  projectIds: 'all',
  tierAccess: ['public', 'confidential'],
};
const candidate: MemoryCandidate = {
  candidate_id: 'MEM-SOURCE',
  source_type: 'mission',
  source_ref: 'mission:MSN-SOURCE',
  proposed_memory_kind: 'heuristic',
  summary: 'private source',
  evidence_refs: [],
  sensitivity_tier: 'confidential',
  ratification_required: true,
  status: 'queued',
  queued_at: '2026-10-20T00:00:00Z',
  scope: { tier: 'personal', owner_nhi: 'user:owner' },
};
describe('concierge memory source visibility', () => {
  it('denies personal source to confidential-only all-tenant viewers', () => {
    expect(memoryCandidateVisibleToViewer(candidate, viewer)).toBe(false);
    expect(
      memoryCandidateVisibleToViewer(
        { ...candidate, scope: { ...candidate.scope!, tenant_slug: 'acme' } },
        viewer
      )
    ).toBe(false);
  });
  it('requires both source personal grant and authenticated owner or audience', () => {
    const personal = { ...viewer, tierAccess: ['personal' as const, 'confidential' as const] };
    expect(memoryCandidateVisibleToViewer(candidate, personal)).toBe(true);
    expect(
      memoryCandidateVisibleToViewer(candidate, { ...personal, principalId: 'user:other' })
    ).toBe(false);
    expect(
      memoryCandidateVisibleToViewer({ ...candidate, scope: { tier: 'personal' } }, personal)
    ).toBe(false);
    expect(
      memoryCandidateVisibleToViewer(
        { ...candidate, scope: undefined, sensitivity_tier: 'personal' },
        personal
      )
    ).toBe(false);
    expect(
      memoryCandidateVisibleToViewer(
        {
          ...candidate,
          scope: { tier: 'personal', owner_nhi: 'user:other', allowed_audience: ['user:owner'] },
        },
        personal
      )
    ).toBe(true);
    expect(
      memoryCandidateVisibleToViewer(candidate, { ...personal, tierAccess: ['personal'] })
    ).toBe(false);
  });
  it('does not let allowed-audience or owner be bypassed by all tenants', () => {
    const scope = { tier: 'confidential' as const, tenant_slug: 'acme' };
    expect(
      memoryCandidateVisibleToViewer(
        { ...candidate, scope: { ...scope, allowed_audience: ['user:other'] } },
        viewer
      )
    ).toBe(false);
    expect(
      memoryCandidateVisibleToViewer(
        { ...candidate, scope: { ...scope, owner_nhi: 'user:other' } },
        viewer
      )
    ).toBe(false);
  });
  it('applies selected tenant and narrower organization/project bounds', () => {
    const scope = {
      tier: 'confidential' as const,
      tenant_slug: 'acme',
      organization_id: 'org-a',
      project_id: 'proj-a',
    };
    const scoped = {
      ...viewer,
      tenantSlugs: ['acme'],
      organizationIds: ['org-a'],
      projectIds: ['proj-a'],
    };
    expect(memoryCandidateVisibleToViewer({ ...candidate, scope }, scoped)).toBe(true);
    for (const change of [
      { tenant_slug: 'other' },
      { organization_id: 'org-b' },
      { project_id: 'proj-b' },
    ])
      expect(
        memoryCandidateVisibleToViewer({ ...candidate, scope: { ...scope, ...change } }, scoped)
      ).toBe(false);
    expect(
      memoryCandidateVisibleToViewer(
        { ...candidate, scope: { tier: 'confidential', tenant_slug: 'acme' } },
        scoped
      )
    ).toBe(false);
  });
  it('keeps system selection and legacy public behavior without inferring private identity', () => {
    const row = { ...candidate, scope: { tier: 'public' as const } };
    expect(
      memoryCandidateVisibleToViewer(row, { ...viewer, tenantSlugs: [], includeUntenanted: true })
    ).toBe(true);
    expect(memoryCandidateVisibleToViewer(row, { ...viewer, tenantSlugs: ['acme'] })).toBe(false);
    expect(
      memoryCandidateVisibleToViewer(
        { ...row, scope: { tenant_slug: 'acme' } as MemoryCandidate['scope'] },
        viewer
      )
    ).toBe(false);
  });
});
