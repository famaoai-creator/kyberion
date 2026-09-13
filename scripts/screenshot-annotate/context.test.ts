import { describe, expect, it } from 'vitest';
import {
  createScreenshotAnnotateContext,
  screenshotAnnotateHandoffLogicalPath,
  screenshotAnnotateReceiptLogicalPath,
} from './context.js';

describe('screenshot-annotate context', () => {
  it('binds confidential pad sessions to the tenant', () => {
    const context = createScreenshotAnnotateContext({
      artifact_ref: 'artifact://tenant-a/shot-1',
      viewer_principal: 'human:operator',
      tier: 'confidential',
      tenant_slug: 'tenant-a',
    });
    expect(context.scope.tenant_slug).toBe('tenant-a');
    expect(context.session_id).toMatch(/^sa-/);
    expect(screenshotAnnotateReceiptLogicalPath(context)).toContain('/tenants/tenant-a/receipts/');
  });

  it('rejects a confidential pad without a tenant', () => {
    expect(() =>
      createScreenshotAnnotateContext({
        artifact_ref: 'artifact://private/shot-1',
        viewer_principal: 'local-annotator',
        tier: 'confidential',
      })
    ).toThrow('SCREENSHOT-ANNOTATE_SCOPE_REQUIRED');
  });

  it('derives handoff path beside the output directory', () => {
    expect(screenshotAnnotateHandoffLogicalPath('active/shared/tmp/screenshot-annotate')).toBe(
      'active/shared/tmp/screenshot-annotate/handoff.json'
    );
  });
});
