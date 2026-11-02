import { describe, expect, it } from 'vitest';
import { resolveCapabilityTarget } from './agent-provider-resolution.js';
import { createExternalHarnessRegistry } from './external-harness-registry.js';
import type { ProviderInfo } from '../provider/provider-discovery.js';

function provider(
  providerId: string,
  models: string[],
  modelCapabilities: Record<string, string[]> = {},
  installed = true
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
    const resolved = resolveCapabilityTarget({ requiredCapabilities: ['patch', 'terminal'] }, [
      gemini,
    ]);
    expect(resolved.provider).toBe('gemini');
    expect(resolved.strategy).toBe('sole');
    expect(resolved.unmetCapabilities).toEqual(['patch', 'terminal']);
  });

  it('picks the best-covering provider without any preferred hint', () => {
    const resolved = resolveCapabilityTarget(
      { requiredCapabilities: ['code', 'patch', 'terminal'] },
      [gemini, claude, codex]
    );
    expect(resolved.provider).toBe('codex');
    expect(resolved.modelId).toBe('codex');
    expect(resolved.strategy).toBe('best-match');
    expect(resolved.unmetCapabilities).toEqual([]);
  });

  it('honors the preferred provider when it covers the requirements', () => {
    const resolved = resolveCapabilityTarget(
      { requiredCapabilities: ['deep_reasoning'], preferredProvider: 'claude' },
      [gemini, claude, codex]
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
      [claude, codex]
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
      [claude, codex]
    );
    expect(['claude', 'codex']).toContain(resolved.provider);
    expect(resolved.strategy).toBe('degraded');
    expect(resolved.rationale).toMatch(/rate-limited/);
  });

  it('flags degraded when nothing installed covers the requirement', () => {
    const resolved = resolveCapabilityTarget({ requiredCapabilities: ['patch', 'terminal'] }, [
      gemini,
      claude,
    ]);
    expect(resolved.strategy).toBe('degraded');
    expect(resolved.unmetCapabilities.length).toBeGreaterThan(0);
  });

  it('returns unresolved when no providers are installed', () => {
    const resolved = resolveCapabilityTarget(
      { requiredCapabilities: ['code'], preferredProvider: 'codex', preferredModelId: 'codex' },
      []
    );
    expect(resolved).toMatchObject({ provider: 'codex', modelId: 'codex', strategy: 'unresolved' });
  });

  it('never surfaces external harnesses without an injected registry', () => {
    const resolved = resolveCapabilityTarget({ requiredCapabilities: ['code'] }, [codex]);
    expect(resolved.provider).toBe('codex');
    expect(resolved.externalHarnesses).toBeUndefined();
  });

  it('surfaces an available external harness covering the required capabilities as advisory', () => {
    const registry = createExternalHarnessRegistry();
    registry.registerHarness({
      harness_id: 'openhands-acp',
      kind: 'acp',
      adapter_ref: 'acp-adapter',
      endpoint_or_command: 'https://acp.example.test/rpc',
      capabilities: ['code', 'terminal'],
      trust_tier: 'confidential',
      status: 'available',
      provider: 'openhands',
    });
    registry.registerHarness({
      harness_id: 'partial-cli',
      kind: 'cli',
      endpoint_or_command: 'partial exec',
      capabilities: ['code'],
      trust_tier: 'public',
      status: 'available',
    });
    registry.registerHarness({
      harness_id: 'down-cli',
      kind: 'cli',
      endpoint_or_command: 'down exec',
      capabilities: ['code', 'terminal'],
      trust_tier: 'public',
      status: 'unavailable',
    });

    const resolved = resolveCapabilityTarget(
      {
        requiredCapabilities: ['code', 'terminal'],
        externalHarnessRegistry: registry,
      },
      [codex]
    );

    // The provider/model decision is unchanged; the harness is advisory only.
    expect(resolved.provider).toBe('codex');
    expect(resolved.strategy).toBe('sole');
    // Only the fully-covering 'available' harness is surfaced — partial
    // coverage and non-available harnesses stay out of the advisory field.
    expect(resolved.externalHarnesses?.map((harness) => harness.harness_id)).toEqual([
      'openhands-acp',
    ]);
  });

  it('surfaces harnesses even when provider resolution is unresolved', () => {
    const registry = createExternalHarnessRegistry();
    registry.registerHarness({
      harness_id: 'openhands-acp',
      kind: 'acp',
      endpoint_or_command: 'https://acp.example.test/rpc',
      capabilities: ['patch', 'terminal'],
      trust_tier: 'confidential',
      status: 'available',
    });

    const resolved = resolveCapabilityTarget(
      {
        requiredCapabilities: ['patch', 'terminal'],
        externalHarnessRegistry: registry,
      },
      [gemini, claude]
    );

    expect(resolved.strategy).toBe('degraded');
    expect(resolved.externalHarnesses?.[0]?.harness_id).toBe('openhands-acp');
  });
});
