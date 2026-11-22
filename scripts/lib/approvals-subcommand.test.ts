import { describe, expect, it, vi } from 'vitest';

import { ScriptExitError } from './harness.js';
import { handleApprovalsSubcommand } from './approvals-subcommand.js';

const { listApprovalRequests, delegateApprovalToCharter } = vi.hoisted(() => ({
  listApprovalRequests: vi.fn(),
  delegateApprovalToCharter: vi.fn(),
}));

vi.mock('@agent/core/governance/approval-store', () => ({ listApprovalRequests }));
vi.mock('./approval-cli-delegate.js', () => ({ delegateApprovalToCharter }));

const ui = (key: string) => key;

describe('handleApprovalsSubcommand --delegate', () => {
  it('exits non-zero when the pending request is not found', async () => {
    listApprovalRequests.mockReturnValue([]);
    await expect(
      handleApprovalsSubcommand({ delegate: 'missing-id' }, ui, () => {})
    ).rejects.toBeInstanceOf(ScriptExitError);
  });

  it('exits non-zero when delegation is refused (ok:false)', async () => {
    listApprovalRequests.mockReturnValue([{ id: 'req-1' }]);
    delegateApprovalToCharter.mockReturnValue({ ok: false });
    await expect(
      handleApprovalsSubcommand({ delegate: 'req-1' }, ui, () => {})
    ).rejects.toBeInstanceOf(ScriptExitError);
  });

  it('returns without a decision when delegation succeeds (ok:true)', async () => {
    listApprovalRequests.mockReturnValue([{ id: 'req-1' }]);
    delegateApprovalToCharter.mockReturnValue({ ok: true });
    await expect(
      handleApprovalsSubcommand({ delegate: 'req-1' }, ui, () => {})
    ).resolves.toBeUndefined();
    expect(delegateApprovalToCharter).toHaveBeenCalledWith(
      { id: 'req-1' },
      undefined,
      expect.any(Function)
    );
  });
});
