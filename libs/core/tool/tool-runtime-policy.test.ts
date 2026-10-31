import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getToolRuntimePolicy,
  _resetToolRuntimePolicyCacheForTests,
  resolveToolRuntimeCacheRoot,
  resolveToolRuntimeDir,
  resolveToolRuntimeDownloadCacheDir,
  resolveToolRuntimeRoot,
  resolveToolRuntimesRoot,
  TOOL_RUNTIME_DOWNLOAD_CACHE_ROOT,
  writeToolRuntimePolicyAtPath,
  type ToolRuntimePolicy,
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

describe('tool runtime root resolution', () => {
  const runtimeDir = `resolver-test-${process.pid}`;
  const managedRoot = pathResolver.sharedTmp(`tool-runtime-roots-${process.pid}`);
  const policy: ToolRuntimePolicy = {
    version: '1.0.0',
    managed_roots: {
      tool_runtime_root: path.relative(pathResolver.rootDir(), managedRoot),
      cache_root: 'active/shared/tmp/tool-runtime-cache',
    },
    mode_preference: { python: 'trial_first', node: 'installed_first', system: 'installed_first' },
    approval: { install_requires_approval: true, pin_requires_approval: true },
  };
  const canonicalDir = path.join(managedRoot, 'tool-runtimes', runtimeDir);
  const legacyDir = resolveToolRuntimeDownloadCacheDir(runtimeDir);

  afterEach(() => {
    safeRmSync(managedRoot, { recursive: true, force: true });
    safeRmSync(legacyDir, { recursive: true, force: true });
  });

  it('defines the canonical install root on the runtime floor and the download cache on the cache floor', () => {
    _resetToolRuntimePolicyCacheForTests();
    expect(resolveToolRuntimesRoot()).toBe(
      pathResolver.rootResolve('active/shared/runtime/tool-runtimes')
    );
    expect(TOOL_RUNTIME_DOWNLOAD_CACHE_ROOT).toBe('active/shared/cache/system/tool-runtimes');
    expect(resolveToolRuntimeDownloadCacheDir('mlx-audio')).toBe(
      pathResolver.rootResolve('active/shared/cache/system/tool-runtimes/mlx-audio')
    );
  });

  it('returns the canonical directory when the runtime exists nowhere (new installs)', () => {
    expect(resolveToolRuntimeDir(runtimeDir, policy)).toBe(canonicalDir);
  });

  it('ignores a legacy directory that only holds download caches', () => {
    safeWriteFile(path.join(legacyDir, 'huggingface', 'marker'), 'x', { mkdir: true });
    expect(resolveToolRuntimeDir(runtimeDir, policy)).toBe(canonicalDir);
  });

  it('falls back to the legacy root when the runtime is installed only there', () => {
    safeWriteFile(path.join(legacyDir, 'bin', 'python'), '', { mkdir: true });
    expect(resolveToolRuntimeDir(runtimeDir, policy)).toBe(legacyDir);
  });

  it('prefers the canonical root when the runtime is installed in both', () => {
    safeWriteFile(path.join(legacyDir, 'bin', 'python'), '', { mkdir: true });
    safeWriteFile(path.join(canonicalDir, 'state.json'), '{}', { mkdir: true });
    expect(resolveToolRuntimeDir(runtimeDir, policy)).toBe(canonicalDir);
  });

  it('rejects runtime directories that escape the managed root', () => {
    expect(() => resolveToolRuntimeDir('../outside', policy)).toThrow('[TOOL_RUNTIME_PATH_SCOPE]');
  });
});
