import { describe, expect, it } from 'vitest';
import { readSurfaceStringParam } from './surface-request-input.js';

describe('surface request input', () => {
  it('accepts only scalar strings without changing their contents', () => {
    expect(readSurfaceStringParam(' mission-1 ')).toBe(' mission-1 ');
    expect(readSurfaceStringParam('')).toBe('');
  });

  it.each([undefined, null, ['mission-1'], { value: 'mission-1' }])(
    'rejects non-scalar values: %j',
    (value) => {
      expect(readSurfaceStringParam(value)).toBeUndefined();
    }
  );
});
