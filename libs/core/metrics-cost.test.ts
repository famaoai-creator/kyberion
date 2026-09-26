import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadModelCostRegistry,
  _resetModelCostRegistryCacheForTests,
  resolveCostRates,
} from './metrics.js';

describe('model-cost registry — data-driven (not source-hardcoded)', () => {
  beforeEach(() => _resetModelCostRegistryCacheForTests());

  it('loads rates from the knowledge-tier JSON registry', () => {
    const reg = loadModelCostRegistry();
    // claude-haiku-4-5 lives only in the file — its presence proves the
    // registry was read from disk, not hardcoded.
    expect(reg.models['claude-haiku-4-5']).toBeDefined();
    expect(reg.models['claude-opus-5']).toEqual({ prompt: 0.005, completion: 0.025 });
    expect(reg.models['claude-opus-4-8']).toEqual({ prompt: 0.005, completion: 0.025 });
    expect(reg.models['claude-fable-5']).toEqual({ prompt: 0.01, completion: 0.05 });
    expect(reg.aliases?.opus).toBe('claude-opus-5-5');
    expect(reg.aliases?.fable).toBe('claude-fable-5');
  });
});

describe('resolveCostRates — per-model cost resolution', () => {
  beforeEach(() => _resetModelCostRegistryCacheForTests());

  it('exact-matches a known model id', () => {
    const r = resolveCostRates('gpt-4o');
    expect(r.prompt).toBeGreaterThan(0);
    expect(r.completion).toBeGreaterThan(r.prompt);
  });

  it('substring-matches versioned ids to their family rates', () => {
    expect(resolveCostRates('claude-opus-5-5-20990101')).toEqual(resolveCostRates('opus'));
    expect(resolveCostRates('claude-opus-5-20990101')).toEqual(resolveCostRates('claude-opus-5'));
    expect(resolveCostRates('claude-sonnet-5-20990101')).toEqual(resolveCostRates('sonnet'));
    // Sonnet 4.6 keeps its own (higher) price rather than inheriting Sonnet 5's via the alias.
    expect(resolveCostRates('claude-sonnet-4-6-20990101')).toEqual(
      resolveCostRates('claude-sonnet-4-6')
    );
    expect(resolveCostRates('claude-sonnet-4-6').prompt).toBeCloseTo(0.003 / 1000);
    expect(resolveCostRates('gemini-2.0-flash-exp')).toEqual(resolveCostRates('gemini-2.0-flash'));
  });

  it('resolves claude-opus-5-5 to its own rates, not the claude-opus-5 prefix', () => {
    const r = resolveCostRates('claude-opus-5-5');
    expect(r.prompt).toBeCloseTo(0.004 / 1000);
    expect(r.completion).toBeCloseTo(0.02 / 1000);
    expect(r.cache_read).toBeCloseTo(0.0002 / 1000);
    expect(resolveCostRates('claude-opus-5-5[1m]')).toEqual(r);
    expect(resolveCostRates('claude-opus-5-20990101')).not.toEqual(r);
  });

  it('prices Grok 4.7 and the Fast serving tier, including the 200k long-context row', () => {
    const standard = resolveCostRates('grok-4.7', 199_999);
    expect(standard.prompt).toBeCloseTo(0.002 / 1000);
    expect(standard.completion).toBeCloseTo(0.006 / 1000);
    expect(standard.cache_read).toBeCloseTo(0.0005 / 1000);

    const longContext = resolveCostRates('xai:grok-4.7', 200_000);
    expect(longContext.prompt).toBeCloseTo(0.004 / 1000);
    expect(longContext.completion).toBeCloseTo(0.012 / 1000);
    expect(longContext.cache_read).toBeCloseTo(0.001 / 1000);

    expect(resolveCostRates('grok-4.6', 0)).toEqual(resolveCostRates('grok-4.7', 0));
    expect(resolveCostRates('grok-4.5', 0).cache_read).toBeCloseTo(0.0003 / 1000);

    const fast = resolveCostRates('grok-4.7-fast', 0);
    expect(fast.prompt).toBeCloseTo(0.004 / 1000);
    expect(fast.completion).toBeCloseTo(0.012 / 1000);
    expect(resolveCostRates('grok-4.7-build-fast', 200_000).completion).toBeCloseTo(0.018 / 1000);
    expect(resolveCostRates('grok-4.7-build-fast', 200_000).cache_read).toBeCloseTo(0.0015 / 1000);
  });

  it('falls back to default for unknown models', () => {
    expect(resolveCostRates('totally-unknown-model-xyz')).toEqual({
      prompt: 0.001 / 1000,
      completion: 0.003 / 1000,
    });
  });
});
