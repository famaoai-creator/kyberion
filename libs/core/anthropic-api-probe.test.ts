import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  secureFetch: vi.fn(),
  assertReasoningEgressAllowedAtEndpoint: vi.fn(),
}));

vi.mock('./network.js', () => ({ secureFetch: mocks.secureFetch }));
vi.mock('./reasoning-egress-scope.js', () => ({
  assertReasoningEgressAllowedAtEndpoint: mocks.assertReasoningEgressAllowedAtEndpoint,
}));

import { probeAnthropicApiBackendAvailability } from './anthropic-api-probe.js';

describe('anthropic-api-probe', () => {
  it('does not contact the provider when the API key is missing', async () => {
    mocks.secureFetch.mockReset();
    const result = await probeAnthropicApiBackendAvailability({});
    expect(result).toEqual({ available: false, reason: 'ANTHROPIC_API_KEY is not set' });
    expect(mocks.secureFetch).not.toHaveBeenCalled();
  });

  it('verifies the API key through the non-generative models endpoint', async () => {
    mocks.secureFetch.mockReset().mockResolvedValue({ data: [] });
    mocks.assertReasoningEgressAllowedAtEndpoint.mockReset();

    const result = await probeAnthropicApiBackendAvailability({
      ANTHROPIC_API_KEY: 'secret-value',
    });

    expect(result).toEqual({ available: true });
    expect(mocks.assertReasoningEgressAllowedAtEndpoint).toHaveBeenCalledWith(
      'anthropic',
      'https://api.anthropic.com/v1/models'
    );
    expect(mocks.secureFetch).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://api.anthropic.com/v1/models',
      headers: {
        'anthropic-version': '2023-06-01',
        'x-api-key': 'secret-value',
      },
      authenticateRequest: true,
      timeout: 4_000,
    });
  });

  it('reports provider rejection without returning the credential', async () => {
    mocks.secureFetch.mockReset().mockRejectedValue(new Error('Network Error (401)'));
    const result = await probeAnthropicApiBackendAvailability({
      ANTHROPIC_API_KEY: 'secret-value',
    });
    expect(result.available).toBe(false);
    expect(result.reason).toContain('401');
    expect(result.reason).not.toContain('secret-value');
  });
});
