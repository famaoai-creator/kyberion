import { describe, expect, it } from 'vitest';
import { CloudflareOsControlPlane } from './cloudflare-os-control-plane.js';
import { CloudflareOsReadOnlySurface, CloudflareOsSurface } from './cloudflare-os-surface.js';

function action(overrides: Record<string, unknown> = {}) {
  return {
    missionId: 'mission-surface-test',
    submittedBy: 'worker',
    op: 'surface:test-write',
    params: { token: 'must-not-cross-surface' },
    apply: () => ({ ok: true }),
    ...overrides,
  } as never;
}

describe('Cloudflare OS operator surface adapter', () => {
  const operatorAccess = { principalId: 'human:test-operator', tenantSlugs: 'all' as const };

  it('returns mission-filtered summaries without executor payloads', () => {
    const controlPlane = new CloudflareOsControlPlane({ persist: false });
    controlPlane.submitHeldAction(action({ id: 'surface-a' }));
    controlPlane.submitHeldAction(action({ id: 'surface-b', missionId: 'other-mission' }));
    controlPlane.recordObservation({
      missionId: 'mission-surface-test',
      service: 'github',
      resourceRef: 'repo:example/project',
      tier: 'public',
      tenantSlug: 'tenant-a',
      purpose: 'review',
      summary: 'issue list',
    });

    const snapshot = new CloudflareOsSurface(controlPlane).snapshot(
      'mission-surface-test',
      operatorAccess
    );
    expect(snapshot.heldActions.map((item) => item.id)).toEqual(['surface-a']);
    expect(snapshot.observations).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain('must-not-cross-surface');
  });

  it('exposes only the snapshot contract through the default-deny wrapper', () => {
    const controlPlane = new CloudflareOsControlPlane({ persist: false });
    const surface = new CloudflareOsReadOnlySurface(new CloudflareOsSurface(controlPlane));

    expect(typeof surface.snapshot).toBe('function');
    expect('decideHeldAction' in surface).toBe(false);
    expect('applyHeldAction' in surface).toBe(false);
  });

  it('requires an authenticated human actor and applies only approved actions', async () => {
    const controlPlane = new CloudflareOsControlPlane({ persist: false });
    let applied = 0;
    const record = controlPlane.submitHeldAction(
      action({
        id: 'surface-decision',
        apply: () => {
          applied += 1;
          return { ok: true };
        },
      })
    );
    const surface = new CloudflareOsSurface(controlPlane);

    expect(() =>
      surface.decideHeldAction(record.id, 'approved', {
        principalId: 'presence-studio',
        tenantSlugs: 'all',
      })
    ).toThrow('human actor');
    await expect(surface.applyHeldAction(record.id, operatorAccess)).rejects.toThrow(
      'not approved'
    );

    expect(surface.decideHeldAction(record.id, 'approved', operatorAccess)).toMatchObject({
      status: 'approved',
    });
    const appliedSummary = await surface.applyHeldAction(record.id, operatorAccess);
    expect(appliedSummary.status).toBe('applied');
    expect(applied).toBe(1);
  });

  it('filters scoped tenants and redacts observation text and apply errors', async () => {
    const controlPlane = new CloudflareOsControlPlane({ persist: false });
    controlPlane.submitHeldAction(action({ id: 'unscoped-action', tenantSlug: 'tenant-a' }));
    const failing = controlPlane.submitHeldAction({
      ...action({ id: 'failing-action', tenantSlug: 'tenant-b' }),
      apply: () => {
        throw new Error('token=super-secret-value');
      },
    } as never);
    controlPlane.recordObservation({
      missionId: 'mission-surface-test',
      service: 'github',
      resourceRef: 'https://api.example.test/messages?access_token=super-secret-value',
      tier: 'confidential',
      tenantSlug: 'tenant-b',
      purpose: 'review token=super-secret-value',
      summary: 'Authorization: Bearer super-secret-value',
    });

    const surface = new CloudflareOsSurface(controlPlane);
    const scopedAccess = { principalId: 'human:tenant-a', tenantSlugs: ['tenant-a'] };
    const snapshot = surface.snapshot('mission-surface-test', scopedAccess);
    expect(snapshot.heldActions.map((item) => item.id)).toEqual(['unscoped-action']);
    expect(snapshot.observations).toEqual([]);
    const allSnapshot = surface.snapshot('mission-surface-test', operatorAccess);
    expect(allSnapshot.observations[0]?.summary).not.toContain('super-secret-value');
    expect(JSON.stringify(allSnapshot.observations[0])).not.toContain('super-secret-value');

    const allAccess = operatorAccess;
    surface.decideHeldAction(failing.id, 'approved', allAccess);
    const failed = await surface.applyHeldAction(failing.id, allAccess);
    expect(failed).toMatchObject({ status: 'failed', failureRecorded: true });
    expect(JSON.stringify(failed)).not.toContain('super-secret-value');
  });

  it('masks observations above the viewer tier access even inside the tenant scope', () => {
    const controlPlane = new CloudflareOsControlPlane({ persist: false });
    controlPlane.recordObservation({
      missionId: 'mission-tier-mask',
      service: 'private-service',
      resourceRef: 'resource:private',
      tier: 'personal',
      tenantSlug: 'tenant-a',
      purpose: 'private read',
      summary: 'must remain masked',
    });

    const snapshot = new CloudflareOsSurface(controlPlane).snapshot('mission-tier-mask', {
      principalId: 'human:tenant-a',
      tenantSlugs: ['tenant-a'],
      tierAccess: ['public', 'confidential'],
    });

    expect(snapshot.observations).toEqual([]);
    expect(
      new CloudflareOsSurface(controlPlane).snapshot('mission-tier-mask', {
        principalId: 'human:tenant-a',
        tenantSlugs: ['tenant-a'],
      }).observations
    ).toEqual([]);
  });
});
