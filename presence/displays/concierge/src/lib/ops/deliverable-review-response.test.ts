import { describe, expect, it } from 'vitest';
import { parseDeliverableReviewResponse } from './deliverable-review-response';

describe('parseDeliverableReviewResponse', () => {
  it('accepts the state used to select the next artifact', () => {
    expect(
      parseDeliverableReviewResponse({
        ok: true,
        review: { verdict: 'request-changes' },
        state: { current_artifact_id: 'ART-2' },
      })
    ).toEqual({ ok: true, state: { current_artifact_id: 'ART-2' } });
  });

  it.each([
    ['not ok', { ok: false, state: { current_artifact_id: 'ART-2' } }],
    ['missing state', { ok: true }],
    ['empty artifact', { ok: true, state: { current_artifact_id: '' } }],
    ['array state', { ok: true, state: [] }],
    [
      'dangerous key',
      { ok: true, state: { current_artifact_id: 'ART-2', ['__proto__']: { polluted: true } } },
    ],
  ])('rejects %s', (_label, value) => {
    expect(parseDeliverableReviewResponse(value)).toBeUndefined();
  });
});
