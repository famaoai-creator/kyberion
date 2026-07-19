import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAFETY_MARGIN_TOKENS,
  computeCompletionTokenBudget,
  estimateRequestInputTokens,
  resolveConfiguredContextWindowTokens,
} from './completion-token-budget.js';

describe('computeCompletionTokenBudget', () => {
  it('keeps the configured max when the window has plenty of headroom', () => {
    expect(
      computeCompletionTokenBudget({
        contextWindowTokens: 200_000,
        estimatedInputTokens: 10_000,
        configuredMaxTokens: 16_000,
      })
    ).toBe(16_000);
  });

  it('shrinks to the remaining budget when the input nears the window', () => {
    const budget = computeCompletionTokenBudget({
      contextWindowTokens: 200_000,
      estimatedInputTokens: 190_000,
      configuredMaxTokens: 16_000,
    });
    expect(budget).toBe(200_000 - 190_000 - DEFAULT_SAFETY_MARGIN_TOKENS);
    expect(budget).toBeLessThan(16_000);
    expect(190_000 + budget + DEFAULT_SAFETY_MARGIN_TOKENS).toBeLessThanOrEqual(200_000);
  });

  it('passes the configured max through when the window is unknown', () => {
    for (const contextWindowTokens of [undefined, Number.NaN, 0, -1]) {
      expect(
        computeCompletionTokenBudget({
          contextWindowTokens,
          estimatedInputTokens: 999_999,
          configuredMaxTokens: 16_000,
        })
      ).toBe(16_000);
    }
  });

  it('returns zero when no safe completion budget remains', () => {
    expect(
      computeCompletionTokenBudget({
        contextWindowTokens: 200_000,
        estimatedInputTokens: 250_000,
        configuredMaxTokens: 16_000,
      })
    ).toBe(0);
    expect(
      computeCompletionTokenBudget({
        contextWindowTokens: 200_000,
        estimatedInputTokens: 250_000,
        configuredMaxTokens: 16_000,
        floorTokens: 4_096,
      })
    ).toBe(0);
  });

  it('never exceeds the safe remaining budget even when the floor is higher', () => {
    expect(
      computeCompletionTokenBudget({
        contextWindowTokens: 200_000,
        estimatedInputTokens: 199_500,
        configuredMaxTokens: 2_048,
        floorTokens: 8_000,
      })
    ).toBe(0);
  });

  it('honors a custom safety margin', () => {
    expect(
      computeCompletionTokenBudget({
        contextWindowTokens: 200_000,
        estimatedInputTokens: 190_000,
        configuredMaxTokens: 16_000,
        safetyMarginTokens: 5_000,
      })
    ).toBe(5_000);
  });
});

describe('estimateRequestInputTokens', () => {
  it('estimates from the serialized payload with the compaction heuristic', () => {
    const payload = { messages: [{ role: 'user', content: 'x'.repeat(300) }] };
    expect(estimateRequestInputTokens(payload)).toBe(Math.ceil(JSON.stringify(payload).length / 3));
  });

  it('returns 0 for unserializable payloads', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(estimateRequestInputTokens(circular)).toBe(0);
  });
});

describe('resolveConfiguredContextWindowTokens', () => {
  it('returns the explicitly configured window', () => {
    expect(resolveConfiguredContextWindowTokens({ KYBERION_CONTEXT_WINDOW_TOKENS: '32000' })).toBe(
      32_000
    );
  });

  it('returns undefined when unset or invalid', () => {
    expect(resolveConfiguredContextWindowTokens({})).toBeUndefined();
    expect(
      resolveConfiguredContextWindowTokens({ KYBERION_CONTEXT_WINDOW_TOKENS: 'abc' })
    ).toBeUndefined();
    expect(
      resolveConfiguredContextWindowTokens({ KYBERION_CONTEXT_WINDOW_TOKENS: '-5' })
    ).toBeUndefined();
  });
});
