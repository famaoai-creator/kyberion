import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getToolRuntimePolicy,
  _resetToolRuntimePolicyCacheForTests,
  resolveToolRuntimeCacheRoot,
  resolveToolRuntimeRoot,
} from './tool-runtime-policy.js';

describe('tool runtime policy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetToolRuntimePolicyCacheForTests();
  });

  it('loads the governed policy and resolves managed roots', () => {
    _resetToolRuntimePolicyCacheForTests();
    const policy = getToolRuntimePolicy();
    expect(policy.managed_roots.tool_runtime_root).toContain('active/shared/runtime');
    expect(resolveToolRuntimeRoot(policy)).toContain('active/shared/runtime');
    expect(resolveToolRuntimeCacheRoot(policy)).toContain('active/shared/tmp/tool-runtime-cache');
  });

  it('respects env overrides', () => {
    vi.stubEnv('KYBERION_TOOL_RUNTIME_POLICY_PATH', '/tmp/tool-runtime-policy.json');
    _resetToolRuntimePolicyCacheForTests();
    const policy = getToolRuntimePolicy();
    expect(policy.version).toBe('fallback');
  });

  it('falls back when an override fails schema validation', () => {
    vi.stubEnv('KYBERION_TOOL_RUNTIME_POLICY_PATH', '/tmp/tool-runtime-policy.json');
    _resetToolRuntimePolicyCacheForTests();
    expect(getToolRuntimePolicy().version).toBe('fallback');
  });

  it('falls back when an override is outside the repository', () => {
    vi.stubEnv('KYBERION_TOOL_RUNTIME_POLICY_PATH', '/tmp/tool-runtime-external.json');
    _resetToolRuntimePolicyCacheForTests();

    expect(getToolRuntimePolicy().version).toBe('fallback');
  });
});
