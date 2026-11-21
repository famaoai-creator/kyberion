import { describe, expect, it } from 'vitest';
import { committableDueDate } from './WorkItemBoard';

describe('committableDueDate', () => {
  it('sends only a finished, changed date', () => {
    expect(committableDueDate('2026-11-30', undefined)).toBe(true);
    expect(committableDueDate('2026-11-30', '2026-11-29')).toBe(true);
    expect(committableDueDate('2026-11-30', '2026-11-30')).toBe(false);
    expect(committableDueDate('', '2026-11-30')).toBe(false);
  });

  it('never sends the half-typed years a date field reports per keystroke', () => {
    for (const draft of ['0002-11-30', '0020-11-30', '0202-11-30', '1969-12-31', '3000-01-01']) {
      expect(committableDueDate(draft, '2026-11-30')).toBe(false);
    }
  });
});
