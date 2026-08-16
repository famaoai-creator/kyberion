import { describe, expect, it } from 'vitest';
import { detectRouteCycle, selectJudgeRoute } from './judge-route.js';

describe('judge route', () => {
  it('selects the first matching route deterministically', () => {
    const result = selectJudgeRoute({ label: 'review', decision: { status: 'needs_changes' } }, [
      { when: { label: 'approve' }, next: 'complete' },
      { when: { field: 'decision.status', eq: 'needs_changes' }, next: 'repair' },
      { next: 'fallback' },
    ]);

    expect(result.selection).toMatchObject({ matched: true, next: 'repair', route_index: 1 });
  });

  it('fails closed when no route matches by default', () => {
    const result = selectJudgeRoute({ label: 'unknown' }, [
      { when: { label: 'approve' }, next: 'complete' },
    ]);

    expect(result.selection).toMatchObject({ matched: false, next: 'ABORT' });
  });

  it('detects repeated and periodic route cycles', () => {
    expect(detectRouteCycle(['repair', 'repair'], 6).detected).toBe(true);
    expect(detectRouteCycle(['a', 'b', 'a', 'b'], 12)).toMatchObject({ detected: true });
    expect(detectRouteCycle(['a', 'b', 'c'], 12)).toEqual({ detected: false });
  });
});
