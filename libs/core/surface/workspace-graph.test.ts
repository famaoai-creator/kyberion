import { describe, expect, it } from 'vitest';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import type { SurfaceAuthorizationContext } from './surface-authorization.js';
import {
  goalOf,
  collectWorkspaceGraph,
  filterWorkspaceGraph,
  getGraphEntity,
  listGraphNodes,
  summarizeWorkspaceGraph,
  type WorkspaceGraphSources,
} from './workspace-graph.js';
import { invokeSurfaceOperation, listSurfaceOperations } from './surface-operation-registry.js';

function sources(over: Partial<WorkspaceGraphSources> = {}): WorkspaceGraphSources {
  return {
    tenants: () => [{ slug: 'acme', name: 'Acme Inc' }, { slug: 'beta' }],
    organizations: (tenant) =>
      tenant === 'acme'
        ? [{ id: 'acme-hq', name: 'Acme HQ', status: 'active' }]
        : [{ id: 'beta-org', name: 'Beta' }],
    projects: () => [
      {
        project_id: 'PRJ-A',
        name: 'Launch',
        tier: 'confidential',
        tenant_slug: 'acme',
        organization_id: 'acme-hq',
        status: 'active',
      },
      {
        project_id: 'PRJ-B',
        name: 'Secret',
        tier: 'confidential',
        tenant_slug: 'beta',
        organization_id: 'beta-org',
      },
    ],
    missions: () => [
      {
        id: 'MSN-A1',
        status: 'active',
        tier: 'confidential',
        tenantSlug: 'acme',
        organizationId: 'acme-hq',
        projectId: 'PRJ-A',
        persona: 'worker',
      },
      {
        id: 'MSN-B1',
        status: 'active',
        tier: 'confidential',
        tenantSlug: 'beta',
        organizationId: 'beta-org',
        projectId: 'PRJ-B',
      },
      { id: 'MSN-PUB', status: 'completed', tier: 'public' },
    ],
    missionDetail: (id) =>
      id === 'MSN-A1'
        ? {
            goal: 'Ship the launch site',
            tasks: [
              {
                task_id: 'build',
                status: 'completed',
                description: 'Build it',
                assigned_to: { role: 'implementer' },
              },
            ],
            staffing: [{ actor_id: 'nhi-builder', team_role: 'owner' }],
          }
        : { tasks: [], staffing: [] },
    workItems: () =>
      [
        {
          item_id: 'WI-1',
          title: 'Design page',
          description: '',
          status: 'blocked',
          priority: 'high',
          source: 'mission',
          source_ref: 'mission:MSN-A1:build',
          project_id: 'PRJ-A',
          labels: [],
          dependencies: [],
          version: 1,
          created_at: '2026-11-01T00:00:00Z',
          updated_at: '2026-11-02T00:00:00Z',
          assignee_user_id: 'member-alice',
          context: {
            tenant_slug: 'acme',
            organization_id: 'acme-hq',
            project_id: 'PRJ-A',
            mission_id: 'MSN-A1',
          },
        },
      ] as unknown as WorkItem[],
    approvals: () =>
      [
        {
          id: 'APR-1',
          kind: 'mission_gate',
          storageChannel: 'chronos',
          channel: 'chronos',
          threadTs: 't',
          correlationId: 'c',
          requestedBy: 'nhi-builder',
          requestedAt: '2026-11-02T01:00:00Z',
          status: 'pending',
          title: 'Publish site',
          requestedByContext: { missionId: 'MSN-A1' },
        },
        {
          id: 'APR-SYS',
          kind: 'secret_mutation',
          storageChannel: 'system',
          channel: 'system',
          threadTs: 't',
          correlationId: 'c',
          requestedBy: 'system',
          requestedAt: '2026-11-02T01:00:00Z',
          status: 'pending',
          title: 'Rotate key',
        },
      ] as unknown as ApprovalRequestRecord[],
    agents: () => [
      {
        nhi_id: 'nhi-builder',
        display_name: 'Builder agent',
        kind: 'worker',
        accountable_human_id: 'member-alice',
        affiliation: {
          tenant_slug: 'acme',
          organization_id: 'acme-hq',
          project_id: 'PRJ-A',
          mission_id: 'MSN-A1',
        },
      },
    ],
    members: () => [
      {
        member_id: 'member-alice',
        display_name: 'Alice',
        status: 'active',
        memberships: [{ tenant_slug: 'acme', role: 'owner' }],
      },
      {
        member_id: 'member-bob',
        display_name: 'Bob',
        memberships: [{ tenant_slug: 'beta', role: 'viewer' }],
      },
    ],
    ...over,
  };
}

