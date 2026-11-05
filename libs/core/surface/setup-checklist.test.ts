import { describe, expect, it } from 'vitest';
import {
  SETUP_CHECKLIST_ORDER,
  buildSetupChecklist,
  collectSetupChecklistSignals,
  type SetupChecklistReaders,
  type SetupChecklistSignals,
} from './setup-checklist.js';
import { invokeSurfaceOperation } from './surface-operation-registry.js';
import type { WorkspaceGraph, WorkspaceGraphSources } from './workspace-graph.js';
import type { SurfaceAuthorizationContext } from './surface-authorization.js';

const empty: SetupChecklistSignals = {
  visibleTenants: 0,
  reasoningMode: 'stub',
  charterInForce: false,
  notificationChannel: false,
  projects: 0,
  missions: 0,
  budget: null,
};

const readers = (over: Partial<SetupChecklistReaders> = {}): SetupChecklistReaders => ({
  reasoningMode: () => 'claude-cli',
  charterInForce: () => true,
  notificationChannel: () => true,
  budget: () => ({ posture: 'warn', daily_cap_usd: 50, mission_cap_usd: 20, uses_default: true }),
  ...over,
});

describe('setup checklist', () => {
  it('keeps the required order and points every step at a settings card', () => {
    const list = buildSetupChecklist(empty);
    expect(list.steps.map((step) => step.id)).toEqual([...SETUP_CHECKLIST_ORDER]);
    expect(list.steps.map((step) => step.id)).toEqual([
      'identity',
      'reasoning',
      'autonomy',
      'notifications',
      'first_project',
      'budget',
      'trial_mission',
    ]);
    expect(list.steps.every((step) => /^[a-z-]+$/.test(step.anchor))).toBe(true);
    expect(list.steps.every((step) => step.estimate_minutes > 0)).toBe(true);
  });

  it('reports progress and the first unfinished step', () => {
    const list = buildSetupChecklist({ ...empty, visibleTenants: 1, reasoningMode: 'claude-cli' });
    expect(list).toMatchObject({ done: 2, total: 7, complete: false, next: 'autonomy' });
  });

  it('treats a stub or missing reasoning backend as not set up', () => {
    for (const mode of ['stub', 'not-installed', 'unknown', '']) {
      expect(buildSetupChecklist({ ...empty, reasoningMode: mode }).steps[1].status).toBe('todo');
    }
  });

  it('says unknown instead of done when a signal cannot be read', () => {
    const list = buildSetupChecklist({ ...empty, notificationChannel: null });
    expect(list.steps.find((step) => step.id === 'notifications')?.status).toBe('unknown');
    expect(list.done).toBe(0);
  });

  it('is complete only when every step is done', () => {
    const list = buildSetupChecklist({
      visibleTenants: 1,
      reasoningMode: 'claude-cli',
      charterInForce: true,
      notificationChannel: true,
      projects: 2,
      missions: 1,
      budget: { posture: 'warn', daily_cap_usd: 50, mission_cap_usd: 20, uses_default: true },
    });
    expect(list).toMatchObject({ done: 7, complete: true });
    expect(list.next).toBeUndefined();
    expect(list.budget?.uses_default).toBe(true);
  });

  it('counts tenants, projects and missions from the viewer-filtered graph only', () => {
    const graph: WorkspaceGraph = {
      generatedAt: '2026-11-05T00:00:00.000Z',
      degraded: [],
      nodes: [
        { kind: 'tenant', id: 'acme', label: 'Acme' },
        { kind: 'project', id: 'PRJ-A', label: 'Launch' },
      ],
    };
    const seen: string[] = [];
    const signals = collectSetupChecklistSignals(
      graph,
      readers({
        charterInForce: (tenant) => {
          seen.push(tenant);
          return false;
        },
        reasoningMode: () => {
          throw new Error('unreadable');
        },
      })
    );
    expect(seen).toEqual(['acme']);
    expect(signals).toMatchObject({
      visibleTenants: 1,
      projects: 1,
      missions: 0,
      charterInForce: false,
      reasoningMode: null,
    });
  });

  it('is served by the surface operation registry within the viewer scope', () => {
    const sources: WorkspaceGraphSources = {
      tenants: () => [{ slug: 'acme' }, { slug: 'beta' }],
      organizations: () => [],
      projects: () => [
        { project_id: 'PRJ-B', name: 'Hidden', tier: 'confidential', tenant_slug: 'beta' },
      ],
      missions: () => [],
      missionDetail: () => ({ tasks: [], staffing: [] }),
      workItems: () => [],
      approvals: () => [],
      members: () => [],
      agents: () => [],
    } as unknown as WorkspaceGraphSources;
    const viewer: SurfaceAuthorizationContext = {
      role: 'readonly',
      tenantSlugs: ['acme'],
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: ['confidential', 'public'],
    } as SurfaceAuthorizationContext;
    const result = invokeSurfaceOperation(
      'setup.checklist',
      {},
      { viewer, sources, setupReaders: readers() }
    );
    expect(result.ok).toBe(true);
    const data = (result as { data: { steps: Array<{ id: string; status: string }> } }).data;
    expect(data.steps.find((step) => step.id === 'identity')?.status).toBe('done');
    // beta's project is outside the viewer scope, so it does not count.
    expect(data.steps.find((step) => step.id === 'first_project')?.status).toBe('todo');
  });
});
