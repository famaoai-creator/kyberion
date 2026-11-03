import { describe, expect, it } from 'vitest';
import { parseDeliverableReviewInput } from './deliverable-review-input';

describe('parseDeliverableReviewInput', () => {
  it('accepts the canonical review payload', () => {
    expect(
      parseDeliverableReviewInput({
        artifactId: 'ART-123',
        verdict: 'reject',
        comment: 'needs correction',
        reasonCategory: 'wrong-direction',
        tenant: 'acme',
      })
    ).toMatchObject({
      artifactId: 'ART-123',
      verdict: 'reject',
      reasonCategory: 'wrong_direction',
      tenant: 'acme',
    });
  });

  it('rejects unsafe ids, malformed values, and unknown fields', () => {
    expect(() => parseDeliverableReviewInput({ artifactId: '../x', verdict: 'accept' })).toThrow(
      'artifactId'
    );
    expect(() => parseDeliverableReviewInput({ artifactId: 'ART-1', verdict: 'later' })).toThrow(
      'verdict'
    );
    expect(() =>
      parseDeliverableReviewInput({ artifactId: 'ART-1', verdict: 'reject', comment: [] })
    ).toThrow('comment');
    expect(() =>
      parseDeliverableReviewInput({ artifactId: 'ART-1', verdict: 'reject', extra: true })
    ).toThrow('unexpected deliverable review field');
  });
});