const admin: SurfaceAuthorizationContext = {
  role: 'localadmin',
  tenantSlugs: 'all',
  organizationIds: 'all',
  projectIds: 'all',
  tierAccess: ['confidential', 'public'],
};
const acmeViewer: SurfaceAuthorizationContext = {
  role: 'readonly',
  tenantSlugs: ['acme'],
  organizationIds: 'all',
  projectIds: 'all',
  tierAccess: ['confidential', 'public'],
};

describe('workspace graph', () => {
  it('keeps tier and permission ceilings for member self and tenant-mate admission', () => {
    const graph = collectWorkspaceGraph(sources());
    const self = { ...acmeViewer, tenantSlugs: [] as string[], memberId: 'member-alice' };
    expect(
      getGraphEntity(filterWorkspaceGraph(graph, self), 'actor', 'member-alice')
    ).toBeDefined();
    for (const ceiling of [{ tierAccess: ['public'] }, { permissions: [] }]) {
      expect(
        getGraphEntity(
          filterWorkspaceGraph(graph, { ...self, ...ceiling }),
          'actor',
          'member-alice'
        )
      ).toBeNull();
      expect(
        getGraphEntity(
          filterWorkspaceGraph(graph, { ...acmeViewer, ...ceiling }),
          'actor',
          'member-alice'
        )
      ).toBeNull();
    }
  });

  it('redacts foreign memberships for tenant mates while preserving the member own view', () => {
    const graph = collectWorkspaceGraph(
      sources({
        members: () => [
          {
            member_id: 'member-alice',
            display_name: 'Alice',
            status: 'active',
            memberships: [
              { tenant_slug: 'acme', role: 'owner' },
              { tenant_slug: 'beta', role: 'admin' },
            ],
          },
        ],
      })
    );
    const mate = getGraphEntity(filterWorkspaceGraph(graph, acmeViewer), 'actor', 'member-alice')!;
    expect(mate.node.facts?.tenants).toBe('acme');
    expect(mate.node.facts?.roles).toBe('acme:owner');
    const self = getGraphEntity(
      filterWorkspaceGraph(graph, { ...acmeViewer, tenantSlugs: [], memberId: 'member-alice' }),
      'actor',
      'member-alice'
    )!;
    expect(self.node.facts?.roles).toBe('acme:owner,beta:admin');
    expect(getGraphEntity(graph, 'actor', 'member-alice')!.node.facts?.tenants).toBe('acme,beta');
  });
  it('joins every store into one linked node set', () => {
    const graph = collectWorkspaceGraph(sources());
    const kinds = new Set(graph.nodes.map((n) => n.kind));
    expect([...kinds].sort()).toEqual([
      'actor',
      'approval',
      'mission',
      'organization',
      'project',
      'tenant',
      'work_item',
    ]);
    const approval = graph.nodes.find((n) => n.id === 'APR-1')!;
    // The approval inherits tenant / org / project from the mission it gates.
    expect(approval).toMatchObject({
      tenantSlug: 'acme',
      organizationId: 'acme-hq',
      projectId: 'PRJ-A',
      missionId: 'MSN-A1',
    });
    expect(graph.degraded).toEqual([]);
  });

  it('reports a failing store as degraded instead of returning an empty graph', () => {
    const graph = collectWorkspaceGraph(
      sources({
        workItems: () => {
          throw new Error('ledger unreadable');
        },
      })
    );
    expect(graph.degraded).toEqual([{ source: 'work_items', reason: 'ledger unreadable' }]);
    expect(graph.nodes.some((n) => n.kind === 'mission')).toBe(true);
  });

  it('filters rows per viewer: other tenants and untenanted system records disappear', () => {
    const graph = filterWorkspaceGraph(collectWorkspaceGraph(sources()), acmeViewer);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain('MSN-A1');
    expect(ids).toContain('MSN-PUB'); // public tier
    expect(ids).toContain('member-alice');
    expect(ids).not.toContain('MSN-B1');
    expect(ids).not.toContain('PRJ-B');
    expect(ids).not.toContain('member-bob');
    expect(ids).not.toContain('APR-SYS');
  });

  it('builds the lineage, children and actors of a mission', () => {
    const graph = collectWorkspaceGraph(sources());
    const view = getGraphEntity(graph, 'mission', 'MSN-A1', sources())!;
    expect(view.lineage.map((r) => `${r.kind}:${r.label}`)).toEqual([
      'tenant:Acme Inc',
      'organization:Acme HQ',
      'project:Launch',
    ]);
    expect(view.goal).toBe('Ship the launch site');
    expect(view.children.task?.map((t) => t.facts?.task_id)).toEqual(['build']);
    expect(view.children.work_item?.map((w) => w.id)).toEqual(['WI-1']);
    expect(view.children.approval?.map((a) => a.id)).toEqual(['APR-1']);
    expect(view.actors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: 'nhi-builder',
          role: 'owner',
          label: 'Builder agent',
          known: true,
        }),
        expect.objectContaining({ actorId: 'worker', role: 'persona', known: false }),
      ])
    );
  });

  it('shows what an actor is involved in', () => {
    const graph = collectWorkspaceGraph(sources());
    const alice = getGraphEntity(graph, 'actor', 'member-alice')!;
    expect(alice.involvements?.map((n) => n.id).sort()).toEqual(['WI-1', 'nhi-builder']);
    const builder = getGraphEntity(graph, 'actor', 'nhi-builder')!;
    expect(builder.lineage.map((r) => r.id)).toEqual(['acme', 'acme-hq', 'PRJ-A', 'MSN-A1']);
    expect(builder.involvements?.map((n) => n.id)).toEqual(
      expect.arrayContaining(['APR-1', 'MSN-A1'])
    );
  });

  it('summarizes the tree and attention queue', () => {
    const summary = summarizeWorkspaceGraph(
      filterWorkspaceGraph(collectWorkspaceGraph(sources()), acmeViewer)
    );
    expect(summary.tenants).toEqual([
      {
        kind: 'tenant',
        id: 'acme',
        label: 'Acme Inc',
        organizations: [
          {
            kind: 'organization',
            id: 'acme-hq',
            label: 'Acme HQ',
            projects: [{ kind: 'project', id: 'PRJ-A', label: 'Launch' }],
          },
        ],
      },
    ]);
    expect(summary.attention.map((n) => n.id).sort()).toEqual(['APR-1', 'WI-1']);
    expect(summary.counts.mission).toBe(2);
  });

  it('lists with narrowing filters and text search', () => {
    const graph = collectWorkspaceGraph(sources());
    expect(listGraphNodes(graph, { kind: 'mission', projectId: 'PRJ-A' }).map((n) => n.id)).toEqual(
      ['MSN-A1']
    );
    expect(listGraphNodes(graph, { q: 'launch' }).map((n) => n.id)).toContain('PRJ-A');
    expect(
      listGraphNodes(graph, { kind: 'actor', tenantSlug: 'acme' })
        .map((n) => n.id)
        .sort()
    ).toEqual(['member-alice', 'nhi-builder']);
  });
});

