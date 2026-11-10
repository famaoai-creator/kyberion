import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DistillCandidateRecord } from '@agent/core/knowledge/distill-candidate-registry';
import type { ViewerContext } from './ops-viewer';
const mocks = vi.hoisted(() => ({
  scoped: vi.fn(),
  legacy: vi.fn(),
  tenants: vi.fn(),
  project: vi.fn(),
  mission: vi.fn(),
}));
vi.mock('@agent/core/knowledge/distill-candidate-registry', () => ({
  listDistillCandidateRecords: mocks.legacy,
  listDistillCandidateRecordsForTenants: mocks.scoped,
}));
vi.mock('@agent/core/organization/tenant-governance', () => ({ listTenants: mocks.tenants }));
vi.mock('@agent/core/project/project-registry', () => ({ loadProjectRecord: mocks.project }));
vi.mock('@agent/core/mission/mission-state', () => ({ loadState: mocks.mission }));
import {
  distillCandidateVisibleToViewer,
  listDistillCandidatesForViewer,
  listReuseProposalsForViewer,
  resolveDistillCandidateForViewer,
  DistillCandidateAmbiguityError,
} from './distill-candidate-scope';
import { buildFacadeProposalRow } from '@agent/core/knowledge/facade-proposal-rows';

const scope = {
  tier: 'confidential' as const,
  tenant_slug: 'acme',
  organization_id: 'org-a',
  project_id: 'proj-a',
};
function candidate(overrides: Partial<DistillCandidateRecord> = {}): DistillCandidateRecord {
  return {
    candidate_id: 'DSC-VIEWER',
    source_type: 'artifact',
    tier: 'confidential',
    title: 'private',
    summary: 'private',
    status: 'proposed',
    target_kind: 'sop_candidate',
    created_at: '2026-10-20T00:00:00Z',
    updated_at: '2026-10-20T00:00:00Z',
    scope,
    ...overrides,
  };
}
function viewer(overrides: Partial<ViewerContext> = {}): ViewerContext {
  return {
    role: 'localadmin',
    source: 'token',
    principalId: 'user:reviewer',
    tenantSlugs: ['acme'],
    organizationIds: ['org-a'],
    projectIds: ['proj-a'],
    tierAccess: ['public', 'confidential'],
    ...overrides,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.scoped.mockReturnValue([]);
  mocks.legacy.mockReturnValue([]);
  mocks.tenants.mockReturnValue([{ tenant_slug: 'acme' }]);
  mocks.project.mockReturnValue(null);
  mocks.mission.mockReturnValue(null);
});

