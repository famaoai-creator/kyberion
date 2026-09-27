import { describe, expect, it } from 'vitest';
import { buildCliProviderBundle, listCliProviderBundleModes } from './reasoning-cli-provider.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile, safeReaddir } from './secure-io.js';
import * as path from 'node:path';

describe('CLI reasoning provider module', () => {
  it('routes provider environment reads through the governed accessor', () => {
    const bundleDir = pathResolver.rootResolve('libs/core/provider-bundles');
    const files = safeReaddir(bundleDir).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(1);
    for (const name of files) {
      const source = String(safeReadFile(path.join(bundleDir, name), { encoding: 'utf8' }));
      expect(source).not.toMatch(/env\.KYBERION_/u);
      expect(source).not.toMatch(/env\.(CLAUDECODE|ANTHROPIC_API_KEY)/u);
    }
    const seamSource = String(
      safeReadFile(pathResolver.rootResolve('libs/core/cli-provider-bundle.ts'), {
        encoding: 'utf8',
      })
    );
    expect(seamSource).toContain('getRegisteredEnvText');
  });

  it('registers every governed CLI/ACP mode in the bundle seam', () => {
    expect(listCliProviderBundleModes()).toEqual(
      expect.arrayContaining([
        'agy-cli',
        'claude-agent',
        'claude-cli',
        'codex-cli',
        'copilot',
        'cursor-cli',
        'devin-cli',
        'gemini-cli',
        'grok-cli',
        'opencode-cli',
      ])
    );
  });

  it('owns Claude Agent, Copilot, Cursor CLI, and OpenCode CLI modes outside the bootstrap switch', () => {
    const claudeAgent = buildCliProviderBundle({
      mode: 'claude-agent',
      provider: 'claude',
      force: true,
      env: {},
    });
    expect(claudeAgent).toMatchObject({
      mode: 'claude-agent',
      backend: { provider: 'claude', label: 'claude-agent' },
      intentExtractor: { provider: 'claude' },
      voiceBridge: { provider: 'claude' },
    });

    const copilot = buildCliProviderBundle({ mode: 'copilot', provider: 'copilot', env: {} });
    expect(copilot).toMatchObject({
      mode: 'copilot',
      backend: { provider: 'copilot', label: 'copilot' },
    });

    expect(
      buildCliProviderBundle({
        mode: 'cursor-cli',
        provider: 'cursor',
        env: { KYBERION_CURSOR_CLI_BIN: '__definitely_missing_cursor_agent__' },
      })
    ).toBeNull();

    expect(
      buildCliProviderBundle({
        mode: 'opencode-cli',
        provider: 'opencode',
        env: { KYBERION_OPENCODE_CLI_BIN: '__definitely_missing_opencode__' },
      })
    ).toBeNull();
  });

  it('returns undefined for API and local modes owned by other modules', () => {
    expect(
      buildCliProviderBundle({ mode: 'anthropic', provider: 'anthropic', env: {} })
    ).toBeUndefined();
    expect(buildCliProviderBundle({ mode: 'local', provider: 'local', env: {} })).toBeUndefined();
  });

  it('preserves the unavailable result for an unhealthy Claude CLI build', () => {
    const result = buildCliProviderBundle({
      mode: 'claude-cli',
      provider: 'claude',
      env: { KYBERION_CLAUDE_CLI_BIN: '/definitely/missing/claude' },
    });
    expect(result).toBeNull();
  });
});
