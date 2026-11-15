import { describe, expect, it } from 'vitest';
import { checkReasoningProviderRegistry } from './check_reasoning_provider_registry.js';

describe('reasoning provider registry checker', () => {
  it('keeps policy modes, provider descriptors, and implementation modules aligned', () => {
    const result = checkReasoningProviderRegistry();
    expect(result.modes).toBeGreaterThan(0);
    expect(result.providers).toBeGreaterThan(0);
  });
});
