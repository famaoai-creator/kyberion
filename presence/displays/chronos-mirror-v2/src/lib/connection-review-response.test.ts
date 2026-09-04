import { describe, expect, it } from 'vitest';
import { parseConnectionReviewResponse } from './connection-review-response';

describe('parseConnectionReviewResponse', () => {
  it('accepts the review fields used by the connection list', () => {
    expect(
      parseConnectionReviewResponse({
        ok: true,
        review: { action: 'hold', note: 'wait', reviewed_at: '2026-09-04T00:00:00.000Z' },
      })
    ).toEqual({
      ok: true,
      review: { action: 'hold', note: 'wait', reviewed_at: '2026-09-04T00:00:00.000Z' },
    });
  });

  it.each([
    ['not ok', { ok: false, review: { action: 'hold', reviewed_at: 'now' } }],
    ['invalid action', { ok: true, review: { action: 'execute', reviewed_at: 'now' } }],
    ['invalid note', { ok: true, review: { action: 'hold', note: [], reviewed_at: 'now' } }],
    ['missing timestamp', { ok: true, review: { action: 'hold' } }],
    [
      'dangerous key',
      { ok: true, review: { action: 'hold', reviewed_at: 'now', ['__proto__']: {} } },
    ],
  ])('rejects %s', (_label, value) => {
    expect(parseConnectionReviewResponse(value)).toBeUndefined();
  });
});
