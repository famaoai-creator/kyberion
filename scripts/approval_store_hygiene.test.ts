import { describe, expect, it } from 'vitest';
import {
  formatApprovalStoreHygieneReport,
  runApprovalStoreHygiene,
  type ApprovalStoreHygieneReport,
} from './approval_store_hygiene.js';

function report(dryRun: boolean): ApprovalStoreHygieneReport {
  return {
    dryRun,
    staleAfterDays: 14,
    pendingExpiry: {
      candidates: [
        {
          storageChannel: 'terminal',
          channel: 'terminal',
          requestId: 'a',
          requestedAt: '2026-09-01T00:00:00Z',
          reason: 'stale_pending',
        },
      ],
      applied: dryRun ? [] : ['a'],
      errors: [],
      dryRun,
    },
    fixturePurge: {
      candidates: [
        { storageChannel: 'plugin-install', requestId: 'b', logicalPath: 'x' },
        { storageChannel: 'plugin-install', requestId: 'c', logicalPath: 'y' },
      ],
      applied: [],
      errors: dryRun ? [] : ['plugin-install/b: denied'],
      dryRun,
    },
  };
}

describe('approval_store_hygiene', () => {
  it('summarizes a dry run by reason and channel without applied counts', () => {
    const text = formatApprovalStoreHygieneReport(report(true));
    expect(text).toContain('dry-run (pass --apply to act)');
    expect(text).toContain('Pending to expire: 1');
    expect(text).toContain('by reason: stale_pending=1');
    expect(text).toContain('Fixture records to trash: 2');
    expect(text).toContain('by channel: plugin-install=2');
    expect(text).not.toContain('expired:');
  });

  it('reports applied counts and errors after --apply', () => {
    const text = formatApprovalStoreHygieneReport(report(false));
    expect(text).toContain('expired: 1');
    expect(text).toContain('trashed: 0');
    expect(text).toContain('plugin-install/b: denied');
  });

  it('rejects a non-positive --stale-days before touching the store', async () => {
    process.exitCode = undefined;
    try {
      expect(await runApprovalStoreHygiene(['--stale-days', '0'])).toBeUndefined();
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = undefined;
    }
  });
});
