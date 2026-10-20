import { describe, expect, it, vi } from 'vitest';
import type { DotCharter } from '../dot/dot-charter.js';
import type { SurfaceViewerScope } from './surface-viewer-scope-contract.js';
import { controlWorkspaceAutonomy, readWorkspaceAutonomy } from './workspace-autonomy.js';

const viewer: SurfaceViewerScope = {
  role: 'localadmin',
  source: 'token',
  principalId: 'human:owner',
  tenantSlugs: ['tenant-a'],
  organizationIds: 'all',
  projectIds: 'all',
  tierAccess: ['confidential'],
};
function dot(scope: DotCharter['scope'], id = 'dot-a'): DotCharter {
  return {
    kind: 'dot-charter',
    dot_id: id,
    title: id,
    version: '1.0.0',
    purpose: 'Test',
    status: 'active',
    scope,
    goal: { statement: 'Deliver this scope' },
    attention: { triggers: [{ kind: 'wake', channels: ['inbox'] }] },
    authority: { authority_role: 'organization_operator' },
    notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
    runtime: { heartbeat_id: id },
  };
}
const tenantDot = dot({ tier: 'confidential', tenant_slug: 'tenant-a' });
const orgDot = dot({ ...tenantDot.scope, organization_id: 'org-a' }, 'dot-org');
const projectDot = dot({ ...orgDot.scope, project_id: 'project-a' }, 'dot-project');
const charters = () => [
  tenantDot,
  orgDot,
  projectDot,
  dot({ ...projectDot.scope, tenant_slug: 'tenant-b' }, 'foreign'),
];
const readiness = () => ({ ready: true, errors: [] });
const budget = vi.fn(() => ({
  throttle: 'normal' as const,
  usage: {
    scope: {},
    day: '2026-10-21',
    tokens: 7,
    cost_usd: 0.1,
    by_source: { dots: 7, missions: 0, generation: 0 },
  },
  cap: { daily_token_cap: 100, soft_ratio: 0.8, hard_ratio: 1 },
}));
describe('workplace autonomy boundaries', () => {
  it('controls only the canonically bound operation supervisor, never its sibling or org cadence', () => {
    const bound = { ...orgDot, dot_id: 'weekly-dot', work_binding: { operation_id: 'weekly' } };
    const other = { ...orgDot, dot_id: 'monthly-dot', work_binding: { operation_id: 'monthly' } };
    const selection = {
      kind: 'operation' as const,
      tenant_slug: 'tenant-a',
      organization_id: 'org-a',
      operation_id: 'weekly',
    };
    const transition = vi.fn(() => ({ ...bound, status: 'paused' as const }));
    const ports = { charters: () => [orgDot, bound, other], readiness, budget, transition };
    expect(readWorkspaceAutonomy(selection, viewer, ports).dots.map((entry) => entry.id)).toEqual([
      'weekly-dot',
    ]);
    expect(
      controlWorkspaceAutonomy(selection, viewer, { dot_id: 'weekly-dot', action: 'pause' }, ports)
        .status
    ).toBe('paused');
    expect(transition.mock.calls[0][2]).toHaveProperty('expectedAdmissionScopeHash');
    expect(() =>
      controlWorkspaceAutonomy(selection, viewer, { dot_id: 'monthly-dot', action: 'pause' }, ports)
    ).toThrow();
  });
  it('sanitizes activation collisions that can name another scope', () => {
    const result = readWorkspaceAutonomy({ kind: 'tenant', tenant_slug: 'tenant-a' }, viewer, {
      charters,
      readiness: () => ({ ready: false, errors: ['heartbeat collides with tenant-b-secret-dot'] }),
      budget,
    });
    expect(JSON.stringify(result)).not.toContain('tenant-b-secret-dot');
    expect(result.dots[0].readiness.ready).toBe(false);
  });
  it('never exposes or controls wider dots for a project-limited viewer', () => {
    const restricted = { ...viewer, organizationIds: ['org-a'], projectIds: ['project-a'] };
    const transition = vi.fn();
    for (const selection of [
      { kind: 'tenant' as const, tenant_slug: 'tenant-a' },
      { kind: 'organization' as const, tenant_slug: 'tenant-a', organization_id: 'org-a' },
    ]) {
      expect(
        readWorkspaceAutonomy(selection, restricted, { charters, readiness, budget }).dots
      ).toEqual([]);
      expect(() =>
        controlWorkspaceAutonomy(
          selection,
          restricted,
          {
            dot_id: selection.kind === 'tenant' ? tenantDot.dot_id : orgDot.dot_id,
            action: 'pause',
          },
          { charters, transition }
        )
      ).toThrow();
    }
    expect(transition).not.toHaveBeenCalled();
  });
  it('allows exact project control without exposing sibling aggregate budget', () => {
    const restricted = { ...viewer, organizationIds: ['org-a'], projectIds: ['project-a'] };
    const selection = {
      kind: 'project' as const,
      tenant_slug: 'tenant-a',
      organization_id: 'org-a',
      project_id: 'project-a',
    };
    const transition = vi.fn(() => ({ ...projectDot, status: 'paused' as const }));
    const result = readWorkspaceAutonomy(selection, restricted, { charters, readiness, budget });
    expect(result.dots.map((entry) => entry.id)).toEqual(['dot-project']);
    expect(result.dots[0].budget).toBeNull();
    expect(
      controlWorkspaceAutonomy(
        selection,
        restricted,
        { dot_id: 'dot-project', action: 'pause' },
        { charters, transition }
      ).status
    ).toBe('paused');
    expect(transition).toHaveBeenCalledWith('dot-project', 'paused', expect.anything());
    expect(result.pauseMeaning).toBe('future_wakeups_only');
  });
  it('does not alias an organization cadence to an operation stop switch', () => {
    const selection = {
      kind: 'operation' as const,
      tenant_slug: 'tenant-a',
      organization_id: 'org-a',
      operation_id: 'daily',
    };
    expect(readWorkspaceAutonomy(selection, viewer, { charters, readiness, budget }).dots).toEqual(
      []
    );
    expect(() =>
      controlWorkspaceAutonomy(
        selection,
        viewer,
        { dot_id: 'dot-org', action: 'pause' },
        { charters }
      )
    ).toThrow();
  });
});
