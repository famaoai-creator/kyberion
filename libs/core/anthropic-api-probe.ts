import { secureFetch } from './network.js';
import { assertReasoningEgressAllowedAtEndpoint } from './reasoning-egress-scope.js';

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** Probe Anthropic credentials without consuming model tokens. */
export async function probeAnthropicApiBackendAvailability(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ available: boolean; reason?: string }> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return { available: false, reason: 'ANTHROPIC_API_KEY is not set' };
  }

  const baseUrl = (env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_ANTHROPIC_BASE_URL).replace(
    /\/+$/u,
    ''
  );
  const url = `${baseUrl}/v1/models`;
  try {
    assertReasoningEgressAllowedAtEndpoint('anthropic', url);
    await secureFetch({
      method: 'GET',
      url,
      headers: {
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
      authenticateRequest: true,
      timeout: 4_000,
    });
    return { available: true };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
