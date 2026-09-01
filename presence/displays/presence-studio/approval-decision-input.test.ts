import { describe, expect, it } from 'vitest';
import { presenceStudioApprovalDecisionSchema } from './security.js';

describe('presence studio approval decision input', () => {
  it('accepts only the governed decision enum', () => {
    expect(presenceStudioApprovalDecisionSchema.safeParse({ decision: 'approved' }).success).toBe(
      true
    );
    expect(presenceStudioApprovalDecisionSchema.safeParse({ decision: 'rejected' }).success).toBe(
      true
    );
  });

  it.each([
    undefined,
    null,
    [],
    { decision: 'pending' },
    { decision: 'approved', note: 'unexpected field' },
    { decision: ['approved'] },
  ])('rejects malformed or expanded input: %j', (value) => {
    expect(presenceStudioApprovalDecisionSchema.safeParse(value).success).toBe(false);
  });
});
