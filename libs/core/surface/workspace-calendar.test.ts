import { describe, expect, it } from 'vitest';
import type { ActionItem } from '../meeting/action-item-store.js';
import type {
  OrganizationOperationRecord,
  OrganizationOperationRun,
} from '../organization/organization-operating-model.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import type { SurfaceAuthorizationContext } from './surface-authorization.js';
import { invokeSurfaceOperation } from './surface-operation-registry.js';
import {
  parseWorkspaceCalendarRange,
  type OrganizationScope,
  type WorkspaceCalendarEntry,
  type WorkspaceCalendarSources,
} from './workspace-calendar.js';
import type { WorkspaceGraphSources } from './workspace-graph.js';

const workItem = (id: string, tenant: string, org: string, extra: Partial<WorkItem>) =>
  ({
    item_id: id,
    title: id,
    description: '',
    status: 'ready',
    priority: 'normal',
    source: 'local',
    source_ref: id,
    project_id: 'PRJ',
    labels: [],
    dependencies: [],
    version: 1,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    context: { tenant_slug: tenant, organization_id: org, project_id: 'PRJ' },
    ...extra,
  }) as WorkItem;

const graphSources: WorkspaceGraphSources = {
  tenants: () => [{ slug: 'acme' }, { slug: 'beta' }],
  organizations: (tenant) =>
    tenant === 'acme' ? [{ id: 'acme-hq', name: 'Acme HQ' }] : [{ id: 'beta-org', name: 'Beta' }],
  projects: () => [],
  missions: () => [
    {
      id: 'MSN-A',
      status: 'active',
      tier: 'confidential',
      tenantSlug: 'acme',
      organizationId: 'acme-hq',
    },
    {
      id: 'MSN-B',
      status: 'active',
      tier: 'confidential',
      tenantSlug: 'beta',
      organizationId: 'beta-org',
    },
    {
      id: 'MSN-A-PRJ',
      status: 'active',
      tier: 'confidential',
      tenantSlug: 'acme',
      organizationId: 'acme-hq',
      projectId: 'PRJ',
    },
    {
      id: 'MSN-A-OLD',
      status: 'archived',
      tier: 'confidential',
      tenantSlug: 'acme',
      organizationId: 'acme-hq',
    },
  ],
  missionDetail: () => ({ tasks: [], staffing: [] }),
  workItems: () => [
    workItem('WI-A', 'acme', 'acme-hq', { due_date: '2026-11-25' }),
    workItem('WI-A-SPAN', 'acme', 'acme-hq', { start_date: '2026-10-20', due_date: '2026-12-20' }),
    workItem('WI-A-OUT', 'acme', 'acme-hq', { due_date: '2027-01-15' }),
    workItem('WI-A-START', 'acme', 'acme-hq', { start_date: '2026-11-10' }),
    workItem('WI-B', 'beta', 'beta-org', { due_date: '2026-11-25' }),
  ],
  approvals: () => [],
  agents: () => [],
  members: () => [],
};

const operation = (over: Partial<OrganizationOperationRecord>): OrganizationOperationRecord =>
  ({
    operation_id: 'month-close',
    organization_id: 'acme-hq',
    name: 'Month-end close',
    operation_type: 'routine',
    owner_role: 'finance',
    trigger: { kind: 'schedule', expression: '0 9 * * 1', timezone: 'Asia/Tokyo' },
    deadline: { kind: 'business_day_of_month', business_day: 3, time: '17:00' },
    automation_boundary: {
      allowed_actions: [],
      approval_required_actions: [],
      forbidden_actions: [],
    },
    escalation_path: [],
    evidence_outputs: [],
    execution_target: { kind: 'runbook' },
    tier: 'confidential',
    tenant_slug: 'acme',
    status: 'active',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  }) as OrganizationOperationRecord;

function calendarSources(
  runs: OrganizationOperationRun[] = [],
  actionItems: Record<string, ActionItem[]> = {},
  operationOver: Partial<OrganizationOperationRecord> = {}
) {
  const reads: string[] = [];
  let grants = 0;
  const sources: WorkspaceCalendarSources = {
    withReads: (fn) => {
      grants += 1;
      return fn();
    },
    operations: (scope: OrganizationScope) => {
      reads.push(`operations:${scope.tenantSlug}/${scope.organizationId}`);
      return {
        operations: [operation({ organization_id: scope.organizationId, ...operationOver })],
        states: [
          {
            operation_id: 'month-close',
            organization_id: scope.organizationId,
            tier: 'confidential',
            status: 'succeeded',
            due_status: 'current',
            last_run_at: '2026-11-16T00:30:00Z',
            updated_at: '2026-11-16T00:30:00Z',
          } as never,
        ],
        runs,
      };
    },
    actionItems: (missionId) => {
      reads.push(`action_items:${missionId}`);
      return actionItems[missionId] ?? [];
    },
  };
  return { sources, reads, grants: () => grants };
}

