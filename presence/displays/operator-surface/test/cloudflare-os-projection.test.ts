import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { getOsSurfaceAccess } from '@/lib/data';

describe('MOS Cloudflare OS projection scope', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('binds a configured tenant to the server-derived human viewer', () => {
    vi.stubEnv('KYBERION_TENANT', 'tenant-a');
    vi.stubEnv('KYBERION_MOS_PRINCIPAL', 'human:tenant-a-operator');

    expect(getOsSurfaceAccess()).toEqual({
      principalId: 'human:tenant-a-operator',
      tenantSlugs: ['tenant-a'],
    });
  });

  it('fails closed to public-only observation visibility when unscoped', () => {
    vi.stubEnv('KYBERION_TENANT', '');

    expect(getOsSurfaceAccess()).toEqual({
      principalId: 'human:operator-surface-local',
      tenantSlugs: [],
    });
  });

  it('rejects a tenant-bound MOS without an explicit human principal', () => {
    vi.stubEnv('KYBERION_TENANT', 'tenant-a');

    expect(() => getOsSurfaceAccess()).toThrow('KYBERION_MOS_PRINCIPAL');
  });

  it('accepts only http(s) guarded-surface URLs', async () => {
    const { getGuardedSurfaceUrl } = await import('@/lib/data');
    vi.stubEnv('KYBERION_OS_GUARDED_SURFACE_URL', 'javascript:alert(1)');
    expect(getGuardedSurfaceUrl()).toBeUndefined();
    vi.stubEnv('KYBERION_OS_GUARDED_SURFACE_URL', 'https://chronos.example.test/');
    expect(getGuardedSurfaceUrl()).toBe('https://chronos.example.test/');
  });

  it('audits the OS projection separately from the mission list', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('presence/displays/operator-surface/src/app/page.tsx'),
        {
          encoding: 'utf8',
        }
      )
    );
    expect(source).toContain("resource_kind: 'os_control_plane'");
    expect(source).toContain('osSnapshot.heldActions.length + osSnapshot.observations.length');
  });
});
