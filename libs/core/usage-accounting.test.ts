import { describe, expect, it } from 'vitest';
import { normalizeUsageCause, USAGE_CAUSES } from './usage-accounting.js';

describe('usage accounting', () => {
  it('normalizes unknown or missing causes to the compatible assistant bucket', () => {
    expect(normalizeUsageCause(undefined)).toBe('assistant');
    expect(normalizeUsageCause('future-cause')).toBe('assistant');
    expect(normalizeUsageCause('compaction')).toBe('compaction');
  });

  it('exposes a closed cause vocabulary for reports and ledgers', () => {
    expect(USAGE_CAUSES).toContain('judge');
    expect(new Set(USAGE_CAUSES).size).toBe(USAGE_CAUSES.length);
  });
});