const acmeViewer: SurfaceAuthorizationContext = {
  role: 'readonly',
  tenantSlugs: ['acme'],
  organizationIds: 'all',
  projectIds: 'all',
  tierAccess: ['confidential', 'public'],
};

function calendar(
  input: Record<string, unknown>,
  calendarSourcesValue: WorkspaceCalendarSources,
  viewer: SurfaceAuthorizationContext = acmeViewer
) {
  return invokeSurfaceOperation('workspace.calendar', input, {
    viewer,
    sources: graphSources,
    calendarSources: calendarSourcesValue,
    calendarNow: new Date('2026-11-21T03:00:00Z'),
  }) as
    | { ok: true; data: { entries: WorkspaceCalendarEntry[]; degraded: string[] } }
    | { ok: false; status: number };
}

const actionItem = (over: Partial<ActionItem>): ActionItem =>
  ({
    item_id: 'ai-1',
    mission_id: 'MSN-A',
    title: 'Send the quote',
    assignee: { kind: 'operator_self' },
    status: 'pending',
    created_at: '2026-11-01T00:00:00Z',
    ...over,
  }) as ActionItem;

describe('workspace.calendar', () => {
  it('reads operations and action items only for organizations and missions the viewer can see', () => {
    const { sources, reads } = calendarSources([], {
      'MSN-A': [actionItem({ due_at: '2026-11-27T03:00:00Z' })],
      'MSN-B': [actionItem({ mission_id: 'MSN-B', item_id: 'ai-b', due_at: '2026-11-27' })],
    });
    const result = calendar({ from: '2026-11-01', to: '2026-11-30' }, sources);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Archived missions are not read; one store grant covers the whole request.
    expect(reads.sort()).toEqual([
      'action_items:MSN-A',
      'action_items:MSN-A-PRJ',
      'operations:acme/acme-hq',
    ]);
    const ids = result.data.entries.map((entry) => entry.id);
    expect(
      ids.some((id) => id.includes('beta') || id.includes('WI-B') || id.includes('MSN-B'))
    ).toBe(false);
    expect(result.data.entries.find((entry) => entry.source === 'action_item')).toMatchObject({
      date: '2026-11-27',
      done: false,
      link: { kind: 'mission', id: 'MSN-A' },
      tenantSlug: 'acme',
    });
  });

  it('keeps work items whose day or span touches the range', () => {
    const { sources } = calendarSources();
    const result = calendar({ from: '2026-11-01', to: '2026-11-30' }, sources);
    if (!result.ok) throw new Error('calendar failed');
    const work = result.data.entries.filter((entry) => entry.source === 'work_item');
    expect(work.map((entry) => entry.link.id).sort()).toEqual(['WI-A', 'WI-A-SPAN', 'WI-A-START']);
    expect(work.find((entry) => entry.link.id === 'WI-A-SPAN')).toMatchObject({
      date: '2026-12-20',
      startDate: '2026-10-20',
    });
  });

  it('places the monthly business-day deadline and judges past periods by their runs', () => {
    // Business day 3: 2026-10-05 (Mon; 10-03/04 weekend) and 2026-11-05 (Thu; 11-03 holiday).
    const { sources } = calendarSources([
      {
        run_id: 'r1',
        operation_id: 'month-close',
        organization_id: 'acme-hq',
        tier: 'confidential',
        status: 'succeeded',
        started_at: '2026-10-05T05:00:00Z',
        completed_at: '2026-10-05T06:00:00Z',
        recorded_at: '2026-10-05T06:00:00Z',
      } as OrganizationOperationRun,
    ]);
    const result = calendar({ from: '2026-10-01', to: '2026-12-31' }, sources);
    if (!result.ok) throw new Error('calendar failed');
    const deadlines = result.data.entries.filter((entry) => entry.source === 'operation_deadline');
    expect(deadlines.map((entry) => entry.date)).toEqual([
      '2026-10-05',
      '2026-11-05',
      '2026-12-03',
    ]);
    expect(deadlines[0]).toMatchObject({ done: true, status: 'met' });
    expect(deadlines[2]).toMatchObject({ done: false, status: 'upcoming' });
    expect(deadlines[0].link).toEqual({ kind: 'organization', id: 'acme-hq' });
    // Weekly Monday 09:00 JST after the 11-16 run: the next run is Monday 11-23 (JST day).
    expect(result.data.entries.find((entry) => entry.source === 'operation_run')).toMatchObject({
      date: '2026-11-23',
      status: 'current',
    });
    // The current period (November) is judged now: no run since the 11-05 deadline → missed.
    expect(deadlines[1]).toMatchObject({ status: 'missed', missed: true });
  });

  it('narrows to a mission without reading organization operations', () => {
    const { sources, reads } = calendarSources();
    calendar({ from: '2026-11-01', to: '2026-11-30', mission_id: 'MSN-A' }, sources);
    expect(reads).toEqual(['action_items:MSN-A']);
  });

  it('keeps work items when the store grant itself fails', () => {
    const { sources } = calendarSources();
    const result = calendar(
      { from: '2026-11-01', to: '2026-11-30' },
      {
        ...sources,
        withReads: () => {
          throw new Error('audit unavailable');
        },
      }
    );
    if (!result.ok) throw new Error('calendar failed');
    expect(result.data.degraded.sort()).toEqual(['action_items', 'agent_sessions', 'operations']);
    expect(result.data.entries.some((entry) => entry.source === 'work_item')).toBe(true);
  });

  it('opens the store grant once per request', () => {
    const { sources, grants } = calendarSources();
    calendar({ from: '2026-11-01', to: '2026-11-30' }, sources);
    expect(grants()).toBe(1);
  });

  it("gives a project-scoped viewer no organization operations and only its projects' missions", () => {
    const { sources, reads } = calendarSources();
    calendar({ from: '2026-11-01', to: '2026-11-30' }, sources, {
      ...acmeViewer,
      projectIds: ['PRJ'],
    });
    expect(reads).toEqual(['action_items:MSN-A-PRJ']);
  });

  it('keeps a start-only work item as a start, never as due', () => {
    const { sources } = calendarSources();
    const result = calendar({ from: '2026-11-01', to: '2026-11-30' }, sources);
    if (!result.ok) throw new Error('calendar failed');
    const start = result.data.entries.find((entry) => entry.link.id === 'WI-A-START');
    expect(start).toMatchObject({ date: '2026-11-10', startDate: '2026-11-10' });
    expect(start).not.toHaveProperty('dueDate');
  });

  it('judges a past period in its own month even far east of UTC (Auckland)', () => {
    // October 2026 deadline met by a run on 10-05; November (current) has no run.
    const { sources } = calendarSources(
      [
        {
          run_id: 'r-oct',
          operation_id: 'month-close',
          organization_id: 'acme-hq',
          tier: 'confidential',
          status: 'succeeded',
          started_at: '2026-10-04T20:00:00Z',
          completed_at: '2026-10-04T21:00:00Z',
          recorded_at: '2026-10-04T21:00:00Z',
        } as OrganizationOperationRun,
      ],
      {},
      { trigger: { kind: 'schedule', expression: '0 9 * * 1', timezone: 'Pacific/Auckland' } }
    );
    const result = calendar({ from: '2026-10-01', to: '2026-10-31' }, sources);
    if (!result.ok) throw new Error('calendar failed');
    const october = result.data.entries.find((entry) => entry.source === 'operation_deadline');
    expect(october).toMatchObject({ date: '2026-10-05', status: 'met', done: true });
  });

  it('sends a timed action item with its instant so the viewer can use their own day', () => {
    const { sources } = calendarSources([], {
      // 2026-11-30T23:30Z is already 12-01 in Tokyo: keep it at the range edge.
      'MSN-A': [actionItem({ due_at: '2026-11-30T23:30:00Z' })],
    });
    const result = calendar({ from: '2026-12-01', to: '2026-12-31' }, sources);
    if (!result.ok) throw new Error('calendar failed');
    expect(result.data.entries.find((entry) => entry.source === 'action_item')).toMatchObject({
      dueAt: '2026-11-30T23:30:00Z',
    });
  });

  it('cannot widen the scope with a client tenant parameter', () => {
    const { sources, reads } = calendarSources();
    const result = calendar({ from: '2026-11-01', to: '2026-11-30', tenant: 'beta' }, sources);
    expect(reads).toEqual([]);
    if (result.ok) expect(result.data.entries).toEqual([]);
  });

  it('reports a failing store as degraded and keeps the rest', () => {
    const { sources } = calendarSources();
    const result = calendar(
      { from: '2026-11-01', to: '2026-11-30' },
      {
        ...sources,
        operations: () => {
          throw new Error('store unreadable');
        },
      }
    );
    if (!result.ok) throw new Error('calendar failed');
    expect(result.data.degraded).toEqual(['operations']);
    expect(result.data.entries.some((entry) => entry.source === 'work_item')).toBe(true);
  });

  it.each([
    [{ from: '2026-11-31', to: '2026-12-01' }],
    [{ from: '2026-12-01', to: '2026-11-01' }],
    [{ from: '2026-01-01', to: '2026-12-31' }],
    [{ from: '2026-11-01' }],
  ])('refuses the range %j with 400', (input) => {
    const { sources } = calendarSources();
    expect(calendar(input, sources)).toMatchObject({ ok: false, status: 400 });
  });

  it('allows a range up to the cap', () => {
    expect(parseWorkspaceCalendarRange('2026-10-01', '2026-12-31')).toEqual({
      from: '2026-10-01',
      to: '2026-12-31',
    });
    expect(() => parseWorkspaceCalendarRange('2026-10-01', '2027-01-01')).toThrow(/at most 92/);
  });
});
