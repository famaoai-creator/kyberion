import { describe, expect, it } from 'vitest';
import { resolveAgentProviderTarget } from './agent-provider-resolution.js';
import type { ProviderInfo } from './provider-discovery.js';

function provider(
  providerId: string,
  models: string[],
  installed = true,
  modelCapabilities: Record<string, string[]> = {},
): ProviderInfo {
  return {
    provider: providerId,
    installed,
    version: 'test',
    protocol: 'acp',
    models,
    capabilities: Array.from(new Set(Object.values(modelCapabilities).flat())),
    modelCapabilities,
    healthy: installed,
  };
}

describe('agent-provider-resolution', () => {
  it('keeps the preferred provider and model when it is installed', () => {
    const resolved = resolveAgentProviderTarget({
      preferredProvider: 'gemini',
      preferredModelId: 'gemini-2.5-pro',
    }, [
      provider('gemini', ['gemini-2.5-flash', 'gemini-2.5-pro'], true, {
        'gemini-2.5-flash': ['surface', 'conversation', 'structured_json'],
        'gemini-2.5-pro': ['reasoning', 'analysis', 'structured_json', 'long_context'],
      }),
      provider('claude', ['sonnet'], true, {
        sonnet: ['reasoning', 'analysis'],
      }),
    ]);

    expect(resolved).toMatchObject({
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      strategy: 'preferred',
    });
  });

  it('chooses the model that best matches the required capabilities', () => {
    const resolved = resolveAgentProviderTarget({
      preferredProvider: 'gemini',
      preferredModelId: 'gemini-2.5-pro',
      requiredCapabilities: ['surface', 'conversation', 'structured_json'],
    }, [
      provider('gemini', ['gemini-2.5-flash', 'gemini-2.5-pro'], true, {
        'gemini-2.5-flash': ['surface', 'conversation', 'structured_json', 'low_latency'],
        'gemini-2.5-pro': ['reasoning', 'analysis', 'structured_json', 'long_context'],
      }),
    ]);

    expect(resolved).toMatchObject({
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
      strategy: 'preferred',
    });
  });

  it('falls back to an installed provider when the preferred provider is unavailable', () => {
    const resolved = resolveAgentProviderTarget({
      preferredProvider: 'gemini',
      preferredModelId: 'gemini-2.5-flash',
      requiredCapabilities: ['code', 'patch', 'terminal'],
    }, [
      provider('claude', ['sonnet', 'opus'], true, {
        sonnet: ['reasoning', 'analysis', 'review', 'code'],
        opus: ['reasoning', 'analysis', 'review', 'code'],
      }),
      provider('codex', ['codex'], true, {
        codex: ['code', 'implementation', 'patch', 'terminal'],
      }),
    ]);

    expect(resolved).toMatchObject({
      provider: 'codex',
      modelId: 'codex',
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