describe('workspace graph naming', () => {
  it('names a mission by its intent, skipping boilerplate results', () => {
    expect(goalOf({ intent: { goal_summary: ' Ship it ' } })).toBe('Ship it');
    expect(goalOf({ outcome_contract: { requested_result: 'Publish the site' } })).toBe(
      'Publish the site'
    );
    expect(
      goalOf({
        outcome_contract: {
          requested_result: 'Deliver mission outcome aligned to company://x/vision',
        },
      })
    ).toBeUndefined();
  });

  it('uses the goal as the mission label and keeps the last event as a fact', () => {
    const graph = collectWorkspaceGraph(
      sources({
        missions: () => [
          {
            id: 'MSN-G',
            status: 'active',
            tier: 'public',
            goal: 'Ship it',
            lastEvent: 'ROUTE (x)',
          },
        ],
      })
    );
    expect(graph.nodes.find((n) => n.id === 'MSN-G')).toMatchObject({
      label: 'Ship it',
      facts: { last_event: 'ROUTE (x)' },
    });
    expect(graph.nodes.find((n) => n.id === 'MSN-G')?.summary).toBeUndefined();
  });

  it('resolves a staffing slug to the agent ActorRef', () => {
    const graph = collectWorkspaceGraph(
      sources({
        agents: () => [
          {
            nhi_id: 'kyberion://agent/acme-hq/builder',
            display_name: 'Builder',
            affiliation: { tenant_slug: 'acme' },
          },
        ],
        missionDetail: () => ({
          tasks: [],
          staffing: [{ actor_id: 'builder', team_role: 'owner' }],
        }),
      })
    );
    const view = getGraphEntity(graph, 'mission', 'MSN-A1', {
      missionDetail: () => ({ tasks: [], staffing: [{ actor_id: 'builder', team_role: 'owner' }] }),
    })!;
    expect(view.actors).toContainEqual(
      expect.objectContaining({
        actorId: 'kyberion://agent/acme-hq/builder',
        role: 'owner',
        label: 'Builder',
        known: true,
      })
    );
  });
});

