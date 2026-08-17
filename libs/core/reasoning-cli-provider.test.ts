import { describe, expect, it } from 'vitest';
import { buildCliProviderBundle } from './reasoning-cli-provider.js';

describe('CLI reasoning provider module', () => {
  it('owns Claude Agent and Copilot modes outside the bootstrap switch', () => {
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
