import { describe, expect, it } from 'vitest';
import { parseInflightLimit } from './inflight-limit.js';

describe('parseInflightLimit', () => {
  it('uses the fallback for missing values and accepts bounded positive integers', () => {
    expect(parseInflightLimit(undefined, 8)).toEqual({ value: 8, invalid: false });
    expect(parseInflightLimit('  ', 8)).toEqual({ value: 8, invalid: false });
    expect(parseInflightLimit('16', 8)).toEqual({ value: 16, invalid: false });
  });

  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '257', 'bad'])(
    'rejects invalid limit %s consistently',
    (raw) => {
      expect(parseInflightLimit(raw, 8)).toEqual({ value: 8, invalid: true });
    }
  );
});
