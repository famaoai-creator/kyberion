import { describe, expect, it } from 'vitest';
import { buildApiProviderBundle } from './reasoning-api-provider.js';

describe('reasoning API provider module', () => {
  it('returns undefined for modes owned by another provider family', () => {
    expect(buildApiProviderBundle({ mode: 'claude-cli' })).toBeUndefined();
    expect(buildApiProviderBundle({ mode: 'local' })).toBeUndefined();
  });

  it('keeps unavailable hosted API modes out of the runtime chain', () => {
    expect(
      buildApiProviderBundle({
        mode: 'gemini-api',
        env: { GEMINI_API_KEY: '' },
      })
    ).toBeNull();
    expect(
      buildApiProviderBundle({
        mode: 'grok-api',
        env: { XAI_API_KEY: '' },
      })
    ).toBeNull();
    expect(
      buildApiProviderBundle({
        mode: 'openrouter',
        env: { OPENROUTER_API_KEY: '' },
      })
    ).toBeNull();
  });
});
