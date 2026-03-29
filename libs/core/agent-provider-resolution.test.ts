import { describe, expect, it } from 'vitest';
import { resolveAgentProviderTarget } from './agent-provider-resolution.js';
import type { ProviderInfo } from './provider-discovery.js';

function provider(providerId: string, models: string[], installed = true): ProviderInfo {
  return {
    provider: providerId,
    installed,
    version: 'test',
    protocol: 'acp',
    models,
    healthy: installed,
  };
}

describe('agent-provider-resolution', () => {
  it('keeps the preferred provider and model when it is installed', () => {
    const resolved = resolveAgentProviderTarget({
      preferredProvider: 'gemini',
      preferredModelId: 'gemini-2.5-pro',
    }, [
      provider('gemini', ['gemini-2.5-flash', 'gemini-2.5-pro']),
      provider('claude', ['sonnet']),
    ]);

    expect(resolved).toMatchObject({
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      strategy: 'preferred',
    });
  });

  it('falls back to an installed provider when the preferred provider is unavailable', () => {
    const resolved = resolveAgentProviderTarget({
      preferredProvider: 'gemini',
      preferredModelId: 'gemini-2.5-flash',
    }, [
      provider('claude', ['sonnet', 'opus']),
      provider('codex', ['codex']),
    ]);

    expect(resolved).toMatchObject({
      provider: 'claude',
      modelId: 'sonnet',
      strategy: 'fallback',
    });
  });

  it('does not fall back when strategy is strict', () => {
    const resolved = resolveAgentProviderTarget({
      preferredProvider: 'gemini',
      preferredModelId: 'gemini-2.5-flash',
      providerStrategy: 'strict',
    }, [
      provider('claude', ['sonnet']),
      provider('codex', ['codex']),
    ]);

    expect(resolved).toMatchObject({
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
      strategy: 'unresolved',
    });
  });

  it('restricts fallback to the configured provider allowlist', () => {
    const resolved = resolveAgentProviderTarget({
      preferredProvider: 'gemini',
      providerStrategy: 'preferred',
      fallbackProviders: ['codex'],
    }, [
      provider('claude', ['sonnet']),
      provider('codex', ['codex']),
    ]);

    expect(resolved).toMatchObject({
      provider: 'codex',
      modelId: 'codex',
      strategy: 'fallback',
    });
  });

  it('keeps the preferred target when nothing installed is discoverable', () => {
    const resolved = resolveAgentProviderTarget({
      preferredProvider: 'codex',
      preferredModelId: 'gpt-5',
    }, []);

    expect(resolved).toMatchObject({
      provider: 'codex',
      modelId: 'gpt-5',
      strategy: 'unresolved',
    });
  });
});
