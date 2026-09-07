import { describe, expect, it } from 'vitest';
import { formatElapsedDuration, shortNodeLabel } from './collaboration-tree-format';

describe('collaboration tree format helpers (AC-06)', () => {
  it('formats elapsed duration across the seconds/minutes/hours boundaries', () => {
    expect(formatElapsedDuration(undefined)).toBe('-');
    expect(formatElapsedDuration(-1)).toBe('-');
    expect(formatElapsedDuration(Number.NaN)).toBe('-');
    expect(formatElapsedDuration(0)).toBe('0s');
    expect(formatElapsedDuration(12_000)).toBe('12s');
    expect(formatElapsedDuration(185_000)).toBe('3m05s');
    expect(formatElapsedDuration(3_720_000)).toBe('1h02m');
  });

  it('strips the projection id prefix for a short label', () => {
    expect(shortNodeLabel('agent:agent-a')).toBe('agent-a');
    expect(shortNodeLabel('mission:MSN-1')).toBe('MSN-1');
    expect(shortNodeLabel('task:t-1')).toBe('t-1');
    expect(shortNodeLabel('human:approver')).toBe('approver');
    expect(shortNodeLabel('unprefixed')).toBe('unprefixed');
  });
});
