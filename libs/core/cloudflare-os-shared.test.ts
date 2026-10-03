import { describe, expect, it } from 'vitest';
import { rootDir } from './path-resolver.js';
import { safeExecResult } from './secure-io.js';
import { getControlPlaneForScope, resolveOsSurfaceAccess } from './cloudflare-os-shared.js';

/**
 * SC-08: the shared module is the only construction site for the control
 * plane — every consumer goes through `getControlPlaneForScope` or
 * `sharedControlPlane`.
 */
describe('control-plane construction choke point', () => {
  it('allows no direct `new CloudflareOsControlPlane(` outside the shared facade', () => {
    const result = safeExecResult(
      'git',
      ['grep', '-n', 'new CloudflareOsControlPlane(', '--', '*.ts'],
      { cwd: rootDir() }
    );
    const lines = result.stdout
      .split('\n')
      .filter(Boolean)
      .filter(
        (line) =>
          !line.includes('cloudflare-os-shared.ts:') &&
          !line.includes('.test.ts:') &&
          !line.startsWith('.worktrees/') &&
          !line.startsWith('.codex/')
      );
    expect(lines).toEqual([]);
  });
});

describe('getControlPlaneForScope', () => {
  it('rejects an invalid tenant slug fail-closed', () => {
    expect(() => getControlPlaneForScope({ tenantSlug: 'not a slug!!' })).toThrow(
      '[POLICY_VIOLATION]'
    );
  });

  it('returns the shared instance for a valid or absent scope', () => {
    expect(getControlPlaneForScope()).toBe(getControlPlaneForScope({ tenantSlug: 'acme' }));
  });
});

describe('resolveOsSurfaceAccess', () => {
  const access = (env: NodeJS.ProcessEnv) =>
    resolveOsSurfaceAccess({
      principalEnv: 'KYBERION_TEST_SURFACE_PRINCIPAL',
      defaultPrincipal: 'human:test-surface-local',
      env,
    });

  it('requires the surface principal env when a tenant is scoped', () => {
    expect(() => access({ KYBERION_TENANT: 'acme' })).toThrow('[POLICY_VIOLATION]');
    const scoped = access({
      KYBERION_TENANT: 'acme',
      KYBERION_TEST_SURFACE_PRINCIPAL: 'human:viewer',
    });
    expect(scoped).toEqual({ principalId: 'human:viewer', tenantSlugs: ['acme'] });
  });

  it('falls back to the default principal when unscoped', () => {
    expect(access({})).toEqual({
      principalId: 'human:test-surface-local',
      tenantSlugs: [],
    });
  });

  it('rejects a non-human principal', () => {
    expect(() => access({ KYBERION_TEST_SURFACE_PRINCIPAL: 'bot:ci' })).toThrow(
      '[POLICY_VIOLATION]'
    );
  });
});
