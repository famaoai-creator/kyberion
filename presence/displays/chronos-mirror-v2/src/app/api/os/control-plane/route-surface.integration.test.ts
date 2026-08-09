import { describe, expect, it } from 'vitest';
import {
  CloudflareOsControlPlane,
  CloudflareOsReadOnlySurface,
  CloudflareOsSurface,
} from '@agent/core';
import { snapshotForViewer } from './route';

function observation(tenantSlug: string) {
  return {
    missionId: 'mission-chronos-integration',
    service: 'test-service',
    resourceRef: `resource:${tenantSlug}`,
    tier: 'confidential' as const,
    tenantSlug,
    purpose: 'operator verification',
    summary: `visible to ${tenantSlug}`,
  };
}

describe('Chronos viewer to OS surface integration', () => {
  it('projects only the registered tenant through the real surface adapter', () => {
    const controlPlane = new CloudflareOsControlPlane({ persist: false });
    controlPlane.recordObservation(observation('tenant-a'));
    controlPlane.recordObservation(observation('tenant-b'));

    const snapshot = snapshotForViewer(
      {
        role: 'readonly',
        source: 'token',
        principalId: 'tenant-a-viewer',
        tenantSlugs: ['tenant-a'],
      },
      'mission-chronos-integration',
      new CloudflareOsReadOnlySurface(new CloudflareOsSurface(controlPlane))
    );

    expect(snapshot.observations).toHaveLength(1);
    expect(snapshot.observations[0]?.tenantSlug).toBe('tenant-a');
    expect(snapshot.observations[0]?.summary).toBe('visible to tenant-a');
  });

  it('masks personal observations for the default Chronos viewer tier access', () => {
    const controlPlane = new CloudflareOsControlPlane({ persist: false });
    controlPlane.recordObservation({
      ...observation('tenant-a'),
      tier: 'personal',
      summary: 'must remain masked',
    });

    const snapshot = snapshotForViewer(
      {
        role: 'readonly',
        source: 'token',
        principalId: 'tenant-a-viewer',
        tenantSlugs: ['tenant-a'],
      },
      'mission-chronos-integration',
      new CloudflareOsReadOnlySurface(new CloudflareOsSurface(controlPlane))
    );

    expect(snapshot.observations).toEqual([]);
  });

  it('rejects an unscoped readonly viewer before the surface is reached', () => {
    expect(() =>
      snapshotForViewer(
        {
          role: 'readonly',
          source: 'token',
          principalId: 'legacy-token',
          tenantSlugs: 'all',
        },
        undefined,
        new CloudflareOsReadOnlySurface(
          new CloudflareOsSurface(new CloudflareOsControlPlane({ persist: false }))
        )
      )
    ).toThrow('tenant-scoped viewer registration');
  });
});
