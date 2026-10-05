import { beforeEach, describe, expect, it, vi } from 'vitest';
import type express from 'express';
import type { PresenceStudioViewerContext } from './security.js';
const f = vi.hoisted(() => ({
  viewer: {
    principalId: 'human:presence-studio-localadmin',
    source: 'loopback',
    tenantSlugs: 'all',
    organizationIds: 'all',
    projectIds: 'all',
  } as PresenceStudioViewerContext,
  approvals: [] as Record<string, unknown>[],
  sessions: [] as Record<string, unknown>[],
  artifacts: [] as Record<string, unknown>[],
  held: [] as Record<string, unknown>[],
  conversation: vi.fn(),
  failApprovals: false,
}));
vi.mock('./security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./security.js')>()),
  resolvePresenceStudioViewerContext: () => f.viewer,
}));
vi.mock('@agent/core/governance/approval-store', () => ({
  listApprovalRequests: () => {
    if (f.failApprovals) throw Error('unavailable');
    return f.approvals;
  },
}));
vi.mock('@agent/core/task/task-session', () => ({ listTaskSessions: () => f.sessions }));
vi.mock('@agent/core/workforce/artifact-record', () => ({
  listArtifactRecords: () => f.artifacts,
}));
vi.mock('./presence-studio-runtime-data.js', () => ({
  cloudflareOsSurface: { snapshot: () => ({ heldActions: f.held }) },
}));
vi.mock('@agent/core/surface/front-desk-conversation-store', () => ({
  readFrontDeskConversationWork: f.conversation,
  presenceFrontDeskConversationViewer: (v: unknown) => v,
}));
import { readWorkHome, workHomeRecordInScope } from './work-home-source.js';
import { toFrontDeskViewerScope } from './security.js';
function read(query: Record<string, unknown> = {}) {
  return readWorkHome({ query } as unknown as express.Request);
}
const scoped = {
  tier: 'confidential',
  tenant_slug: 'alpha-team',
  organization_id: 'org-a',
  project_id: 'project-a',
};
beforeEach(() => {
  f.viewer = {
    principalId: 'human:presence-studio-localadmin',
    source: 'loopback',
    tenantSlugs: 'all',
    organizationIds: 'all',
    projectIds: 'all',
  };
  f.approvals = [];
  f.sessions = [];
  f.artifacts = [];
  f.held = [];
  f.failApprovals = false;
  f.conversation.mockReset();
  f.conversation.mockReturnValue({ sessionId: 'fixture', tasks: [] });
});
describe('work home source authorization and completeness', () => {
  it('does not invoke conversation reader for remote tokens while retaining allowed work', () => {
    f.viewer = {
      ...f.viewer,
      source: 'token',
      principalId: 'remote-a',
      tenantSlugs: ['alpha-team'],
    };
    f.approvals = [
      { id: 'a', title: 'Allowed', scope: scoped },
      { id: 'b', title: 'Other tenant', scope: { ...scoped, tenant_slug: 'beta-team' } },
      { id: 'p', title: 'Private', scope: { ...scoped, tier: 'personal' } },
    ];
    const result = read().work_home;
    expect(f.conversation).not.toHaveBeenCalled();
    expect(result.items.map((x) => x.title)).toEqual(['Allowed']);
    expect(result.sources.find((x) => x.id === 'conversation')?.state).toBe('unavailable');
    expect(result.coverage).toBe('partial');
    expect(result.items[0].links).toEqual([]);
  });
  it('narrows tenant organization and project server-side and preserves them in inert links', () => {
    f.sessions = [
      {
        session_id: 'a',
        goal: { summary: 'Allowed' },
        status: 'executing',
        project_context: scoped,
      },
      {
        session_id: 'b',
        goal: { summary: 'Other' },
        status: 'executing',
        project_context: { ...scoped, project_id: 'project-b' },
      },
    ];
    const result = read({
      tenant: 'alpha-team',
      organizationId: 'org-a',
      projectId: 'project-a',
    }).work_home;
    expect(result.items.map((x) => x.title)).toEqual(['Allowed']);
    expect(result.items[0].links[0].href).toBe(
      '/progress?tenant=alpha-team&organizationId=org-a&projectId=project-a#a'
    );
    expect(f.conversation.mock.calls[0][0]).toMatchObject({
      tenantSlugs: ['alpha-team'],
      organizationIds: ['org-a'],
      projectIds: ['project-a'],
    });
  });
  it('rejects widening and malformed selections before any source read', () => {
    f.viewer = { ...f.viewer, tenantSlugs: ['alpha-team'] };
    expect(() => read({ tenant: 'beta-team' })).toThrow();
    expect(() => read({ tenant: ['alpha-team', 'beta-team'] })).toThrow();
    expect(f.conversation).not.toHaveBeenCalled();
  });
  it('rejects personal tiers and conflicting legacy claims, even with all organization/project scope', () => {
    const viewer = toFrontDeskViewerScope({
      ...f.viewer,
      source: 'token',
      tenantSlugs: ['alpha-team'],
    });
    expect(workHomeRecordInScope(viewer, { scope: scoped })).toBe(true);
    expect(workHomeRecordInScope(viewer, { scope: { ...scoped, tier: 'personal' } })).toBe(false);
    expect(
      workHomeRecordInScope(viewer, {
        tenant_slug: 'alpha-team',
        scope: { ...scoped, tenant_slug: 'beta-team' },
      })
    ).toBe(false);
    expect(
      workHomeRecordInScope(viewer, {
        scope: scoped,
        project_context: { tenant_slug: 'beta-team' },
      })
    ).toBe(false);
    expect(workHomeRecordInScope(viewer, { tenant_slug: 'alpha-team' })).toBe(false);
    expect(workHomeRecordInScope(viewer, { scope: null })).toBe(false);
    expect(workHomeRecordInScope(viewer, { scope: { ...scoped, scope_kind: 'system' } })).toBe(
      false
    );
    expect(workHomeRecordInScope(viewer, { scope: scoped, tenant_id: 'beta-team' })).toBe(false);
  });
  it('does not expose raw internal history/output paths anywhere in the home response', () => {
    const sentinel = '/private/internal/active/shared/artifacts/secret-result.txt';
    f.sessions = [
      {
        session_id: 'a',
        goal: { summary: 'Capture' },
        status: 'completed',
        history: [{ ts: '2026-10-05T12:00:00Z', text: 'Output stored at ' + sentinel }],
      },
    ];
    const windows = 'C:\\private\\receipt.json';
    f.artifacts = [
      { artifact_id: 'win', kind: 'doc', path: windows },
      { artifact_id: 'posix', kind: 'doc', path: sentinel },
    ];
    const result = read();
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(result.work_home.items.find((item) => item.source_id === 'win')?.title).toBe(
      'receipt.json'
    );
  });
  it('keeps failed sources unavailable rather than reporting empty success', () => {
    f.failApprovals = true;
    const result = read().work_home;
    expect(result.sources.find((x) => x.id === 'approvals')).toMatchObject({
      state: 'unavailable',
      total: null,
    });
    expect(result.coverage).toBe('partial');
  });
  it('treats a full 50-record held-action window as partial even when all shown rows are terminal', () => {
    f.held = Array.from({ length: 50 }, (_, i) => ({ id: String(i), status: 'applied' }));
    const result = read().work_home;
    expect(result.sources.find((x) => x.id === 'held_actions')).toMatchObject({
      state: 'partial',
      total: null,
      shown: 0,
    });
    expect(result.coverage).toBe('partial');
  });
  it('does not link narrowed decisions to a broader workbench', () => {
    f.approvals = [{ id: 'a', title: 'Approval', scope: scoped }];
    const result = read({ tenant: 'alpha-team' }).work_home;
    expect(result.attention[0].links).toEqual([]);
    expect(result.attention[0].next_step_key).toBe(
      'front_desk:work_home_decision_scope_unavailable'
    );
    expect(read().work_home.attention[0].links[0].href).toBe('/work#approval-panel');
  });
  it('scope preference identifiers bind principal and every selection', () => {
    const first = read().work_home.scope_id;
    f.viewer = { ...f.viewer, principalId: 'other' };
    expect(read().work_home.scope_id).not.toBe(first);
    const second = read().work_home.scope_id;
    expect(read({ tenant: 'alpha-team' }).work_home.scope_id).not.toBe(second);
  });
});
