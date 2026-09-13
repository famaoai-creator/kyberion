import { describe, expect, it } from 'vitest';
import {
  createClipboardInboxContext,
  clipboardInboxHandoffLogicalPath,
  clipboardInboxReceiptLogicalPath,
} from './context.js';

describe('clipboard-inbox context', () => {
  it('binds confidential pad sessions to the tenant', () => {
    const context = createClipboardInboxContext({
      artifact_ref: 'artifact://tenant-a/clip-1',
      viewer_principal: 'human:operator',
      tier: 'confidential',
      tenant_slug: 'tenant-a',
    });
    expect(context.scope.tenant_slug).toBe('tenant-a');
    expect(context.session_id).toMatch(/^ci-/);
    expect(clipboardInboxReceiptLogicalPath(context)).toContain('/tenants/tenant-a/receipts/');
  });

  it('rejects a confidential pad without a tenant', () => {
    expect(() =>
      createClipboardInboxContext({
        artifact_ref: 'artifact://private/clip-1',
        viewer_principal: 'local-clipper',
        tier: 'confidential',
      })
    ).toThrow('CLIPBOARD-INBOX_SCOPE_REQUIRED');
  });

  it('derives handoff path beside the output directory', () => {
    expect(clipboardInboxHandoffLogicalPath('active/shared/tmp/clipboard-inbox')).toBe(
      'active/shared/tmp/clipboard-inbox/handoff.json'
    );
  });
});
