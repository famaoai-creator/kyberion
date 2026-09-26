import { afterEach, describe, expect, it, vi } from 'vitest';
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
