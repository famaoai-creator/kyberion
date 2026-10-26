import { describe, expect, it, vi } from 'vitest';
import { createScopedRuntimeApprovalHandler } from './agent-task-approval.js';
import { AgentRuntimeApprovalPendingError } from './agent-prompt-approval-port.js';

describe('native runtime approval bridge', () => {
  it('persists a scoped pending request, then resumes one approved decision without disclosing content', async () => {
    let status: 'pending' | 'approved' = 'pending';
    const approvals = {
      open: vi.fn(() => ({ id: 'approval-1', created: false })),
      status: vi.fn(() => status),
      consume: vi.fn(),
    };
    const current = vi.fn();
    const handler = createScopedRuntimeApprovalHandler({
      agentId: 'agent-a',
      provider: 'codex',
      cwd: '/task',
      missionId: 'MSN-A',
      scope: { tier: 'confidential', tenant_slug: 'tenant-a', mission_id: 'MSN-A' },
      approvals,
      assertCurrent: current,
      authorize: () => true,
      recordRequest: () => 'artifact:native-request-a',
    });
    await expect(
      handler('item/fileChange/requestApproval', { privateText: 'confidential body' })
    ).rejects.toBeInstanceOf(AgentRuntimeApprovalPendingError);
    expect(JSON.stringify(approvals.open.mock.calls)).not.toContain('confidential body');
    expect(approvals.consume).not.toHaveBeenCalled();
    status = 'approved';
    await expect(
      handler('item/fileChange/requestApproval', { privateText: 'confidential body' })
    ).resolves.toBe(true);
    expect(approvals.open.mock.calls[0]).toEqual(approvals.open.mock.calls[1]);
    expect(approvals.consume).toHaveBeenCalledWith('approval-1', true);
    expect(current).toHaveBeenCalledTimes(3);
  });

  it('does not share an approval across scope or accept a revoked claim', async () => {
    const approvals = {
      open: vi.fn(() => ({ id: 'approval-2', created: false })),
      status: vi.fn(() => 'pending' as const),
      consume: vi.fn(),
    };
    for (const tenant_slug of ['tenant-a', 'tenant-b']) {
      const handler = createScopedRuntimeApprovalHandler({
        agentId: 'agent',
        provider: 'codex',
        cwd: '/task',
        scope: { tier: 'confidential', tenant_slug },
        approvals,
        authorize: () => true,
        recordRequest: () => 'artifact:native-request-a',
      });
      await expect(handler('item/fileChange/requestApproval', {})).rejects.toBeInstanceOf(
        AgentRuntimeApprovalPendingError
      );
    }
    expect(approvals.open.mock.calls[0][0].signatureId).not.toEqual(
      approvals.open.mock.calls[1][0].signatureId
    );
    const stale = createScopedRuntimeApprovalHandler({
      agentId: 'agent',
      provider: 'codex',
      cwd: '/task',
      scope: { tier: 'public' },
      approvals,
      assertCurrent: () => {
        throw new Error('lease expired');
      },
    });
    await expect(stale('item/fileChange/requestApproval', {})).rejects.toThrow('lease expired');
    expect(approvals.open).toHaveBeenCalledTimes(2);
  });

  it('never opens or consumes approval for an ungranted operation or root', async () => {
    const approvals = {
      open: vi.fn(() => ({ id: 'already-approved', created: false })),
      status: vi.fn(() => 'approved' as const),
      consume: vi.fn(),
    };
    const recordRequest = vi.fn(() => 'artifact:request');
    const handler = createScopedRuntimeApprovalHandler({
      agentId: 'agent',
      provider: 'codex',
      cwd: '/task',
      scope: { tier: 'public' },
      approvals,
      authorize: (method, params) =>
        method === 'item/fileChange/requestApproval' && params.path === '/task/output.txt',
      recordRequest,
    });
    expect(await handler('item/commandExecution/requestApproval', { command: 'anything' })).toBe(
      false
    );
    expect(
      await handler('item/fileChange/requestApproval', { path: '/other-tenant/private.txt' })
    ).toBe(false);
    expect(approvals.open).not.toHaveBeenCalled();
    expect(approvals.consume).not.toHaveBeenCalled();
    expect(recordRequest).not.toHaveBeenCalled();
    const unbound = createScopedRuntimeApprovalHandler({
      agentId: 'agent',
      provider: 'codex',
      cwd: '/task',
      scope: { tier: 'public' },
      approvals,
    });
    expect(await unbound('item/fileChange/requestApproval', { path: '/task/output.txt' })).toBe(
      false
    );
  });
});
