import { describe, expect, it } from 'vitest';
import { isFrontDeskMemberApiPath } from '../src/lib/front-desk-fetch';
import {
  approvalNeedsDecision,
  decodeRouteSegment,
  degradedSources,
  entityHref,
  inboxHrefForApproval,
  isWorkspaceKind,
  kindListHref,
  listQueryFromSearch,
  loadErrorFromStatus,
  narrowingEntries,
  nodeLineage,
  statusFacets,
  summaryLabelIndex,
  workspaceApiPath,
  type GraphNode,
  type WorkspaceGraphSummary,
} from '../src/lib/workspace-view';

describe('workspace hrefs', () => {
  it('encodes ids as one segment so task ids with "/" round-trip', () => {
    const href = entityHref('task', 'MSN-1/step a');
    expect(href).toBe('/w/task/MSN-1%2Fstep%20a');
    expect(decodeRouteSegment(href.split('/')[3])).toBe('MSN-1/step a');
    expect(decodeRouteSegment('already/decoded')).toBe('already/decoded');
    expect(decodeRouteSegment('%E0%A4%A')).toBe('%E0%A4%A');
    expect(decodeRouteSegment(undefined)).toBe('');
  });

  it('builds list hrefs with only set narrowing', () => {
    // MSN-SHELL-IA §1: list pages live under the top-level destinations.
    expect(kindListHref('mission')).toBe('/work');
    expect(kindListHref('mission', { tenant: 'acme', project_id: '' })).toBe('/work?tenant=acme');
    expect(kindListHref('work_item', { tenant: 'acme' })).toBe('/work?tab=items&tenant=acme');
    expect(kindListHref('actor')).toBe('/org?tab=people');
  });

  it('links pending approvals to their Inbox card', () => {
    expect(inboxHrefForApproval('ap 1')).toBe('/inbox?reason=approval&request=ap+1');
    expect(approvalNeedsDecision('pending')).toBe(true);
    expect(approvalNeedsDecision('approved')).toBe(false);
  });

  it('accepts only graph kinds', () => {
    expect(isWorkspaceKind('work_item')).toBe(true);
    expect(isWorkspaceKind('work-items')).toBe(false);
    expect(isWorkspaceKind(undefined)).toBe(false);
  });
});

describe('workspace API paths', () => {
  it('drops empty parameters and stays on the member allowlist (task ids included)', () => {
    const path = workspaceApiPath('get', { kind: 'task', id: 'MSN-1/t1', tenant: '' });
    expect(path).toBe('/api/v1/workspace/get?kind=task&id=MSN-1%2Ft1');
    expect(isFrontDeskMemberApiPath(path)).toBe(true);
    expect(isFrontDeskMemberApiPath(workspaceApiPath('summary'))).toBe(true);
  });

  it('maps page query to only the fields the list operation accepts', () => {
    const query = listQueryFromSearch(
      new URLSearchParams(
        'tenant=personal&organizationId=org-1&project_id=p-1&q=%20launch%20&status=blocked&tier=x'
      )
    );
    expect(query).toEqual({
      organization_id: 'org-1',
      project_id: 'p-1',
      q: 'launch',
      status: 'blocked',
    });
    expect(listQueryFromSearch(new URLSearchParams('tenant=acme')).tenant).toBe('acme');
    expect(listQueryFromSearch(new URLSearchParams('tenant=shared')).tenant).toBeUndefined();
    expect(narrowingEntries(query)).toEqual([
      { kind: 'organization', id: 'org-1' },
      { kind: 'project', id: 'p-1' },
    ]);
  });

  it('classifies load failures by HTTP status', () => {
    expect([401, 403, 404, 500].map(loadErrorFromStatus)).toEqual([
      'signin',
      'forbidden',
      'not_found',
      'failed',
    ]);
  });
});

describe('lineage and facets', () => {
  const summary: WorkspaceGraphSummary = {
    generatedAt: '2026-11-03T00:00:00Z',
    counts: {
      tenant: 1,
      organization: 1,
      project: 1,
      mission: 0,
      task: 0,
      work_item: 0,
      approval: 0,
      actor: 0,
    },
    attention: [],
    tenants: [
      {
        kind: 'tenant',
        id: 'acme',
        label: 'Acme Inc.',
        organizations: [
          {
            kind: 'organization',
            id: 'org-1',
            label: 'Sales',
            projects: [{ kind: 'project', id: 'p-1', label: 'Launch' }],
          },
        ],
      },
    ],
    degraded: [],
  };

  it('names row lineage from the summary tree and falls back to ids', () => {
    const node: GraphNode = {
      kind: 'work_item',
      id: 'wi-1',
      label: 'Draft',
      tenantSlug: 'acme',
      organizationId: 'org-1',
      projectId: 'p-1',
      missionId: 'MSN-9',
    };
    expect(nodeLineage(node, summaryLabelIndex(summary)).map((ref) => ref.label)).toEqual([
      'Acme Inc.',
      'Sales',
      'Launch',
      'MSN-9',
    ]);
    const project: GraphNode = { kind: 'project', id: 'p-1', label: 'Launch', projectId: 'p-1' };
    expect(nodeLineage(project)).toEqual([]);
  });

  it('counts statuses in first-seen order', () => {
    const nodes = ['blocked', 'open', 'blocked', undefined].map((status, i): GraphNode => ({
      kind: 'work_item',
      id: String(i),
      label: String(i),
      status,
    }));
    expect(statusFacets(nodes)).toEqual([
      { status: 'blocked', count: 2 },
      { status: 'open', count: 1 },
    ]);
  });

  it('reports each degraded store once without tenant suffixes', () => {
    expect(
      degradedSources([
        { source: 'organizations:acme' },
        { source: 'organizations:beta' },
        { source: 'approvals' },
      ])
    ).toEqual(['organizations', 'approvals']);
  });
});
