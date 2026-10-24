import { externalApprovalFixture } from '../../../../tests/helpers/external-approval-fixture.js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ gate: vi.fn(), run: vi.fn() }));
vi.mock('@agent/core/secure-io', async (original) => ({
  ...(await original<typeof import('@agent/core/secure-io')>()),
  safeExecResult: mocks.run,
}));
vi.mock('@agent/core/governance/approval-gate', () => ({ enforceApprovalGate: mocks.gate }));
vi.mock('@agent/core/governance/audit-chain', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('@agent/core/governance/external-operation-store', () => ({
  reserveExternalOperation: vi.fn(),
}));
vi.mock('@agent/core/pipeline/op-preflight-defaults', () => ({
  ensureDefaultOpPreflight: vi.fn(),
}));
vi.mock('@agent/core/workforce/artifact-store', () => ({
  writeScopedArtifact: vi.fn(() => ({
    repo_relative_path: 'active/shared/tmp/fixture-vcs-review.json',
    absolute_path: '/fixture/active/shared/tmp/fixture-vcs-review.json',
  })),
}));
import { registerOpPreflightListener, resetOpPreflight } from '@agent/core/pipeline/op-preflight';
import { withExternalOperationAuthority } from '@agent/core/governance/external-operation';
import { actuator, handleAction } from './index.js';

describe('VCS actuator public boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gate.mockReturnValue({ allowed: false, status: 'human_required' });
    mocks.run.mockImplementation((_bin: string, args: string[]) => ({
      status: 0,
      stderr: '',
      stdout:
        args[0] === 'remote'
          ? 'https://github.com/owner/repo.git'
          : args[0] === 'rev-parse'
            ? 'a'.repeat(40)
            : args[0] === 'symbolic-ref'
              ? 'feature'
              : '',
    }));
  });
  afterEach(() => resetOpPreflight());
  it('blocks direct and SDK push without authority', async () => {
    await expect(
      handleAction({ op: 'push', params: { cwd: '/fixture', ref: 'feature' } })
    ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    const result = await actuator.dispatch('push', { cwd: '/fixture', ref: 'feature' });
    expect(result.ok).toBe(false);
    expect(mocks.run.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false);
  });
  it('passes trusted runtime authority to the canonical gate', async () => {
    mocks.gate.mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    });
    await withExternalOperationAuthority(
      () => ({ agentId: 'trusted-owner', invocationId: 'owned-push' }),
      () => handleAction({ op: 'push', params: { cwd: '/fixture', ref: 'feature' } })
    );
    expect(mocks.gate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'trusted-owner',
        operationId: 'vcs:push',
        enqueueRequest: true,
        hasHuman: false,
      })
    );
    expect(mocks.run.mock.calls.filter(([, args]) => args[0] === 'push')).toHaveLength(1);
  });
  it('rejects model-supplied authority as invalid params', async () => {
    await expect(
      handleAction({
        op: 'push',
        params: { ref: 'feature', externalAuthority: { agentId: 'forged' } } as never,
      })
    ).rejects.toThrow('invalid input');
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('keeps preflight denial ahead of snapshots and publication', async () => {
    registerOpPreflightListener({
      id: 'vcs-block',
      run: () => ({ decision: 'block', reason: 'owner policy' }),
    });
    await expect(
      handleAction({ op: 'push', params: { cwd: '/fixture', ref: 'feature' } })
    ).rejects.toThrow('OP_PREFLIGHT_BLOCK');
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.gate).not.toHaveBeenCalled();
  });
});

vi.mock('@agent/core/governance/approval-store', async (original) => ({
  ...(await original<typeof import('@agent/core/governance/approval-store')>()),
  evaluateApprovalUsability: () => null,
  loadApprovalRequest: (_channel: string, id: string) => {
    const params = mocks.gate.mock.calls.at(-1)?.[0];
    return params ? externalApprovalFixture(params, id) : null;
  },
}));
