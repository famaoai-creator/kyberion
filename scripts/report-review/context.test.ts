import { describe, expect, it } from 'vitest';
import { createReportReviewContext, reviewReceiptLogicalPath } from './context.js';

describe('report-review context', () => {
  it('binds confidential artifact review to the tenant and session', () => {
    const context = createReportReviewContext({
      artifact_ref: 'artifact://tenant-a/report-1',
      viewer_principal: 'human:operator',
      tier: 'confidential',
      tenant_slug: 'tenant-a',
    });
    expect(context.scope.tenant_slug).toBe('tenant-a');
    expect(reviewReceiptLogicalPath(context)).toContain('/tenants/tenant-a/receipts/');
  });

  it('rejects a confidential review without a tenant', () => {
    expect(() =>
      createReportReviewContext({
        artifact_ref: 'artifact://private/report-1',
        viewer_principal: 'local-reviewer',
        tier: 'confidential',
      })
    ).toThrow('REVIEW_SCOPE_REQUIRED');
  });
});
