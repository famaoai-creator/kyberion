import { describe, expect, it, beforeEach } from 'vitest';
import {
  getServiceRuntimePolicy,
  _resetServiceRuntimePolicyCacheForTests,
  resolveServiceRuntimeCacheRoot,
  resolveServiceRuntimeRoot,
} from './service-runtime-policy.js';

describe('service-runtime-policy', () => {
  beforeEach(() => {
    delete process.env.KYBERION_SERVICE_RUNTIME_POLICY_PATH;
    _resetServiceRuntimePolicyCacheForTests();
  });

  it('loads the governed fallback policy and resolves managed roots', () => {
    const policy = getServiceRuntimePolicy();
    expect(policy.managed_roots.service_runtime_root).toBe('active/shared/runtime');
    expect(policy.managed_roots.cache_root).toBe('active/shared/tmp/service-runtime-cache');
    expect(resolveServiceRuntimeRoot(policy)).toContain('active/shared/runtime');
    expect(resolveServiceRuntimeCacheRoot(policy)).toContain(
      'active/shared/tmp/service-runtime-cache'
    );
  });

  it('rejects managed roots outside the repository', () => {
    const policy = getServiceRuntimePolicy();
    expect(() =>
      resolveServiceRuntimeRoot({
        ...policy,
        managed_roots: { ...policy.managed_roots, service_runtime_root: '/tmp/runtime' },
      })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
    expect(() =>
      resolveServiceRuntimeCacheRoot({
        ...policy,
        managed_roots: { ...policy.managed_roots, cache_root: '/tmp/cache' },
      })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('falls back when the policy override is outside the repository', () => {
    process.env.KYBERION_SERVICE_RUNTIME_POLICY_PATH =
      '/tmp/kyberion-service-runtime-policy-external.json';
    _resetServiceRuntimePolicyCacheForTests();

    expect(getServiceRuntimePolicy().version).toBe('fallback');
  });
});
