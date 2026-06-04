import { describe, expect, it, beforeEach } from 'vitest';
import {
  getServiceRuntimePolicy,
  resetServiceRuntimePolicyCache,
  resolveServiceRuntimeCacheRoot,
  resolveServiceRuntimeRoot,
} from './service-runtime-policy.js';

describe('service-runtime-policy', () => {
  beforeEach(() => {
    resetServiceRuntimePolicyCache();
  });

  it('loads the governed fallback policy and resolves managed roots', () => {
    const policy = getServiceRuntimePolicy();
    expect(policy.managed_roots.service_runtime_root).toBe('active/shared/runtime');
    expect(policy.managed_roots.cache_root).toBe('active/shared/tmp/service-runtime-cache');
    expect(resolveServiceRuntimeRoot(policy)).toContain('active/shared/runtime');
    expect(resolveServiceRuntimeCacheRoot(policy)).toContain('active/shared/tmp/service-runtime-cache');
  });
});
