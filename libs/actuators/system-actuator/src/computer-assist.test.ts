import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateWithTools = vi.fn();
vi.mock('@agent/core/reasoning/reasoning-backend', () => ({
  getReasoningBackend: () => ({ generateWithTools }),
}));

import { executeComputerAssist } from './computer-assist.js';

const input = {
  version: '0.1' as const,
  kind: 'computer_assist' as const,
  goal: 'Open the editor',
  observation: 'Desktop is idle',
};

describe('computer assist', () => {
  beforeEach(() => generateWithTools.mockReset());

  it('executes one validated typed action and requires a fresh observation next', async () => {
    generateWithTools.mockResolvedValue({
      toolCalls: [
        { name: 'computer_action', input: { type: 'app_launch', application: 'Editor' } },
      ],
    });
    const execute = vi.fn().mockResolvedValue({ status: 'succeeded' });

    const result = await executeComputerAssist(input, execute);

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pipeline',
        options: { max_steps: 1, timeout_ms: 15_000 },
      })
    );
    expect(result).toMatchObject({ status: 'succeeded', next_observation_required: true });
    expect(generateWithTools.mock.calls[0][1][0].name).toBe('computer_action');
  });

  it('fails closed when the backend returns free text instead of one tool call', async () => {
    generateWithTools.mockResolvedValue({ text: 'click the first thing' });
    const execute = vi.fn();

    await expect(executeComputerAssist(input, execute)).rejects.toThrow(/exactly one structured/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects attempts to include arbitrary commands or extra fields', async () => {
    generateWithTools.mockResolvedValue({
      toolCalls: [
        {
          name: 'computer_action',
          input: { type: 'left_click', x: 2, y: 3, command: 'powershell Remove-Item' },
        },
      ],
    });
    const execute = vi.fn();

    await expect(executeComputerAssist(input, execute)).rejects.toThrow(
      /unsupported action fields/
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('asks for clarification without running an operation when the model is uncertain', async () => {
    generateWithTools.mockResolvedValue({
      toolCalls: [{ name: 'computer_action', input: { type: 'clarify', reason: 'Which window?' } }],
    });
    const execute = vi.fn();

    await expect(executeComputerAssist(input, execute)).resolves.toMatchObject({
      status: 'needs_clarification',
      reason: 'Which window?',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('propagates actuator failures instead of reporting the assist as successful', async () => {
    generateWithTools.mockResolvedValue({
      toolCalls: [
        { name: 'computer_action', input: { type: 'app_launch', application: 'Chrome' } },
      ],
    });
    const execute = vi.fn().mockResolvedValue({
      status: 'failed',
      results: [{ op: 'app_launch', status: 'failed', error: 'not found' }],
    });

    await expect(executeComputerAssist(input, execute)).resolves.toMatchObject({
      status: 'failed',
    });
  });
});
