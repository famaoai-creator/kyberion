import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getToolRuntimePolicy,
  _resetToolRuntimePolicyCacheForTests,
  resolveToolRuntimeCacheRoot,
  resolveToolRuntimeRoot,
  writeToolRuntimePolicyAtPath,
} from './tool-runtime-policy.js';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync, safeWriteFile } from '../secure-io.js';
import { withExecutionContext } from '../index.js';

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

  it('lets a scheduler read tool policy without assuming concierge authority', () => {
    vi.stubEnv('SYSTEM_ROLE', 'generation_schedule');
    _resetToolRuntimePolicyCacheForTests();
    expect(getToolRuntimePolicy().approval.install_requires_approval).toBe(true);
  });

  it('respects env overrides', () => {
    vi.stubEnv(
      'KYBERION_TOOL_RUNTIME_POLICY_PATH',
      pathResolver.knowledge('product/governance/tool-runtime-policy.json')
    );
    _resetToolRuntimePolicyCacheForTests();
    const policy = getToolRuntimePolicy();
    expect(policy.version).toBe('1.0.0');
  });

  it('rechecks explicit protected policy access after a privileged cache fill', () => {
    const policy = getToolRuntimePolicy();
    const protectedPath = pathResolver.shared(
      `artifacts/personal/shared/evidence/tool-policy-${process.pid}.json`
    );
    try {
      withExecutionContext(
        'mission_controller',
        () => safeWriteFile(protectedPath, JSON.stringify(policy), { mkdir: true }),
        'ecosystem_architect'
      );
      vi.stubEnv('KYBERION_TOOL_RUNTIME_POLICY_PATH', protectedPath);
      expect(
        withExecutionContext(
          'mission_controller',
          () => getToolRuntimePolicy(),
          'ecosystem_architect'
        )
      ).toEqual(policy);
      expect(() =>
        withExecutionContext('generation_scheduler', () => getToolRuntimePolicy(), 'worker')
      ).toThrow();
    } finally {
      withExecutionContext(
        'mission_controller',
        () => safeRmSync(protectedPath, { force: true }),
        'ecosystem_architect'
      );
    }
  });

  it('fails closed when an override fails schema validation', () => {
    const invalidPath = pathResolver.sharedTmp(`tool-runtime-policy-${process.pid}/invalid.json`);
    safeWriteFile(invalidPath, JSON.stringify({ version: 'invalid' }), {
      mkdir: true,
      encoding: 'utf8',
    });
    vi.stubEnv('KYBERION_TOOL_RUNTIME_POLICY_PATH', invalidPath);
    _resetToolRuntimePolicyCacheForTests();
    expect(() => getToolRuntimePolicy()).toThrow(/Invalid catalog tool-runtime-policy/);
  });

  it('fails closed when an override is outside the repository', () => {
    vi.stubEnv('KYBERION_TOOL_RUNTIME_POLICY_PATH', '/tmp/tool-runtime-external.json');
    _resetToolRuntimePolicyCacheForTests();

    expect(() => getToolRuntimePolicy()).toThrow('[RESOURCE_PATH_SCOPE]');
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
