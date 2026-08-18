import { describe, expect, it } from 'vitest';
import { loadCoreSeamBindings } from './bindings.js';

describe('DH-03 seam bindings dump', () => {
  it('lists deterministic seam keys and multiplicities', () => {
    const bindings = loadCoreSeamBindings();
    expect(bindings.length).toBeGreaterThanOrEqual(13);
    expect(bindings.map((binding) => binding.key)).toEqual(
      [...bindings].map((binding) => binding.key).sort()
    );
    expect(bindings.find((binding) => binding.key === 'voice-bridge')?.multiplicity).toBe('sole');
    expect(bindings.find((binding) => binding.key === 'speech-to-text-bridge')?.multiplicity).toBe(
      'named'
    );
    const provider = bindings.find((binding) => binding.providers.length > 0)?.providers[0];
    expect(provider?.metadata.reason).toMatch(/^(provenance|source):/u);
  });
});