describe('surface operation registry', () => {
  it('describes each operation with a JSON schema for MCP and HTTP', () => {
    const ops = listSurfaceOperations();
    expect(ops.map((o) => o.id)).toEqual([
      'workspace.summary',
      'workspace.list',
      'workspace.get',
      'workspace.search',
      'setup.checklist',
      'needs-you.list',
      'needs-you.summary',
    ]);
    expect(ops.find((o) => o.id === 'workspace.get')?.inputSchema).toMatchObject({
      type: 'object',
      required: ['kind', 'id'],
    });
  });

  it('a client tenant narrows but never widens the viewer scope', () => {
    const result = invokeSurfaceOperation(
      'workspace.list',
      { kind: 'mission', tenant: 'beta' },
      { viewer: acmeViewer, sources: sources() }
    );
    expect(result).toMatchObject({ ok: true, data: { items: [] } });
    const hidden = invokeSurfaceOperation(
      'workspace.get',
      { kind: 'mission', id: 'MSN-B1' },
      { viewer: acmeViewer, sources: sources() }
    );
    expect(hidden).toMatchObject({ ok: false, status: 404, error_code: 'not_found' });
  });

  it('validates input and rejects unknown operations and fields', () => {
    expect(
      invokeSurfaceOperation(
        'workspace.list',
        { kind: 'planet' },
        { viewer: admin, sources: sources() }
      )
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      invokeSurfaceOperation(
        'workspace.list',
        { kind: 'mission', extra: 1 },
        { viewer: admin, sources: sources() }
      )
    ).toMatchObject({ ok: false, status: 400 });
    expect(invokeSurfaceOperation('nope', {}, { viewer: admin, sources: sources() })).toMatchObject(
      { ok: false, status: 404 }
    );
  });

  it('coerces query-string numbers', () => {
    const result = invokeSurfaceOperation(
      'workspace.list',
      { kind: 'mission', limit: '1' },
      { viewer: admin, sources: sources() }
    );
    expect(result.ok && (result.data as { items: unknown[] }).items).toHaveLength(1);
  });

  it('returns a mission with tasks through workspace.get', () => {
    const result = invokeSurfaceOperation(
      'workspace.get',
      { kind: 'mission', id: 'MSN-A1' },
      { viewer: acmeViewer, sources: sources() }
    );
    expect(result.ok).toBe(true);
    expect((result as { data: { children: { task: unknown[] } } }).data.children.task).toHaveLength(
      1
    );
  });
});
