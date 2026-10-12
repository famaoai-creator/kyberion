import { describe, expect, it } from 'vitest';
import { resolveAgentProviderTarget } from './agent-provider-resolution.js';
import type { ProviderInfo } from '../provider/provider-discovery.js';

function provider(
  providerId: string,
  models: string[],
  installed = true,
  modelCapabilities: Record<string, string[]> = {}
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
    const resolved = resolveAgentProviderTarget(
      {
        preferredProvider: 'agy',
        preferredModelId: 'Gemini 3.6 Flash (Medium)',
      },
      [
        provider('agy', ['Gemini 3.6 Flash (Medium)', 'Gemini 3.7 Flash (Medium)'], true, {
          'Gemini 3.6 Flash (Medium)': ['surface', 'conversation', 'structured_json'],
          'Gemini 3.7 Flash (Medium)': ['reasoning', 'analysis', 'structured_json', 'long_context'],
        }),
        provider('claude', ['sonnet'], true, {
          sonnet: ['reasoning', 'analysis'],
        }),
      ]
    );

    expect(resolved).toMatchObject({
      provider: 'agy',
      modelId: 'Gemini 3.6 Flash (Medium)',
      strategy: 'preferred',
    });
  });

  it('chooses the model that best matches the required capabilities', () => {
    const resolved = resolveAgentProviderTarget(
      {
        preferredProvider: 'agy',
        preferredModelId: 'Gemini 3.7 Flash (Medium)',
        requiredCapabilities: ['surface', 'conversation', 'structured_json'],
      },
      [
        provider('agy', ['Gemini 3.6 Flash (Medium)', 'Gemini 3.7 Flash (Medium)'], true, {
          'Gemini 3.6 Flash (Medium)': [
            'surface',
            'conversation',
            'structured_json',
            'low_latency',
          ],
          'Gemini 3.7 Flash (Medium)': ['reasoning', 'analysis', 'structured_json', 'long_context'],
        }),
      ]
    );

    expect(resolved).toMatchObject({
      provider: 'agy',
      modelId: 'Gemini 3.6 Flash (Medium)',
      strategy: 'preferred',
    });
  });

  it('falls back to an installed provider when the preferred provider is unavailable', () => {
    const resolved = resolveAgentProviderTarget(
      {
        preferredProvider: 'gemini',
        preferredModelId: 'gemini-2.5-flash',
        requiredCapabilities: ['code', 'patch', 'terminal'],
      },
      [
        provider('claude', ['sonnet', 'opus'], true, {
          sonnet: ['reasoning', 'analysis', 'review', 'code'],
          opus: ['reasoning', 'analysis', 'review', 'code'],
        }),
        provider('codex', ['codex'], true, {
          codex: ['code', 'implementation', 'patch', 'terminal'],
        }),
      ]
    );

    expect(resolved).toMatchObject({
      provider: 'codex',
      modelId: 'codex',
      strategy: 'fallback',
    });
  });

  it('excludes obsolete Gemini ACP from agent-runtime provider selection', () => {
    const resolved = resolveAgentProviderTarget(
      {
        preferredProvider: 'gemini',
        preferredModelId: 'auto-gemini-2.5',
        requiredCapabilities: ['reasoning', 'coordination'],
      },
      [
        provider('gemini', ['auto-gemini-2.5'], true, {
          'auto-gemini-2.5': ['reasoning', 'coordination'],
        }),
        provider('agy', ['Gemini 3.6 Flash (Medium)'], true, {
          'Gemini 3.6 Flash (Medium)': ['reasoning', 'coordination'],
        }),
      ]
    );

    expect(resolved.provider).toBe('agy');
    expect(resolved.strategy).toBe('fallback');
  });

  it('does not fall back when strategy is strict', () => {
    const resolved = resolveAgentProviderTarget(
      {
        preferredProvider: 'gemini',
        preferredModelId: 'gemini-2.5-flash',
        providerStrategy: 'strict',
      },
      [provider('claude', ['sonnet']), provider('codex', ['codex'])]
    );

    expect(resolved).toMatchObject({
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
      strategy: 'unresolved',
    });
  });

  it('restricts fallback to the configured provider allowlist', () => {
    const resolved = resolveAgentProviderTarget(
      {
        preferredProvider: 'gemini',
        providerStrategy: 'preferred',
        fallbackProviders: ['codex'],
      },
      [provider('claude', ['sonnet']), provider('codex', ['codex'])]
    );

    expect(resolved).toMatchObject({
      provider: 'codex',
      modelId: 'codex',
      strategy: 'fallback',
    });
  });

  it('keeps the preferred target when nothing installed is discoverable', () => {
    const resolved = resolveAgentProviderTarget(
      {
        preferredProvider: 'codex',
        preferredModelId: 'gpt-5',
      },
      []
    );

    expect(resolved).toMatchObject({
      provider: 'codex',
      modelId: 'gpt-5',
      strategy: 'unresolved',
    });
  });
});

