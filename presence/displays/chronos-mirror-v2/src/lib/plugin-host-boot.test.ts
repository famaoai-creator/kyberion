import { afterEach, describe, expect, it, vi } from 'vitest';

// PE-02: the registry is personal-tier; only the Chronos localadmin role may read it.
vi.mock('@agent/core/tenant-registry', () => ({
  resolveTenant: (slug: string) => {
    if (process.env.MISSION_ROLE !== 'chronos_localadmin' || slug !== 'known-tenant') {
      throw new Error(`[tenant-registry] tenant '${slug}' could not be read`);
    }
    return { profile: { tenant_slug: slug } };
  },
}));
import {
  disposePluginHost,
  getPluginHost,
  type CreatePluginHostOptions,
  type PluginHost,
} from '@agent/core/plugin-host';
import {
  CHRONOS_PLUGIN_HOST_SURFACE,
  chronosPluginHostStatus,
  ensureChronosPluginHost,
  isChronosPluginHostEnabled,
} from './plugin-host-boot';

function fakeFactory() {
  const created: CreatePluginHostOptions[] = [];
  const start = vi.fn();
  const create = vi.fn((options: CreatePluginHostOptions): PluginHost => {
    created.push(options);
    return {
      surface: options.surface,
      start,
      stop: vi.fn(),
      syncNow: vi.fn(),
      status: () => ({ enabled: true, surface: options.surface, plugins: [] }),
    } as unknown as PluginHost;
  });
  return { create, created, start };
}

afterEach(() => {
  disposePluginHost(CHRONOS_PLUGIN_HOST_SURFACE);
  vi.restoreAllMocks();
});

describe('Chronos plugin host boot (PH-01)', () => {
  it('is a no-op while KYBERION_CHRONOS_PLUGIN_HOST is off', () => {
    const { create } = fakeFactory();
    for (const env of [
      {},
      { KYBERION_CHRONOS_PLUGIN_HOST: '0' },
      { KYBERION_CHRONOS_PLUGIN_HOST: 'false' },
    ]) {
      expect(isChronosPluginHostEnabled(env)).toBe(false);
      expect(ensureChronosPluginHost({ env, create })).toBeNull();
    }
    expect(create).not.toHaveBeenCalled();
    expect(getPluginHost(CHRONOS_PLUGIN_HOST_SURFACE)).toBeUndefined();
    expect(chronosPluginHostStatus()).toEqual({
      enabled: false,
      surface: CHRONOS_PLUGIN_HOST_SURFACE,
      plugins: [],
    });
  });

  it('creates and starts one host per process when enabled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { create, created, start } = fakeFactory();
    const env = {
      KYBERION_CHRONOS_PLUGIN_HOST: '1',
      KYBERION_CHRONOS_PLUGIN_HOST_TENANTS: 'public, ../x, no-such-tenant-zz9',
      KYBERION_PLUGIN_HOST_POLL_MS: '5000',
    };
    const host = ensureChronosPluginHost({ env, create });
    expect(host).not.toBeNull();
    expect(ensureChronosPluginHost({ env, create })).toBe(host);
    expect(create).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    // Reserved, malformed and unknown tenants are never allowed.
    expect(created[0]).toEqual({ surface: 'chronos', tenantAllow: [], pollMs: 5000 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(chronosPluginHostStatus().enabled).toBe(true);
  });

  it('warns that several allowed tenants share one trust domain', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { create, created } = fakeFactory();
    ensureChronosPluginHost({
      env: { KYBERION_CHRONOS_PLUGIN_HOST: '1', KYBERION_CHRONOS_PLUGIN_HOST_TENANTS: 'acme' },
      create,
      isKnownTenant: () => true,
    });
    expect(created[0].tenantAllow).toEqual(['acme']);
    expect(warn).not.toHaveBeenCalled();

    disposePluginHost(CHRONOS_PLUGIN_HOST_SURFACE);
    ensureChronosPluginHost({
      env: {
        KYBERION_CHRONOS_PLUGIN_HOST: '1',
        KYBERION_CHRONOS_PLUGIN_HOST_TENANTS: 'acme,globex',
      },
      create,
      isKnownTenant: () => true,
    });
    expect(created[1].tenantAllow).toEqual(['acme', 'globex']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('trust domain');
  });

  it('resolves allowed tenants under the Chronos localadmin role, not the ambient role', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previousRole = process.env.MISSION_ROLE;
    delete process.env.MISSION_ROLE;
    try {
      const { create, created } = fakeFactory();
      ensureChronosPluginHost({
        env: {
          KYBERION_CHRONOS_PLUGIN_HOST: '1',
          KYBERION_CHRONOS_PLUGIN_HOST_TENANTS: 'known-tenant,unknown-tenant',
        },
        create,
      });
      expect(created[0].tenantAllow).toEqual(['known-tenant']);
      // The role is restored after the lookup.
      expect(process.env.MISSION_ROLE).toBeUndefined();
    } finally {
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
    }
  });

  it('never throws when the host cannot boot', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const create = vi.fn(() => {
      throw new Error('boom');
    });
    expect(
      ensureChronosPluginHost({ env: { KYBERION_CHRONOS_PLUGIN_HOST: 'true' }, create })
    ).toBeNull();
    expect(getPluginHost(CHRONOS_PLUGIN_HOST_SURFACE)).toBeUndefined();
  });
});
