import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeWriteFile } from './secure-io.js';
import { LifecycleHookEngine } from './lifecycle-hook-engine.js';
import {
  discoverExternalHookConfigs,
  registerDiscoveredExternalLifecycleHooks,
} from './external-hook-discovery.js';

const fixtureRoot = pathResolver.shared('tmp/external-hook-discovery-test');

describe('external hook discovery', () => {
  it('requires trust before registering project-local configs', async () => {
    safeMkdir(`${fixtureRoot}/.claude`, { recursive: true });
    safeWriteFile(
      `${fixtureRoot}/.claude/settings.json`,
      JSON.stringify({
        PreToolUse: [{ hooks: [{ type: 'command', command: ['trusted-hook'] }] }],
      })
    );
    expect(discoverExternalHookConfigs({ rootDir: fixtureRoot })).toHaveLength(1);
    const engine = new LifecycleHookEngine();
    expect(() =>
      registerDiscoveredExternalLifecycleHooks(engine, {
        rootDir: fixtureRoot,
        trustResolved: false,
      })
    ).toThrow('[EXTERNAL_HOOK_TRUST_REQUIRED]');
    const result = registerDiscoveredExternalLifecycleHooks(engine, {
      rootDir: fixtureRoot,
      trustResolved: true,
    });
    expect(result.registered).toBe(1);
    await result.dispose();
    expect(engine.hookCountFor('pre_tool_use')).toBe(0);
  });

  it('requires an explicit global opt-in and separate trust decision', async () => {
    const globalHome = pathResolver.shared('tmp/external-hook-global-test');
    safeMkdir(`${globalHome}/.claude`, { recursive: true });
    safeWriteFile(
      `${globalHome}/.claude/settings.json`,
      JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command', command: ['global-hook'] }] }] })
    );
    const projectRoot = pathResolver.shared('tmp/external-hook-global-project');
    expect(
      discoverExternalHookConfigs({ rootDir: projectRoot, globalHomeDir: globalHome })
    ).toHaveLength(0);
    expect(
      discoverExternalHookConfigs({
        rootDir: projectRoot,
        includeGlobal: true,
        globalHomeDir: globalHome,
      })
    ).toEqual([
      {
        source: 'claude-code',
        path: `${globalHome}/.claude/settings.json`,
        scope: 'global',
      },
    ]);

    const engine = new LifecycleHookEngine();
    expect(() =>
      registerDiscoveredExternalLifecycleHooks(engine, {
        rootDir: projectRoot,
        includeGlobal: true,
        globalHomeDir: globalHome,
        trustResolved: true,
      })
    ).toThrow('[EXTERNAL_HOOK_GLOBAL_TRUST_REQUIRED]');
    const result = registerDiscoveredExternalLifecycleHooks(engine, {
      rootDir: projectRoot,
      includeGlobal: true,
      globalHomeDir: globalHome,
      trustResolved: true,
      globalTrustResolved: true,
    });
    expect(result.registered).toBe(1);
    await result.dispose();
  });
});
