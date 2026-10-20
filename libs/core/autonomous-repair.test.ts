import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attemptAutonomousRepair } from './autonomous-repair.js';
import { sendOpsAlert } from './ops-alert.js';
import { classifyError } from './error-classifier.js';

vi.mock('./core.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('./ops-alert.js', () => ({
  sendOpsAlert: vi.fn(),
}));

const { validateAndRepairAdfMock } = vi.hoisted(() => ({
  validateAndRepairAdfMock: vi.fn(),
}));
vi.mock('./pipeline/adf-repair-agent.js', () => ({
  validateAndRepairAdf: validateAndRepairAdfMock,
}));

describe('attemptAutonomousRepair (AR-01 Task 4)', () => {
  beforeEach(() => {
    vi.mocked(sendOpsAlert).mockClear();
    validateAndRepairAdfMock.mockReset().mockResolvedValue({
      repaired: true,
      report: 'fixed the params',
    });
  });

  it('fails closed and escalates for sensitive categories (AO-03 §4)', async () => {
    const repaired = await attemptAutonomousRepair({
      step: { op: 'system:exec' },
      failure: { category: 'env_error', detail: 'missing API key' },
    });

    expect(repaired).toBe(false);
    expect(validateAndRepairAdfMock).not.toHaveBeenCalled();
    expect(sendOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'critical',
        dedupe_key: 'pipeline-repair-blocked:system:exec:env_error',
      })
    );
  });

  it.each([
    'auth',
    'permission_denied',
    'missing_secret',
    'governance_block',
    'tier_violation',
    'permission_error',
    'auth_error',
    'config_error',
    'env_error',
  ])('blocks file-backed repairs for sensitive category %s', async (category) => {
    expect(
      await attemptAutonomousRepair({
        step: { op: 'system:exec' },
        failure: { category, repairAction: 'change the environment' },
        pipelinePath: 'pipelines/sample.json',
      })
    ).toBe(false);
    expect(validateAndRepairAdfMock).not.toHaveBeenCalled();
    expect(sendOpsAlert).toHaveBeenCalledOnce();
    expect(sendOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ error_category: category }) })
    );
  });

  it.each([
    ['TIER_VIOLATION: access denied', 'tier_violation'],
    ['path-scope-policy refused this write', 'permission_denied'],
    ['VISUAL_REVIEW_GATE_BLOCKED', 'governance_block'],
  ])('blocks actual classifier output for %s', async (message, category) => {
    const failure = classifyError(new Error(message));
    expect(failure.category).toBe(category);
    expect(failure.repairAction).toBeTruthy();
    expect(
      await attemptAutonomousRepair({
        step: { op: 'file:write_file' },
        failure,
        pipelinePath: 'pipelines/sample.json',
      })
    ).toBe(false);
    expect(validateAndRepairAdfMock).not.toHaveBeenCalled();
    expect(sendOpsAlert).toHaveBeenCalledOnce();
  });

  it.each(['invalid_input', 'typed_flow', 'preflight'])(
    'preserves ordinary ADF repair for %s',
    async (category) => {
      expect(
        await attemptAutonomousRepair({
          step: { op: 'core:validate_flow' },
          failure: { category, repairAction: 'repair the contract' },
          pipelinePath: 'pipelines/sample.json',
        })
      ).toBe(true);
      expect(validateAndRepairAdfMock).toHaveBeenCalledOnce();
      expect(sendOpsAlert).not.toHaveBeenCalled();
    }
  );

  it('delegates file-backed repairs to the canonical ADF repair agent', async () => {
    const repaired = await attemptAutonomousRepair({
      step: { op: 'file:write_file', params: { path: 'x' } },
      failure: { category: 'validation_error', repairAction: 'fix the path param' },
      pipelinePath: 'pipelines/sample.json',
    });

    expect(repaired).toBe(true);
    expect(sendOpsAlert).not.toHaveBeenCalled();
    expect(validateAndRepairAdfMock).toHaveBeenCalledWith(
      'pipelines/sample.json',
      'pipeline-adf',
      expect.objectContaining({
        step: { op: 'file:write_file', params: { path: 'x' } },
        failure: expect.objectContaining({
          category: 'validation_error',
          repairAction: 'fix the path param',
        }),
      })
    );
  });

  it('forwards trust and approval decisions to project-local ADF repair', async () => {
    await attemptAutonomousRepair({
      step: { op: 'file:write_file' },
      failure: { category: 'validation_error' },
      pipelinePath: 'pipelines/project-local.json',
      trustResolved: true,
      projectTrustApprovalId: 'approval-project-local',
      policy: { effort: 'high', budget: { max_tokens: 500 } },
    });

    expect(validateAndRepairAdfMock).toHaveBeenCalledWith(
      'pipelines/project-local.json',
      'pipeline-adf',
      expect.objectContaining({
        trustResolved: true,
        projectTrustApprovalId: 'approval-project-local',
        delegationOptions: { effort: 'high', budget: { max_tokens: 500 } },
      })
    );
  });

  it('returns false when post-repair validation still fails', async () => {
    const repaired = await attemptAutonomousRepair({
      step: { op: 'file:write_file' },
      failure: { category: 'validation_error' },
      pipelinePath: 'pipelines/invalid.json',
      validate: async () => {
        throw new Error('ADF still invalid');
      },
    });

    expect(repaired).toBe(false);
  });

  it('fails closed for in-memory repairs without a durable ADF path', async () => {
    const repaired = await attemptAutonomousRepair({
      step: { op: 'file:read' },
      failure: { category: 'validation_error', detail: 'invalid JSON' },
    });

    expect(repaired).toBe(false);
    expect(validateAndRepairAdfMock).not.toHaveBeenCalled();
  });

  it('returns false when the canonical ADF repair cannot validate the result', async () => {
    validateAndRepairAdfMock.mockResolvedValue({
      repaired: false,
      errors: ['steps[0].op: unknown operation'],
    });
    const repaired = await attemptAutonomousRepair({
      step: { op: 'unknown:op' },
      failure: { category: 'validation_error', detail: 'unknown op' },
      pipelinePath: 'pipelines/semantic.json',
    });

    expect(repaired).toBe(false);
    expect(validateAndRepairAdfMock).toHaveBeenCalledOnce();
  });

  it('returns false when the canonical repair agent itself fails', async () => {
    validateAndRepairAdfMock.mockRejectedValue(new Error('backend down'));
    const repaired = await attemptAutonomousRepair({
      step: { op: 'file:write_file' },
      failure: { category: 'validation_error' },
      pipelinePath: 'pipelines/sample.json',
    });

    expect(repaired).toBe(false);
  });
});
