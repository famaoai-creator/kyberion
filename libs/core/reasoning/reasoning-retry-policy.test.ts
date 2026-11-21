import { describe, expect, it } from 'vitest';
import {
  MAX_IN_PLACE_RETRY_DELAY_MS,
  readRetryAfterMs,
  resolveDemotionRetryAfterMs,
  resolveInPlaceRetryDelayMs,
} from './reasoning-retry-policy.js';

describe('resolveInPlaceRetryDelayMs', () => {
  it('preserves a modest server-supplied Retry-After', () => {
    const error = { retryAfterMs: 2_000 };
    expect(resolveInPlaceRetryDelayMs(error, 1)).toBe(2_000);
  });

  it('caps an unbounded server-supplied Retry-After', () => {
    const error = { response: { headers: { 'retry-after': '999999' } } };
    expect(resolveInPlaceRetryDelayMs(error, 1)).toBe(MAX_IN_PLACE_RETRY_DELAY_MS);
  });

  it('caps a numeric retryAfterMs beyond the ceiling', () => {
    const error = { retryAfterMs: MAX_IN_PLACE_RETRY_DELAY_MS * 10 };
    expect(resolveInPlaceRetryDelayMs(error, 1)).toBe(MAX_IN_PLACE_RETRY_DELAY_MS);
  });

  it('keeps the exponential fallback bounded', () => {
    for (let attempt = 1; attempt < 40; attempt += 1) {
      expect(resolveInPlaceRetryDelayMs(new Error('boom'), attempt)).toBeLessThanOrEqual(
        MAX_IN_PLACE_RETRY_DELAY_MS
      );
    }
  });
});

describe('resolveDemotionRetryAfterMs', () => {
  it('is not clamped by the in-place ceiling', () => {
    const error = { retryAfterMs: MAX_IN_PLACE_RETRY_DELAY_MS * 10 };
    expect(resolveDemotionRetryAfterMs(error)).toBe(MAX_IN_PLACE_RETRY_DELAY_MS * 10);
  });
});

describe('readRetryAfterMs', () => {
  it('reads numeric retry-after header seconds', () => {
    const error = { headers: { 'retry-after': '5' } };
    expect(readRetryAfterMs(error)).toBe(5_000);
  });
});
