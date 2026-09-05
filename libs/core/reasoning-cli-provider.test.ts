import { describe, expect, it } from 'vitest';
import { buildCliProviderBundle } from './reasoning-cli-provider.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

describe('CLI reasoning provider module', () => {
  it('routes provider environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/reasoning-cli-provider.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).not.toMatch(/env\.(CLAUDECODE|ANTHROPIC_API_KEY)/u);
    expect(source).toContain('getRegisteredEnvText');
  });

  it('owns Claude Agent, Copilot, and Cursor CLI modes outside the bootstrap switch', () => {
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
