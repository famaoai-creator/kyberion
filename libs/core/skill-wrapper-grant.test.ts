import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedSkillPlugin } from './skill-plugin-loader.js';

const loaded: LoadedSkillPlugin[] = [];

// Only the loading step is replaced; hook firing and disposal stay real so
// the test observes exactly the grant skill-wrapper runs each hook under.
vi.mock('./skill-plugin-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./skill-plugin-loader.js')>();
  return {
    ...actual,
    isSkillAllowed: () => ({ allowed: true }),
    loadAuthorizedSkillPlugins: async () => ({ loaded: [...loaded], diagnostics: [] }),
  };
});

import { getActiveSandboxPolicy, getPluginExecutionContext } from './sandbox-policy.js';
import { pathResolver } from './path-resolver.js';
import { createPluginGrantBinding } from './plugin-grant-runtime.js';
import { runSkillAsync } from './skill-wrapper.js';

afterEach(() => {
  loaded.length = 0;
  vi.restoreAllMocks();
});

function observingPlugin(resolvedPath: string, seen: unknown[]): LoadedSkillPlugin {
  return {
    configuredPath: resolvedPath,
    resolvedPath,
    module: {
      beforeSkill: () =>
        seen.push({
          plugin: getPluginExecutionContext()?.pluginId ?? null,
          mode: getActiveSandboxPolicy()?.mode ?? null,
        }),
    },
  };
}

describe('runSkillAsync passes plugin grants to skill hooks (EP-03)', () => {
  it('runs a third-party hook-only plugin under the deny-by-default grant', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const seen: unknown[] = [];
    loaded.push(observingPlugin('/managed/unknown-hook-plugin/index.mjs', seen));
    const output = await runSkillAsync('demo-skill', async () => 'ok', { trustResolved: true });
    expect(output.status).toBe('success');
    expect(seen).toEqual([{ plugin: 'index.mjs', mode: 'read-only' }]);
  });

  it('reuses the contribution activation grant and leaves legacy official hooks unwrapped', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const seen: unknown[] = [];
    const withContributions = observingPlugin('/managed/contrib/index.mjs', seen);
    withContributions.contributions = {
      provenance: { pluginId: 'contrib', sourcePath: '/managed/contrib', trust: 'third-party' },
      registered: {},
      grant: createPluginGrantBinding('contrib', {
        network: { mode: 'none', hosts: [] },
        fs: { mode: 'none', paths: [] },
        ops_invoke: [],
        env: [],
        secrets: [],
      }),
      grantResolution: { grant: null, source: 'provided', reason: 'test' },
      dispose: () => undefined,
    };
    loaded.push(withContributions);
    loaded.push(
      observingPlugin(
        pathResolver.rootResolve('plugins/fixtures/skill-plugin-loader-official-fixture.mjs'),
        seen
      )
    );
    await runSkillAsync('demo-skill', async () => 'ok', { trustResolved: true });
    expect(seen).toEqual([
      { plugin: 'contrib', mode: 'read-only' },
      { plugin: null, mode: null },
    ]);
  });
});
