import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import { formatVetoTick, runApprovalInbox } from './approval_inbox.js';

function record(id: string, title: string): ApprovalRequestRecord {
  return { id, title } as ApprovalRequestRecord;
}

describe('approval_inbox', () => {
  it('formats a veto tick with every outcome and its errors', () => {
    const text = formatVetoTick({
      proceeded: [record('a', 'Merge PR 1')],
      fellBack: [record('b', 'Merge PR 2')],
      shadowElapsed: [record('c', 'Merge PR 3')],
      errors: [{ requestId: 'd', error: 'expired' }],
    });
    expect(text).toContain('proceeded: 1, fell back to a decision: 1, shadow elapsed: 1');
    expect(text).toContain('needs decision (undelivered): Merge PR 2 (b)');
    expect(text).toContain('- d: expired');
  });

  it('rejects unknown commands and bad --hours before reading the store', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    try {
      expect(await runApprovalInbox(['merge'])).toBeUndefined();
      expect(process.exitCode).toBe(2);
      process.exitCode = undefined;
      expect(await runApprovalInbox(['digest', '--hours', '0'])).toBeUndefined();
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = undefined;
      errors.mockRestore();
    }
  });
});
