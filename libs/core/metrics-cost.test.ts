import { beforeEach, describe, expect, it } from 'vitest';
import { loadModelCostRegistry, resetModelCostRegistryCache, resolveCostRates } from './metrics.js';

describe('model-cost registry — data-driven (not source-hardcoded)', () => {
  beforeEach(() => resetModelCostRegistryCache());

  it('loads rates from the knowledge-tier JSON registry', () => {
    const reg = loadModelCostRegistry();
    // claude-haiku-4-5 lives only in the file (not in the built-in fallback) —
    // its presence proves the registry was read from disk, not hardcoded.
    expect(reg.models['claude-haiku-4-5']).toBeDefined();
    expect(reg.models['claude-opus-4-8']).toEqual({ prompt: 0.005, completion: 0.025 });
    expect(reg.models['claude-fable-5']).toEqual({ prompt: 0.01, completion: 0.05 });
    expect(reg.aliases?.opus).toBe('claude-opus-4-8');
    expect(reg.aliases?.fable).toBe('claude-fable-5');
  });
});

describe('resolveCostRates — per-model cost resolution', () => {
  beforeEach(() => resetModelCostRegistryCache());

  it('exact-matches a known model id', () => {
    const r = resolveCostRates('gpt-4o');
    expect(r.prompt).toBeGreaterThan(0);
    expect(r.completion).toBeGreaterThan(r.prompt);
  });

  it('substring-matches versioned ids to their family rates', () => {
    expect(resolveCostRates('claude-opus-4-8-20990101')).toEqual(resolveCostRates('opus'));
    expect(resolveCostRates('claude-sonnet-4-6')).toEqual(resolveCostRates('sonnet'));
    expect(resolveCostRates('gemini-2.0-flash-exp')).toEqual(resolveCostRates('gemini-2.0-flash'));
  });

  it('falls back to default for unknown models', () => {
    expect(resolveCostRates('totally-unknown-model-xyz')).toEqual({
      prompt: 0.001 / 1000,
      completion: 0.003 / 1000,
    });
  });
});
