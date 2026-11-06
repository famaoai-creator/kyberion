import { describe, expect, it, vi } from 'vitest';

vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_r: string, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/project/project-registry', () => ({ listProjectRecords: () => [] }));

import { selectableProjects } from './selected-project';

const record = (overrides: Record<string, unknown>) =>
  ({
    project_id: 'PRJ-A',
    name: 'Alpha',
    summary: '',
    status: 'active',
    tier: 'confidential',
    organization_id: 'acme',
    tenant_slug: 'acme',
    ...overrides,
  }) as never;

describe('selectableProjects', () => {
  const all = { organizationIds: 'all' as const, projectIds: 'all' as const, tenantSlug: 'acme' };

  it('offers the selected company projects, sorted by name', () => {
    const projects = selectableProjects(
      [
        record({ project_id: 'PRJ-Z', name: 'Zeta' }),
        record({}),
        record({ project_id: 'PRJ-B', name: '' }),
      ],
      all
    );
    expect(projects.map((p) => p.project_id)).toEqual(['PRJ-A', 'PRJ-B', 'PRJ-Z']);
    expect(projects[1].name).toBe('PRJ-B');
  });

  it('never offers another company, an archived project or one without an organization', () => {
    expect(
      selectableProjects(
        [
          record({ tenant_slug: 'beta' }),
          record({ status: 'archived' }),
          record({ organization_id: undefined }),
          record({ tenant_slug: undefined }),
          record({ project_id: '../escape' }),
        ],
        all
      )
    ).toEqual([]);
  });

  it('stays inside the viewer organization and project scope', () => {
    const records = [
      record({}),
      record({ project_id: 'PRJ-B' }),
      record({ project_id: 'PRJ-C', organization_id: 'other' }),
    ];
    expect(
      selectableProjects(records, { ...all, projectIds: ['PRJ-B', 'PRJ-C'] }).map(
        (p) => p.project_id
      )
    ).toEqual(['PRJ-B', 'PRJ-C']);
    expect(
      selectableProjects(records, { ...all, organizationIds: ['acme'] }).map((p) => p.project_id)
    ).toEqual(['PRJ-A', 'PRJ-B']);
  });
});
