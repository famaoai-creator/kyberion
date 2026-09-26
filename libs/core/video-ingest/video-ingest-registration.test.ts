import { describe, expect, it } from 'vitest';
import { registerRiskyApprovalHandler } from '../risky-op-approval-port.js';

describe('video-ingest entry', () => {
  it('registers the governed risky-op approval handler (vision:fetch_video is never ungated)', async () => {
    await import('./index.js');
    expect(() =>
      registerRiskyApprovalHandler(() => ({ allowed: true, status: 'approved' }))
    ).toThrow('RISKY_APPROVAL_HANDLER_ALREADY_REGISTERED');
  });
});