it('narrows admitted owner and system candidates out of an explicit tenant selection', () => {
  const owner = viewer({
    tenantSlugs: 'all',
    organizationIds: 'all',
    projectIds: 'all',
    principalId: 'owner',
    includeUntenanted: true,
  });
  for (const scope of [
    { tier: 'public' as const },
    { tier: 'public' as const, owner_nhi: 'owner' },
  ]) {
    const row = candidate({ tier: 'public', scope });
    expect(distillCandidateVisibleToViewer(row, owner)).toBe(true);
    expect(distillCandidateVisibleToViewer(row, { ...owner, permissions: [] })).toBe(false);
    expect(distillCandidateVisibleToViewer(row, owner, 'acme')).toBe(false);
  }
});
describe('distill candidate viewer scope', () => {
  it('uses exact viewer tenant/org/project/tier bounds without global tenant inventory', () => {
    mocks.scoped.mockReturnValue([candidate()]);
    expect(listDistillCandidatesForViewer(viewer())).toEqual([candidate()]);
    expect(mocks.scoped).toHaveBeenCalledWith({
      tenantSlugs: ['acme'],
      organizationIds: ['org-a'],
      projectIds: ['proj-a'],
      tierAccess: ['public', 'confidential'],
    });
    expect(mocks.tenants).not.toHaveBeenCalled();
  });
  it('enumerates registered tenants only for all-tenant viewers', () => {
    listDistillCandidatesForViewer(viewer({ tenantSlugs: 'all' }));
    expect(mocks.tenants).toHaveBeenCalledOnce();
    expect(mocks.scoped.mock.calls[0][0].tenantSlugs).toEqual(['acme']);
  });
  it('narrows all-tenant viewers before inventory and denies expansion before reads', () => {
    listDistillCandidatesForViewer(viewer({ tenantSlugs: 'all' }), 'acme');
    expect(mocks.tenants).not.toHaveBeenCalled();
    vi.clearAllMocks();
    expect(() => listDistillCandidatesForViewer(viewer(), 'other')).toThrow();
    expect(mocks.scoped).not.toHaveBeenCalled();
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it.each([
    { tenant_slug: 'other' },
    { organization_id: 'org-b' },
    { project_id: 'proj-b' },
    { organization_id: undefined },
    { project_id: undefined },
  ])('hides sibling or absent scope %j', (change) => {
    expect(
      distillCandidateVisibleToViewer(candidate({ scope: { ...scope, ...change } }), viewer())
    ).toBe(false);
  });
  it('never exposes personal or unauthorized tiers, even to localadmin', () => {
    expect(
      distillCandidateVisibleToViewer(
        candidate({ tier: 'personal', scope: { ...scope, tier: 'personal' } }),
        viewer({ tierAccess: ['personal', 'public', 'confidential'] })
      )
    ).toBe(false);
    expect(distillCandidateVisibleToViewer(candidate(), viewer({ tierAccess: ['public'] }))).toBe(
      false
    );
  });
  it('enforces audience and owner without an all-tenant bypass', () => {
    const all = viewer({ tenantSlugs: 'all' });
    expect(
      distillCandidateVisibleToViewer(
        candidate({ scope: { ...scope, allowed_audience: ['user:other'] } }),
        all
      )
    ).toBe(false);
    expect(
      distillCandidateVisibleToViewer(
        candidate({ scope: { ...scope, owner_nhi: 'user:other' } }),
        all
      )
    ).toBe(false);
    expect(
      distillCandidateVisibleToViewer(
        candidate({
          scope: { ...scope, owner_nhi: 'user:other', allowed_audience: ['user:reviewer'] },
        }),
        all
      )
    ).toBe(true);
    expect(
      distillCandidateVisibleToViewer(
        candidate({
          scope: { ...scope, viewer_principal: 'user:other', allowed_audience: ['user:other'] },
        }),
        all
      )
    ).toBe(false);
  });
  it('resolves legacy project context from server records and denies missing scoped grants', () => {
    const legacy = candidate({ scope: undefined, project_id: 'proj-a' });
    expect(distillCandidateVisibleToViewer(legacy, viewer())).toBe(false);
    mocks.project.mockReturnValue({ ...scope });
    expect(distillCandidateVisibleToViewer(legacy, viewer())).toBe(true);
    expect(
      distillCandidateVisibleToViewer(
        candidate({ scope: undefined }),
        viewer({ tenantSlugs: 'all', organizationIds: 'all', projectIds: 'all' })
      )
    ).toBe(true);
  });
  it('filters both stores and resolves only a unique exact scoped row', () => {
    const visible = candidate();
    mocks.scoped.mockReturnValue([
      visible,
      candidate({ candidate_id: 'DSC-OTHER', scope: { ...scope, tenant_slug: 'other' } }),
    ]);
    mocks.legacy.mockReturnValue([candidate({ candidate_id: 'DSC-LEGACY', scope: undefined })]);
    expect(listDistillCandidatesForViewer(viewer())).toEqual([visible]);
    expect(resolveDistillCandidateForViewer(visible.candidate_id, viewer())).toBe(visible);
    expect(resolveDistillCandidateForViewer('DSC-OTHER', viewer())).toBeNull();
    mocks.scoped.mockReturnValue([visible, { ...visible }]);
    expect(() => resolveDistillCandidateForViewer(visible.candidate_id, viewer())).toThrow(
      DistillCandidateAmbiguityError
    );
  });
});

describe('selected tenant duplicate identity', () => {
  it('resolves only the selected tenant and never expands a viewer', () => {
    const acme = candidate();
    const beta = candidate({ scope: { ...scope, tenant_slug: 'beta' } });
    mocks.tenants.mockReturnValue([{ tenant_slug: 'acme' }, { tenant_slug: 'beta' }]);
    mocks.scoped.mockImplementation((access: { tenantSlugs: string[] }) =>
      [acme, beta].filter((row) => access.tenantSlugs.includes(row.scope!.tenant_slug!))
    );
    const all = viewer({ tenantSlugs: 'all' });
    expect(() => resolveDistillCandidateForViewer(acme.candidate_id, all)).toThrow(
      DistillCandidateAmbiguityError
    );
    expect(resolveDistillCandidateForViewer(acme.candidate_id, all, 'acme')).toBe(acme);
    expect(() => resolveDistillCandidateForViewer(acme.candidate_id, viewer(), 'beta')).toThrow();
  });
});

describe('reuse proposals on the queue (D8)', () => {
  const capture = (id: string, rowScope: Record<string, unknown>, via = 'concierge') =>
    buildFacadeProposalRow(
      {
        recordKind: via === 'concierge' ? 'mission_seed' : 'background_review',
        learningKind: 'lesson',
        decidedVia: via,
        idPrefix: 'DSC',
      },
      {
        candidate_id: id,
        source_type: 'mission',
        title: `title ${id}`,
        summary: `summary ${id}`,
        target_kind: 'sop_candidate',
        evidence_refs: [`mission:${id}`],
        metadata: {},
        proposedMemoryKind: 'sop',
        scope: rowScope as never,
        project_id: 'proj-a',
      }
    );

  it('lists only queue rows the server-resolved viewer may read, with their decider', () => {
    const rows = [
      capture('DSC-MINE', scope),
      capture('DSC-OTHER-TENANT', { ...scope, tenant_slug: 'globex' }),
      capture('DSC-OWNER', { tier: 'personal', owner_nhi: 'user:reviewer' }),
      capture('DSC-BR', scope, 'pnpm background-review'),
    ];
    const listed = listReuseProposalsForViewer(viewer(), undefined, rows);
    expect(listed.map((row) => [row.candidate_id, row.decided_via, row.project_id])).toEqual(
      expect.arrayContaining([
        ['DSC-MINE', 'concierge', 'proj-a'],
        ['DSC-BR', 'pnpm background-review', 'proj-a'],
      ])
    );
    expect(listed).toHaveLength(2);
    // A client tenant parameter only narrows; it never admits another tenant.
    expect(() => listReuseProposalsForViewer(viewer(), 'globex', rows)).toThrow(
      'tenant scope denied'
    );
    expect(
      listReuseProposalsForViewer(viewer({ tenantSlugs: 'all' }), 'globex', rows).map(
        (row) => row.candidate_id
      )
    ).toEqual(['DSC-OTHER-TENANT']);
  });
});
