import { describe, expect, it } from 'vitest';
import { resolveCapabilityTarget } from './agent-provider-resolution.js';
import type { ProviderInfo } from './provider-discovery.js';

function provider(
  providerId: string,
  models: string[],
  modelCapabilities: Record<string, string[]> = {},
  installed = true,
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

const gemini = provider('gemini', ['gemini-2.5-pro', 'gemini-2.5-flash'], {
  'gemini-2.5-pro': ['reasoning', 'analysis', 'long_context', 'structured_json'],
  'gemini-2.5-flash': ['low_latency', 'conversation', 'structured_json'],
});
const claude = provider('claude', ['opus', 'sonnet'], {
  opus: ['reasoning', 'analysis', 'review', 'code', 'deep_reasoning', 'managed_workflow'],
  sonnet: ['reasoning', 'analysis', 'review', 'code'],
});
const codex = provider('codex', ['codex'], {
  codex: ['code', 'implementation', 'patch', 'terminal'],
});

describe('resolveCapabilityTarget (requirement-first)', () => {
  it('uses the only installed provider even when it does not cover the requirements', () => {
    const resolved = resolveCapabilityTarget(
      { requiredCapabilities: ['patch', 'terminal'] },
      [gemini],
    );
    expect(resolved.provider).toBe('gemini');
    expect(resolved.strategy).toBe('sole');
    expect(resolved.unmetCapabilities).toEqual(['patch', 'terminal']);
  });

  it('picks the best-covering provider without any preferred hint', () => {
    const resolved = resolveCapabilityTarget(
      { requiredCapabilities: ['code', 'patch', 'terminal'] },
      [gemini, claude, codex],
    );
    expect(resolved.provider).toBe('codex');
    expect(resolved.modelId).toBe('codex');
    expect(resolved.strategy).toBe('best-match');
    expect(resolved.unmetCapabilities).toEqual([]);
  });

  it('honors the preferred provider when it covers the requirements', () => {
    const resolved = resolveCapabilityTarget(
      { requiredCapabilities: ['deep_reasoning'], preferredProvider: 'claude' },
      [gemini, claude, codex],
    );
    expect(resolved.provider).toBe('claude');
    expect(resolved.modelId).toBe('opus');
    expect(resolved.strategy).toBe('preferred');
  });

  it('fails over to another provider when the preferred one is rate-limited', () => {
    const resolved = resolveCapabilityTarget(
      {
        requiredCapabilities: ['code', 'patch', 'terminal'],
        preferredProvider: 'codex',
        excludeProviders: ['codex'],
      },
      [claude, codex],
    );
    expect(resolved.provider).not.toBe('codex');
    expect(['best-match', 'degraded']).toContain(resolved.strategy);
  });

  it('degrades (ignores demotion) when every candidate is rate-limited', () => {
    const resolved = resolveCapabilityTarget(
      {
        requiredCapabilities: ['code'],
        excludeProviders: ['claude', 'codex'],
      },
      [claude, codex],
    );
    expect(['claude', 'codex']).toContain(resolved.provider);
    expect(resolved.strategy).toBe('degraded');
    expect(resolved.rationale).toMatch(/rate-limited/);
  });

  it('flags degraded when nothing installed covers the requirement', () => {
    const resolved = resolveCapabilityTarget(
      { requiredCapabilities: ['patch', 'terminal'] },
      [gemini, claude],
    );
    expect(resolved.strategy).toBe('degraded');
    expect(resolved.unmetCapabilities.length).toBeGreaterThan(0);
  });

  it('returns unresolved when no providers are installed', () => {
    const resolved = resolveCapabilityTarget(
      { requiredCapabilities: ['code'], preferredProvider: 'codex', preferredModelId: 'codex' },
      [],
    );
    expect(resolved).toMatchObject({ provider: 'codex', modelId: 'codex', strategy: 'unresolved' });
  });
});
