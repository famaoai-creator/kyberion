import { describe, expect, it } from 'vitest';
import {
  detectRouteCycle,
  isJudgeRouteCondition,
  selectJudgeRoute,
  type JudgeRouteCondition,
} from './judge-route.js';

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

  it.each([
    {},
    { field: 'decision.status' },
    { field: 'missing' },
    { field: 'missing', label: 'approve' },
    { field: 'missing', matches: '^$' },
    { field: 'decision.status', in: 'approve' },
    { field: 'decision.status', matches: '[' },
    { field: '', eq: 'approve' },
    { field: 'constructor.name', eq: 'Object' },
  ])('fails closed for incomplete or invalid condition %j', (when) => {
    const result = selectJudgeRoute({ label: 'approve', decision: { status: 'approve' } }, [
      { when: when as unknown as JudgeRouteCondition, next: 'COMPLETE' },
    ]);
    expect(result.selection).toMatchObject({ matched: false, next: 'ABORT' });
  });

  it.each([
    { field: 'decision.status', eq: 'approve' },
    { field: 'decision.status', in: ['approve', 'review'] },
    { field: 'decision.status', matches: '^approve$' },
    { label: 'approve' },
    { eq: 'approve' },
  ])('preserves explicit predicate matching for %j', (when) => {
    expect(
      selectJudgeRoute({ label: 'approve', decision: { status: 'approve' } }, [
        { when, next: 'COMPLETE' },
      ]).selection
    ).toMatchObject({ matched: true, next: 'COMPLETE' });
  });

  it('does not match a missing top-level label against an empty-string expression', () => {
    expect(
      selectJudgeRoute({}, [{ when: { matches: '^$' }, next: 'COMPLETE' }]).selection
    ).toMatchObject({ matched: false, next: 'ABORT' });
  });

  it.each([
    { label: 'approve' },
    { eq: 'approve' },
    { label: 'approve', field: 'decision.status', eq: 'ready' },
  ])('ignores an inherited verdict label for %j', (when) => {
    const verdict = Object.assign(Object.create({ label: 'approve' }), {
      decision: { status: 'ready' },
    });
    expect(selectJudgeRoute(verdict, [{ when, next: 'COMPLETE' }]).selection).toMatchObject({
      matched: false,
      next: 'ABORT',
    });
    expect(
      selectJudgeRoute({ ...verdict, label: 'approve' }, [{ when, next: 'COMPLETE' }]).selection
    ).toMatchObject({ matched: true, next: 'COMPLETE' });
  });

  it.each(['.', '.label', 'label.', 'decision..status', 'decision. .status'])(
    'rejects empty field-path segments in %s',
    (field) => {
      const when = { field, matches: '.*' };
      expect(isJudgeRouteCondition(when)).toBe(false);
      expect(
        selectJudgeRoute({ label: 'approve', decision: { status: 'ready' } }, [
          { when, next: 'COMPLETE' },
        ]).selection
      ).toMatchObject({ matched: false, next: 'ABORT' });
    }
  );

  it('preserves whitespace trimming around non-empty field-path segments', () => {
    expect(
      selectJudgeRoute({ decision: { status: 'ready' } }, [
        {
          when: { field: ' decision . status ', eq: 'ready' },
          next: 'COMPLETE',
        },
      ]).selection
    ).toMatchObject({ matched: true, next: 'COMPLETE' });
  });

  it('allows an explicit null comparison but never an absent field', () => {
    const routes = [{ when: { field: 'decision', eq: null }, next: 'COMPLETE' }];
    expect(selectJudgeRoute({ decision: null }, routes).selection.matched).toBe(true);
    expect(selectJudgeRoute({}, routes).selection.matched).toBe(false);
  });

  it('detects repeated and periodic route cycles', () => {
    expect(detectRouteCycle(['repair', 'repair'], 6).detected).toBe(true);
    expect(detectRouteCycle(['a', 'b', 'a', 'b'], 12)).toMatchObject({ detected: true });
    expect(detectRouteCycle(['a', 'b', 'c'], 12)).toEqual({ detected: false });
  });
});
