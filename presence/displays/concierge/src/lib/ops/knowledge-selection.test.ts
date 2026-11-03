import { describe, expect, it } from 'vitest';
import { knowledgeSelectionAfterRefresh as select } from './knowledge-selection';

describe('knowledge candidate selection across refreshes', () => {
  const a = { tenant: 'tenant-a', version: 1 };
  const b = { tenant: 'tenant-b', version: 2 };

  it('moves implicit selection to the first visible row after switching tenants', () => {
    const first = select(['a-1', 'a-2'], null, null, a, a);
    expect(first).toBe('a-1');
    expect(select(['b-1'], first, null, b, b)).toBe('b-1');
  });

  it('keeps an explicitly requested unavailable row instead of selecting another candidate', () => {
    expect(select(['b-1'], 'a-1', 'unknown-link', b, b)).toBe('unknown-link');
    expect(select(['b-1'], 'a-1', 'a-1', b, b)).toBe('a-1');
  });

  it('preserves visible implicit selection but clears a removed last row', () => {
    expect(select(['a-1', 'a-2'], 'a-2', null, a, a)).toBe('a-2');
    expect(select([], 'a-2', null, a, a)).toBeNull();
  });

  it('ignores a late previous-tenant response and an older same-tenant refresh', () => {
    expect(select(['a-1'], 'b-1', null, a, b)).toBe('b-1');
    expect(select(['a-1'], 'a-2', null, a, { ...a, version: 2 })).toBe('a-2');
  });

  it('honors a deep link changed while the current refresh was awaiting recovery', () => {
    expect(select(['a-1', 'a-2'], 'a-1', 'a-2', a, a)).toBe('a-2');
  });
});
