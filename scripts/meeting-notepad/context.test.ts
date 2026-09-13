import { describe, expect, it } from 'vitest';
import {
  createMeetingNotepadContext,
  meetingNotepadHandoffLogicalPath,
  meetingNotepadReceiptLogicalPath,
} from './context.js';

describe('meeting-notepad context', () => {
  it('binds confidential notepad sessions to the tenant', () => {
    const context = createMeetingNotepadContext({
      artifact_ref: 'artifact://tenant-a/notepad-1',
      viewer_principal: 'human:operator',
      tier: 'confidential',
      tenant_slug: 'tenant-a',
    });
    expect(context.scope.tenant_slug).toBe('tenant-a');
    expect(meetingNotepadReceiptLogicalPath(context)).toContain('/tenants/tenant-a/receipts/');
  });

  it('rejects a confidential notepad without a tenant', () => {
    expect(() =>
      createMeetingNotepadContext({
        artifact_ref: 'artifact://private/notepad-1',
        viewer_principal: 'local-noter',
        tier: 'confidential',
      })
    ).toThrow('NOTEPAD_SCOPE_REQUIRED');
  });

  it('derives handoff path beside the output directory', () => {
    expect(meetingNotepadHandoffLogicalPath('active/shared/tmp/meeting-notepad')).toBe(
      'active/shared/tmp/meeting-notepad/handoff.json'
    );
  });
});
