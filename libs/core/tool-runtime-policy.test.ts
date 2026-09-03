import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getToolRuntimePolicy,
  _resetToolRuntimePolicyCacheForTests,
  resolveToolRuntimeCacheRoot,
  resolveToolRuntimeRoot,
  writeToolRuntimePolicyAtPath,
} from './tool-runtime-policy.js';
import { pathResolver } from './path-resolver.js';
import { safeRmSync } from './secure-io.js';
import { withExecutionContext } from './index.js';

const fixtureRoot = pathResolver.sharedTmp(`tool-runtime-policy-${process.pid}`);

describe('tool runtime policy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetToolRuntimePolicyCacheForTests();
    safeRmSync(fixtureRoot, { recursive: true, force: true });
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

  it('rejects an invalid policy before persisting it', () => {
    withExecutionContext('mission_controller', () => {
      const filePath = pathResolver.sharedTmp(`tool-runtime-policy-${process.pid}/invalid.json`);

      expect(() =>
        writeToolRuntimePolicyAtPath(filePath, {
          version: '1.0.0',
          managed_roots: {
            tool_runtime_root: 'active/shared/runtime',
            cache_root: 'active/shared/tmp/tool-runtime-cache',
          },
          mode_preference: {
            python: 'trial_first',
            node: 'installed_first',
            system: 'invalid' as 'trial_first',
          },
          approval: {
            install_requires_approval: true,
            pin_requires_approval: true,
          },
        })
      ).toThrow(/Invalid catalog tool-runtime-policy/);
    });
  });
});