describe('explicit agent provider selection', () => {
  const catalog: ProviderInfo[] = [
    {
      ...provider('claude', ['small', 'large'], true, {
        small: ['conversation'],
        large: ['reasoning'],
      }),
      capabilities: ['terminal'],
    },
    {
      ...provider('codex', ['exact'], true, { exact: ['reasoning', 'code'] }),
      capabilities: ['terminal'],
    },
  ];

  it('holds the exact fixed provider/model and records its explicit mode', () => {
    expect(
      resolveAgentProviderTarget(
        {
          preferredProvider: 'claude',
          preferredModelId: 'large',
          selectionMode: 'fixed',
          fixedProvider: 'codex',
          fixedModelId: 'exact',
          requiredCapabilities: ['code', 'terminal'],
        },
        catalog
      )
    ).toMatchObject({ provider: 'codex', modelId: 'exact', selectionMode: 'fixed' });
  });

  it('fails closed for an unavailable fixed provider instead of falling back', () => {
    expect(() =>
      resolveAgentProviderTarget(
        {
          preferredProvider: 'claude',
          selectionMode: 'fixed',
          fixedProvider: 'missing',
        },
        catalog
      )
    ).toThrow(/AGENT_SELECTION_PROVIDER_UNAVAILABLE/);
    expect(() =>
      resolveAgentProviderTarget(
        {
          preferredProvider: 'claude',
          selectionMode: 'fixed',
          fixedProvider: 'claude',
        },
        catalog.map((entry) => ({ ...entry, healthy: false }))
      )
    ).toThrow(/AGENT_SELECTION_PROVIDER_UNAVAILABLE/);
  });

  it('rejects unknown exact model IDs without substituting a default or alias', () => {
    expect(() =>
      resolveAgentProviderTarget(
        {
          preferredProvider: 'claude',
          preferredModelId: 'large',
          selectionMode: 'fixed',
          fixedProvider: 'claude',
          fixedModelId: 'unknown-exact',
        },
        catalog
      )
    ).toThrow(/AGENT_SELECTION_MODEL_UNAVAILABLE/);
  });

  it('does not borrow another model capability to make a fixed model eligible', () => {
    expect(() =>
      resolveAgentProviderTarget(
        {
          preferredProvider: 'claude',
          selectionMode: 'fixed',
          fixedProvider: 'claude',
          fixedModelId: 'small',
          requiredCapabilities: ['reasoning'],
        },
        catalog
      )
    ).toThrow(/required capabilities/);
  });

  it('fixes only the supplied provider dimension and chooses an eligible model', () => {
    expect(
      resolveAgentProviderTarget(
        {
          preferredProvider: 'claude',
          preferredModelId: 'small',
          selectionMode: 'fixed',
          fixedProvider: 'claude',
          requiredCapabilities: ['reasoning'],
        },
        catalog
      )
    ).toMatchObject({ provider: 'claude', modelId: 'large' });
  });

  it('fixes only the supplied model dimension and can select another provider', () => {
    expect(
      resolveAgentProviderTarget(
        {
          preferredProvider: 'claude',
          selectionMode: 'fixed',
          fixedModelId: 'exact',
          requiredCapabilities: ['code'],
        },
        catalog
      )
    ).toMatchObject({ provider: 'codex', modelId: 'exact' });
  });

  it('prefers an eligible preferred provider and model before alternatives', () => {
    expect(
      resolveAgentProviderTarget(
        {
          preferredProvider: 'claude',
          preferredModelId: 'large',
          selectionMode: 'preferred',
          requiredCapabilities: ['reasoning'],
        },
        catalog
      )
    ).toMatchObject({ provider: 'claude', modelId: 'large' });
  });

  it.each(['auto', 'preferred', 'fixed'] as const)(
    'enforces hard requirements in explicit %s mode',
    (selectionMode) => {
      expect(() =>
        resolveAgentProviderTarget(
          {
            preferredProvider: 'claude',
            selectionMode,
            requiredCapabilities: ['unavailable-capability'],
          },
          catalog
        )
      ).toThrow(/required capabilities/);
      expect(() =>
        resolveAgentProviderTarget({ preferredProvider: 'claude', selectionMode }, [])
      ).toThrow(/AGENT_SELECTION_UNAVAILABLE/);
    }
  );
});
