import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attemptAutonomousRepair } from './autonomous-repair.js';
import { sendOpsAlert } from './ops-alert.js';
import { getReasoningBackend } from './reasoning-backend.js';

vi.mock('./core.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('./ops-alert.js', () => ({
  sendOpsAlert: vi.fn(),
}));

const delegateTask = vi.fn();
vi.mock('./reasoning-backend.js', () => ({
  getReasoningBackend: vi.fn(() => ({ delegateTask })),
}));

describe('attemptAutonomousRepair (AR-01 Task 4)', () => {
  beforeEach(() => {
    vi.mocked(sendOpsAlert).mockClear();
    vi.mocked(getReasoningBackend).mockClear();
    delegateTask.mockReset().mockResolvedValue('fixed the params');
  });

  it('fails closed and escalates for sensitive categories (AO-03 §4)', async () => {
    const repaired = await attemptAutonomousRepair({
      step: { op: 'system:exec' },
      failure: { category: 'env_error', detail: 'missing API key' },
    });

    expect(repaired).toBe(false);
    expect(delegateTask).not.toHaveBeenCalled();
    expect(sendOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'critical',
        dedupe_key: 'pipeline-repair-blocked:system:exec:env_error',
      })
    );
  });

  it('delegates safe repairs and reports success', async () => {
    const repaired = await attemptAutonomousRepair({
      step: { op: 'file:write_file', params: { path: 'x' } },
      failure: { category: 'validation_error', repairAction: 'fix the path param' },
      pipelinePath: 'pipelines/sample.json',
    });

    expect(repaired).toBe(true);
    expect(sendOpsAlert).not.toHaveBeenCalled();
    expect(delegateTask).toHaveBeenCalledTimes(1);
    const [instruction] = delegateTask.mock.calls[0];
    expect(instruction).toContain('pipelines/sample.json');
    expect(instruction).toContain('fix the path param');
  });

  it('returns false when post-repair validation still fails', async () => {
    const repaired = await attemptAutonomousRepair({
      step: { op: 'file:write_file' },
      failure: { category: 'validation_error' },
      validate: async () => {
        throw new Error('ADF still invalid');
      },
    });

    expect(repaired).toBe(false);
  });

  it('returns false when the repair subagent itself fails', async () => {
    delegateTask.mockRejectedValue(new Error('backend down'));
    const repaired = await attemptAutonomousRepair({
      step: { op: 'file:write_file' },
      failure: { category: 'validation_error' },
    });

    expect(repaired).toBe(false);
  });
});
