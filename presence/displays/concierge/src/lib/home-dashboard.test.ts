import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  missions: vi.fn((): unknown[] => []),
  board: vi.fn(() => ({ entries: [] as Array<{ agent_id: string; status: string }> })),
  runtime: vi.fn((): unknown[] => []),
  company: vi.fn(() => ({ company_id: 'acme-org', tenant_slug: 'acme', name: 'Acme' })),
  orgView: vi.fn((): unknown => ({ purpose: null })),
  cost: vi.fn((): unknown => ({
    totalUsd: 12.345,
    budgetUsd: 100,
    remainingUsd: 87.66,
    overBudget: false,
    costComplete: true,
  })),
  deliverables: vi.fn((): unknown[] => []),
}));

vi.mock('./ops/su-surface-data', () => ({
  buildMissionHistoryItems: mocks.missions,
  collectCostSummary: mocks.cost,
}));
vi.mock('./ops/deliverable-inbox', () => ({ collectDeliverableInbox: mocks.deliverables }));
vi.mock('./ops/ops-viewer', () => ({
  withViewerExecutionContext: (_viewer: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/agent/agent-activity-board', () => ({
  buildAgentActivityBoard: mocks.board,
}));
vi.mock('@agent/core/agent/agent-runtime-supervisor', () => ({
  listAgentRuntimeSnapshots: mocks.runtime,
}));
vi.mock('@agent/core/company', () => ({ resolveCompany: mocks.company }));
vi.mock('@agent/core/organization/organization-operating-model-management', () => ({
  buildOrganizationManagementView: mocks.orgView,
}));
vi.mock('@agent/core/foundation', () => ({ getRegisteredEnvText: () => '' }));

import {
  collectHomeDashboard,
  composeHomeDashboard,
  deliverableDisplayTitle,
  missionDisplayTitle,
} from './home-dashboard';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function mission(
  id: string,
  status: string,
  updatedHoursAgo: number,
  durationHours = 2,
  goalSummary = `Goal of ${id}`
) {
  return {
    missionId: id,
    status,
    tier: 'confidential',
    artifactKinds: [],
    artifactCount: 0,
    updatedAt: hoursAgo(updatedHoursAgo),
    startedAt: hoursAgo(updatedHoursAgo + durationHours),
    goalSummary,
  } as never;
}

const viewer = (tenantSlugs: string[] | 'all' = 'all') =>
  ({
    role: 'localadmin',
    tenantSlugs,
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['public', 'confidential'],
    source: 'loopback',
  }) as never;

describe('composeHomeDashboard', () => {
  it('buckets throughput, failure rate and duration over the last 7 days vs the 7 before', () => {
    const home = composeHomeDashboard({
      now: NOW,
      failed: [],
      missions: [
        mission('MSN-A', 'completed', 1, 4), // today
        mission('MSN-B', 'completed', 2, 2), // today
        mission('MSN-C', 'failed', 3), // today
        mission('MSN-D', 'archived', 30, 10), // 1 day ago
        mission('MSN-E', 'completed', 24 * 9, 6), // previous window
        mission('MSN-F', 'failed', 24 * 10), // previous window
        mission('MSN-G', 'completed', 24 * 20), // outside both windows
        mission('MSN-H', 'active', 1),
        mission('MSN-I', 'validating', 1),
        mission('MSN-J', 'planned', 1),
        mission('MSN-K', 'paused', 5),
      ],
    });
    expect(home.missions.throughput).toEqual([0, 0, 0, 0, 0, 1, 2]);
    expect(home.missions.throughputTotal).toBe(3);
    expect(home.missions.throughputPrevious).toBe(1);
    expect(home.missions.open).toEqual({ active: 2, planned: 1, paused: 1, failed: 2 });
    expect(home.health.failureRate.slice(5)).toEqual([0, 0.333]);
    expect(home.health.failureRate[0]).toBeNull();
    expect(home.health.failureRateCurrent).toBe(0.25);
    expect(home.health.failureRatePrevious).toBe(0.5);
    expect(home.health.durationHours.slice(5)).toEqual([10, 3]);
    expect(home.health.durationCurrent).toBe(4);
    expect(home.health.durationPrevious).toBe(6);
  });

  it('lists the newest blocked missions by goal, never by id', () => {
    const home = composeHomeDashboard({
      now: NOW,
      failed: [],
      missions: [
        mission('MSN-1', 'paused', 10),
        mission('MSN-2', 'failed', 1, 1, 'MSN-2: Ship the report'),
        mission('MSN-3', 'paused', 5),
        mission('MSN-4', 'failed', 20),
      ],
    });
    expect(home.missions.blockedTotal).toBe(4);
    expect(home.missions.blocked.map((m) => m.id)).toEqual(['MSN-2', 'MSN-3', 'MSN-1']);
    expect(home.missions.blocked[0]!.title).toBe('Ship the report');
  });

  it('gives every agent one state, the most attention-worthy first', () => {
    const home = composeHomeDashboard({
      now: NOW,
      failed: [],
      agentEntries: [
        { agent_id: 'a', status: 'in_progress' },
        { agent_id: 'b', status: 'in_progress' },
        { agent_id: 'b', status: 'review' },
        { agent_id: 'c', status: 'ready' },
        { agent_id: 'd', status: 'in_progress' },
        { agent_id: 'unassigned', status: 'ready' },
      ],
      erroredAgents: ['d', 'e'],
    });
    expect(home.agents).toEqual({
      working: 1,
      waiting: 1,
      error: 2,
      idle: 1,
      total: 5,
      unassignedItems: 1,
    });
  });

  it('shows the key results furthest from target first, capped at five', () => {
    const home = composeHomeDashboard({
      now: NOW,
      failed: [],
      organization: {
        state: 'ready',
        name: 'Acme',
        keyResults: [
          { title: 'Met', target: 10, progress: 1 },
          { title: 'Unmeasured', target: 10 },
          { title: 'Behind', target: 10, progress: 0.2, value: 2, unit: 'deals' },
          { title: 'Close', target: 10, progress: 0.8 },
          { title: 'Mid', target: 10, progress: 0.5 },
          { title: 'Extra', target: 10, progress: 0.9 },
        ],
      },
    });
    expect(home.krs.state).toBe('ready');
    expect(home.krs.items.map((kr) => kr.title)).toEqual([
      'Behind',
      'Mid',
      'Close',
      'Extra',
      'Met',
    ]);
    expect(home.krs.items[0]).toMatchObject({ percent: 20, status: 'off_track', value: 2 });
  });

  it('distinguishes an organization without objectives from no organization', () => {
    expect(
      composeHomeDashboard({
        now: NOW,
        failed: [],
        organization: { state: 'ready', keyResults: [] },
      }).krs.state
    ).toBe('no_objectives');
    expect(composeHomeDashboard({ now: NOW, failed: [] }).krs.state).toBe('no_organization');
  });

  it('keeps the five newest present deliverables with a readable title', () => {
    const home = composeHomeDashboard({
      now: NOW,
      failed: [],
      missions: [mission('MSN-X', 'completed', 1, 1, 'Quarterly review')],
      deliverables: [
        {
          artifactId: 'a1',
          kind: 'pdf',
          path: 'out/q3-sales_summary.pdf',
          updatedAt: hoursAgo(1),
          missionId: 'msn-x',
        },
        { artifactId: 'a2', kind: 'doc', updatedAt: hoursAgo(2), missing: true },
        ...[3, 4, 5, 6, 7].map((n) => ({
          artifactId: `a${n}`,
          kind: 'md',
          path: `notes-${n}.md`,
          updatedAt: hoursAgo(n),
        })),
      ] as never,
    });
    expect(home.deliverables.map((d) => d.id)).toEqual(['a1', 'a3', 'a4', 'a5', 'a6']);
    expect(home.deliverables[0]).toMatchObject({
      title: 'q3 sales summary',
      missionTitle: 'Quarterly review',
    });
  });

  it('marks health unavailable when the mission read failed', () => {
    const home = composeHomeDashboard({ now: NOW, failed: ['missions'] });
    expect(home.unavailable.sort()).toEqual(['health', 'missions']);
  });
});

describe('display titles', () => {
  it('never falls back to a raw id or path', () => {
    expect(missionDisplayTitle({})).toBe('');
    expect(missionDisplayTitle({ goalSummary: 'MSN-ABC-1: Do it' })).toBe('Do it');
    expect(deliverableDisplayTitle({ kind: 'pdf' })).toBe('');
    expect(deliverableDisplayTitle({ kind: 'pdf', path: 'a/b/final_report.pdf' })).toBe(
      'final report'
    );
  });
});

describe('collectHomeDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.missions.mockReturnValue([]);
    mocks.board.mockReturnValue({ entries: [] });
  });

  it('reads each source once, scoped to the viewer', () => {
    mocks.missions.mockReturnValue([mission('MSN-A', 'active', 1)]);
    const home = collectHomeDashboard(viewer(['acme']), NOW);
    expect(home.unavailable).toEqual([]);
    expect(mocks.missions).toHaveBeenCalledTimes(1);
    expect(mocks.missions).toHaveBeenCalledWith(expect.objectContaining({ tenantSlugs: ['acme'] }));
    expect(mocks.cost).toHaveBeenCalledWith(
      expect.objectContaining({ missionIds: ['MSN-A'], scopeFilter: { tenant_slugs: ['acme'] } })
    );
    expect(mocks.deliverables).toHaveBeenCalledWith(
      expect.objectContaining({ tenantSlugs: ['acme'] })
    );
    expect(mocks.company).toHaveBeenCalledWith('acme');
    expect(home.cost).toMatchObject({ totalUsd: 12.35, budgetUsd: 100, complete: true });
  });

  it('turns a failing source into an unavailable tile, never a zero', () => {
    mocks.missions.mockImplementation(() => {
      throw new Error('store down');
    });
    mocks.deliverables.mockImplementation(() => {
      throw new Error('artifacts down');
    });
    const home = collectHomeDashboard(viewer(['acme']), NOW);
    // A scoped cost depends on the visible missions, so it is unavailable too.
    expect(home.unavailable.sort()).toEqual(['cost', 'deliverables', 'health', 'missions']);
    expect(home.cost).toBeNull();
    expect(mocks.cost).not.toHaveBeenCalled();
  });

  it('shows no organization KRs for a multi-company or project-scoped viewer', () => {
    collectHomeDashboard(viewer(['acme', 'beta']), NOW);
    expect(mocks.company).not.toHaveBeenCalled();
    collectHomeDashboard({ ...(viewer('all') as object), projectIds: ['p1'] } as never, NOW);
    expect(mocks.company).not.toHaveBeenCalled();
  });
});
