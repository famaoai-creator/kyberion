import { describe, expect, it } from 'vitest';
import { parseConnectionReviewInput } from './connection-review-input';

describe('parseConnectionReviewInput', () => {
  it('accepts the canonical review payload', () => {
    expect(
      parseConnectionReviewInput({
        bindingId: 'BIND-GITHUB-1',
        action: 'approve',
        note: 'reviewed',
        tenant: 'acme',
      })
    ).toEqual({
      bindingId: 'BIND-GITHUB-1',
      action: 'approve',
      note: 'reviewed',
      tenant: 'acme',
    });
  });

  it('rejects malformed, unsafe, and unknown fields before mutation', () => {
    expect(() => parseConnectionReviewInput({ bindingId: '../escape', action: 'delete' })).toThrow(
      'bindingId'
    );
    expect(() =>
      parseConnectionReviewInput({ bindingId: 'BIND-1', action: { value: 'delete' } })
    ).toThrow('action');
    expect(() =>
      parseConnectionReviewInput({ bindingId: 'BIND-1', action: 'delete', note: [] })
    ).toThrow('note');
    expect(() =>
      parseConnectionReviewInput({ bindingId: 'BIND-1', action: 'delete', extra: true })
    ).toThrow('unexpected connection review field');
  });
});
