import { describe, expect, it } from 'vitest';
import { saveServiceBindingRecord } from '@agent/core/service-binding-registry';
import { listConnectionReviewItems, recordConnectionReview } from './connection-review';

describe('connection review', () => {
  it('records a decision for a service binding', () => {
    const bindingId = `BIND-REVIEW-${Date.now()}`;
    saveServiceBindingRecord({
      binding_id: bindingId,
      service_type: 'chat',
      scope: 'tenant',
      target: 'slack',
      allowed_actions: ['post'],
      secret_refs: [],
      approval_policy: { post: 'approval_required' },
      service_id: 'slack',
    });

    const review = recordConnectionReview({
      bindingId,
      action: 'approve',
      note: 'looks good',
      reviewer: 'tester',
      reviewRole: 'mission_controller',
    });

    expect(review.action).toBe('approve');
    expect(
      listConnectionReviewItems().some(
        (item) => item.binding_id === bindingId && item.reviewAction === 'approve'
      )
    ).toBe(true);
  });
});
