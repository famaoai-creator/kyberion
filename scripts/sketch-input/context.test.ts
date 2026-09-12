import { describe, expect, it } from 'vitest';
import {
  createSketchInputContext,
  sketchHandoffLogicalPath,
  sketchReceiptLogicalPath,
} from './context.js';

describe('sketch-input context', () => {
  it('binds confidential sketch sessions to the tenant', () => {
    const context = createSketchInputContext({
      artifact_ref: 'artifact://tenant-a/sketch-1',
      viewer_principal: 'human:operator',
      tier: 'confidential',
      tenant_slug: 'tenant-a',
    });
    expect(context.scope.tenant_slug).toBe('tenant-a');
    expect(sketchReceiptLogicalPath(context)).toContain('/tenants/tenant-a/receipts/');
  });

  it('rejects a confidential sketch without a tenant', () => {
    expect(() =>
      createSketchInputContext({
        artifact_ref: 'artifact://private/sketch-1',
        viewer_principal: 'local-sketcher',
        tier: 'confidential',
      })
    ).toThrow('SKETCH_SCOPE_REQUIRED');
  });

  it('derives handoff path beside the png', () => {
    expect(sketchHandoffLogicalPath('active/shared/tmp/sketch-input/latest.png')).toBe(
      'active/shared/tmp/sketch-input/latest.handoff.json'
    );
  });
});
