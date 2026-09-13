import { describe, expect, it } from 'vitest';
import {
  createMemoryCaptureContext,
  memoryCaptureHandoffLogicalPath,
  memoryCaptureReceiptLogicalPath,
} from './context.js';

describe('memory-capture context', () => {
  it('binds confidential pad sessions to the tenant', () => {
    const context = createMemoryCaptureContext({
      artifact_ref: 'artifact://tenant-a/memory-1',
      viewer_principal: 'human:operator',
      tier: 'confidential',
      tenant_slug: 'tenant-a',
    });
    expect(context.scope.tenant_slug).toBe('tenant-a');
    expect(context.session_id).toMatch(/^mc-/);
    expect(memoryCaptureReceiptLogicalPath(context)).toContain('/tenants/tenant-a/receipts/');
  });

  it('rejects a confidential pad without a tenant', () => {
    expect(() =>
      createMemoryCaptureContext({
        artifact_ref: 'artifact://private/memory-1',
        viewer_principal: 'local-noter',
        tier: 'confidential',
      })
    ).toThrow('MEMORY-CAPTURE_SCOPE_REQUIRED');
  });

  it('derives handoff path beside the output directory', () => {
    expect(memoryCaptureHandoffLogicalPath('active/shared/tmp/memory-capture')).toBe(
      'active/shared/tmp/memory-capture/handoff.json'
    );
  });
});
