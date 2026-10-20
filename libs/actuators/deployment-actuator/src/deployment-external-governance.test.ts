import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deploy: vi.fn(),
  legacy: vi.fn(),
  gate: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@agent/core/actuator/deployment-adapter', () => ({
  getDeploymentAdapter: () => ({ name: 'test', deploy: mocks.deploy }),
}));
vi.mock('@agent/core/risky-op-registry', () => ({
  RISKY_OPS: { CONFIG_UPDATE: 'config:update' },
  requireApprovalForOp: mocks.legacy,
}));
vi.mock('@agent/core/governance/approval-gate', () => ({ enforceApprovalGate: mocks.gate }));
vi.mock('@agent/core/governance/audit-chain', () => ({ auditChain: { record: mocks.audit } }));
vi.mock('@agent/core/governance/external-operation-store', () => ({
  reserveExternalOperation: vi.fn(),
}));
vi.mock('@agent/core/pipeline/op-preflight-defaults', () => ({
  ensureDefaultOpPreflight: vi.fn(),
}));
vi.mock('@agent/core/pipeline/op-preflight', async (original) => ({
  ...(await original<typeof import('@agent/core/pipeline/op-preflight')>()),
  runOpPreflight: vi.fn(async ({ params }) => ({ decision: 'allow', input: params })),
}));
import {
  withExternalOperationAuthority,
  withExternalOperationPipelineRun,
} from '@agent/core/governance/external-operation';
import { handleDeploymentAction } from './deployment-actuator-helpers.js';

const params = {
  mission_id: 'test-mission',
  project_name: 'test-project',
  version: 'v1',
  environment: 'staging',
};
const dispatch = () => handleDeploymentAction({ action: 'deploy_release', params });

describe('deployment external governance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.legacy.mockReturnValue({ allowed: true, status: 'approved' });
    mocks.gate.mockReturnValue({ allowed: true, status: 'approved' });
    mocks.deploy.mockResolvedValue({ adapter: 'test', status: 'triggered', started_at: 'test' });
  });

  it('preserves the configuration policy floor inside one resumable decision', async () => {
    await dispatch();
    expect(mocks.gate).toHaveBeenCalledTimes(1);
    expect(mocks.gate).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'deployment:deploy_release',
        intentId: 'config:update',
        payload: expect.objectContaining({ scope: 'governance' }),
      })
    );
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it('requires common approval before the adapter is invoked', async () => {
    mocks.gate.mockReturnValue({ allowed: false, status: 'pending' });
    await expect(dispatch()).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(mocks.deploy).not.toHaveBeenCalled();
  });

  it('does not offer delegated authority for opaque release effects', async () => {
    await withExternalOperationAuthority(
      () => ({ agentId: 'test', invocationId: 'test-deploy' }),
      dispatch
    );
    expect(mocks.gate).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'deployment:deploy_release', requireApproval: true })
    );
    expect(mocks.gate.mock.calls[0]![0].charter).toBeUndefined();
    expect(mocks.deploy).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'succeeded' }) })
    );
  });

  it.each(['failed', 'dry_run'])('does not claim confirmed execution for %s', async (status) => {
    mocks.deploy.mockResolvedValue({ status });
    await expect(dispatch()).rejects.toMatchObject({ adfControlFlow: 'preflight' });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'unknown' }) })
    );
  });

  it('records ambiguous failure without retrying deployment', async () => {
    mocks.deploy.mockRejectedValue(new Error('connection lost after dispatch'));
    await expect(dispatch()).rejects.toThrow('connection lost');
    expect(mocks.deploy).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'unknown' }) })
    );
  });

  it('rejects multiple uncheckpointed deploys before any effect', async () => {
    await expect(
      withExternalOperationPipelineRun('run', () =>
        handleDeploymentAction({
          action: 'pipeline',
          steps: [
            { type: 'apply', op: 'deploy_release', params },
            { type: 'apply', op: 'deploy_release', params },
          ],
        })
      )
    ).rejects.toThrow('EXTERNAL_BATCH_CHECKPOINT_REQUIRED');
    expect(mocks.legacy).not.toHaveBeenCalled();
    expect(mocks.deploy).not.toHaveBeenCalled();
  });
});
