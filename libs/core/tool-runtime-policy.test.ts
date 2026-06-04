import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getToolRuntimePolicy,
  resetToolRuntimePolicyCache,
  resolveToolRuntimeCacheRoot,
  resolveToolRuntimeRoot,
} from './tool-runtime-policy.js';

describe('tool runtime policy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetToolRuntimePolicyCache();
  });

  it('loads the governed policy and resolves managed roots', () => {
    resetToolRuntimePolicyCache();
    const policy = getToolRuntimePolicy();
    expect(policy.managed_roots.tool_runtime_root).toContain('active/shared/runtime');
    expect(resolveToolRuntimeRoot(policy)).toContain('active/shared/runtime');
    expect(resolveToolRuntimeCacheRoot(policy)).toContain('active/shared/tmp/tool-runtime-cache');
  });

  it('respects env overrides', () => {
    vi.stubEnv('KYBERION_TOOL_RUNTIME_POLICY_PATH', '/tmp/tool-runtime-policy.json');
    resetToolRuntimePolicyCache();
    const policy = getToolRuntimePolicy();
    expect(policy.version).toBe('fallback');
  });
});
