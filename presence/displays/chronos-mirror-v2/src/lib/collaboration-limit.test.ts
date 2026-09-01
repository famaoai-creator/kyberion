import { describe, expect, it } from 'vitest';
import { normalizeCollaborationLimit } from './collaboration-limit';

describe('normalizeCollaborationLimit', () => {
  it.each([
    [null, 100],
    ['', 100],
    ['25.9', 25],
    ['0', 1],
    ['999', 500],
    ['not-a-number', 100],
    ['Infinity', 100],
  ])('normalizes %s to %s', (value, expected) => {
    expect(normalizeCollaborationLimit(value)).toBe(expected);
  });
});
