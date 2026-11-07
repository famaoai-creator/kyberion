import { describe, expect, it } from 'vitest';
import { fixedWindowLimiter } from './rate-limit.js';

describe('fixed window limiter', () => {
  it('denies within the window, expires exactly at its boundary and isolates keys', () => {
    const limiter = fixedWindowLimiter({ windowMs: 1000, maxKeys: 3, eviction: 'lru' });
    expect(limiter.take('a', 1, 0)).toEqual({ allowed: true });
    expect(limiter.take('a', 1, 250)).toEqual({ allowed: false, retryAfterMs: 750 });
    expect(limiter.take('b', 1, 250)).toEqual({ allowed: true });
    expect(limiter.take('a', 1, 1000)).toEqual({ allowed: true });
  });

  it('evicts the least recently used key, preserving a hot denied client', () => {
    const limiter = fixedWindowLimiter({ windowMs: 1000, maxKeys: 2, eviction: 'lru' });
    limiter.take('attacker', 1, 0);
    limiter.take('cold', 1, 1);
    expect(limiter.take('attacker', 1, 2).allowed).toBe(false);
    limiter.take('rotating', 1, 3);
    expect(limiter.size).toBe(2);
    expect(limiter.take('attacker', 1, 4).allowed).toBe(false);
  });

  it('sweeps expired keys before evicting live state and supports explicit FIFO', () => {
    const limiter = fixedWindowLimiter({ windowMs: 1000, maxKeys: 2, eviction: 'fifo' });
    limiter.take('expired', 1, 0);
    limiter.take('live', 1, 500);
    limiter.take('new', 1, 1000);
    expect(limiter.take('live', 1, 1001).allowed).toBe(false);
    limiter.clear();
    expect(limiter.size).toBe(0);
  });

  it('rejects invalid policies rather than disabling a boundary', () => {
    expect(() => fixedWindowLimiter({ windowMs: 0, maxKeys: 2, eviction: 'lru' })).toThrow();
    const limiter = fixedWindowLimiter({ windowMs: 1, maxKeys: 2, eviction: 'lru' });
    expect(() => limiter.take('a', NaN)).toThrow();
  });

  it('fails closed for new keys without resetting a denied live client', () => {
    const limiter = fixedWindowLimiter({ windowMs: 1000, maxKeys: 2, eviction: 'deny' });
    expect(limiter.take('a', 1, 0).allowed).toBe(true);
    expect(limiter.take('a', 1, 1).allowed).toBe(false);
    expect(limiter.take('b', 1, 2).allowed).toBe(true);
    expect(limiter.take('c', 1, 3).allowed).toBe(false);
    expect(limiter.take('a', 1, 4).allowed).toBe(false);
    expect(limiter.take('c', 1, 1001).allowed).toBe(true);
  });

  it('preserves explicit exclusive expiry and zero allowed requests', () => {
    const limiter = fixedWindowLimiter({
      windowMs: 1000,
      maxKeys: 2,
      eviction: 'deny',
      expireAtBoundary: false,
    });
    limiter.take('a', 1, 0);
    expect(limiter.take('a', 1, 1000).allowed).toBe(false);
    expect(limiter.take('a', 1, 1001).allowed).toBe(true);
    expect(limiter.take('zero', 0, 1001).allowed).toBe(false);
  });
});
