import { describe, expect, it, vi } from 'vitest';

import { ScriptExitError } from './harness.js';
import { handleApprovalsSubcommand } from './approvals-subcommand.js';

const {
  listApprovalRequests,
  delegateApprovalToCharter,
  decideApprovalFromCli,
  listCliPendingApprovals,
  cliApprovalStoreScope,
} = vi.hoisted(() => ({
  listApprovalRequests: vi.fn(),
  delegateApprovalToCharter: vi.fn(),
  decideApprovalFromCli: vi.fn(),
  listCliPendingApprovals: vi.fn(),
  cliApprovalStoreScope: vi.fn(),
}));

vi.mock('@agent/core/governance/approval-store', () => ({ listApprovalRequests }));
vi.mock('./approval-cli-delegate.js', () => ({ delegateApprovalToCharter }));
vi.mock('./approval-cli-decision.js', () => ({
  decideApprovalFromCli,
  findRevocableApproval: vi.fn(),
  revokeApprovalFromCli: vi.fn(),
}));
vi.mock('./cli-personal-approvals.js', () => ({ listCliPendingApprovals, cliApprovalStoreScope }));

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

describe('handleApprovalsSubcommand personal approvals', () => {
  const personal = { id: 'p-1', title: 'Onboarding action authority', scope: { tier: 'personal' } };

  it('lists the owner personal partition alongside the ordinary store', async () => {
    listCliPendingApprovals.mockReturnValue([personal]);
    const printed: unknown[] = [];
    await handleApprovalsSubcommand({}, ui, (line) => printed.push(line));
    expect(listCliPendingApprovals).toHaveBeenCalledWith(expect.any(Function));
    expect(printed).toContain('  ● [p-1] Onboarding action authority');
  });

  it('decides a personal request inside its store scope', async () => {
    const storeScope = <T>(run: () => T) => run();
    listCliPendingApprovals.mockReturnValue([personal]);
    cliApprovalStoreScope.mockReturnValue(storeScope);
    decideApprovalFromCli.mockResolvedValue({ ...personal, status: 'approved' });
    await handleApprovalsSubcommand({ approve: 'p-1' }, ui, () => {});
    expect(cliApprovalStoreScope).toHaveBeenCalledWith(personal);
    expect(decideApprovalFromCli).toHaveBeenCalledWith(
      personal,
      expect.objectContaining({ decision: 'approved', storeScope })
    );
  });

  it('decides an ordinary request without a store scope', async () => {
    const ordinary = { id: 'o-1', title: 'Ordinary' };
    listCliPendingApprovals.mockReturnValue([ordinary]);
    cliApprovalStoreScope.mockReturnValue(undefined);
    decideApprovalFromCli.mockResolvedValue({ ...ordinary, status: 'rejected' });
    await handleApprovalsSubcommand({ deny: 'o-1' }, ui, () => {});
    expect(decideApprovalFromCli.mock.calls.at(-1)?.[1]).not.toHaveProperty('storeScope');
  });
});
