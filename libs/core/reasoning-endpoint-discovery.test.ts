import { describe, expect, it } from 'vitest';
import { discoverReasoningEndpoints } from './reasoning-endpoint-discovery.js';
import type { ReasoningRoutePolicy } from './reasoning-route-resolver.js';

describe('reasoning-endpoint-discovery', () => {
  it('keeps endpoint runtimes separate from CLI provider discovery', () => {
    const endpoints = discoverReasoningEndpoints({});

    expect(endpoints.map((entry) => entry.runtime)).toEqual(
      expect.arrayContaining(['nemotron-api', 'local', 'ollama'])
    );
    expect(endpoints.find((entry) => entry.runtime === 'nemotron-api')).toMatchObject({
      adapter: 'openai-compatible',
      status: 'not_configured',
    });
  });

  it('reports configuration without returning secret values', () => {
    const endpoints = discoverReasoningEndpoints({
      KYBERION_NEMOTRON_URL: 'https://integrate.api.nvidia.com/v1',
      KYBERION_LOCAL_LLM_URL: 'http://127.0.0.1:11434/v1',
      KYBERION_LOCAL_LLM_KEY: 'must-not-appear',
    });

    expect(endpoints.find((entry) => entry.runtime === 'nemotron-api')).toMatchObject({
      configured: true,
      status: 'configured',
    });
    expect(endpoints.find((entry) => entry.runtime === 'local')).toMatchObject({
      configured: true,
      status: 'configured',
    });
    expect(JSON.stringify(endpoints)).not.toContain('must-not-appear');
  });

  it('discovers newly registered env-backed runtimes without source changes', () => {
    const policy: Pick<ReasoningRoutePolicy, 'runtime_adapters'> = {
      runtime_adapters: {
        'custom-api': {
          adapter: 'openai-compatible',
          selection: {
            display_name: 'Custom API',
            availability: { kind: 'env_any', names: ['CUSTOM_API_URL'] },
          },
          endpoint_policy: 'public',
          capabilities: ['text'],
          supported_parameters: [],
        },
        'custom-cli': {
          adapter: 'custom-cli',
          selection: {
            display_name: 'Custom CLI',
            availability: { kind: 'provider_discovery' },
          },
          capabilities: ['text'],
          supported_parameters: [],
        },
      },
    };

    expect(
      discoverReasoningEndpoints({ CUSTOM_API_URL: 'https://example.test/v1' }, policy)
    ).toEqual([
      expect.objectContaining({
        runtime: 'custom-api',
        display_name: 'Custom API',
        configured: true,
      }),
    ]);
  });
});
