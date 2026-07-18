import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediatorInstances: Array<{
  options: Record<string, unknown>;
  instance: {
    boot: ReturnType<typeof vi.fn>;
    ask: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
  };
}> = [];

vi.mock('./acp-mediator.js', () => ({
  ACPMediator: class MockACPMediator {
    boot = vi.fn().mockResolvedValue(undefined);
    ask = vi.fn().mockResolvedValue('Copilot response');
    shutdown = vi.fn().mockResolvedValue(undefined);

    constructor(options: Record<string, unknown>) {
      mediatorInstances.push({ options, instance: this });
    }
  },
}));

import { CopilotAcpReasoningBackend } from './copilot-acp-reasoning-backend.js';

describe('CopilotAcpReasoningBackend', () => {
  beforeEach(() => {
    mediatorInstances.length = 0;
  });

  it('starts Copilot through ACP without granting all permissions', async () => {
    const backend = new CopilotAcpReasoningBackend({
      command: 'gh',
      model: 'copilot-test-model',
    });

    await expect(backend.prompt('Summarize the task')).resolves.toBe('Copilot response');

    expect(mediatorInstances[0]?.options).toMatchObject({
      bootCommand: 'gh',
      bootArgs: ['copilot', '--', '--acp', '--no-ask-user', '--model', 'copilot-test-model'],
      authenticateMethod: null,
    });
    expect(mediatorInstances[0]?.options.bootArgs).not.toContain('--allow-all');
    expect(mediatorInstances[0]?.instance.boot).toHaveBeenCalledOnce();
  });

  it('reuses a booted ACP session for repeated prompts', async () => {
    const backend = new CopilotAcpReasoningBackend({ command: 'gh' });

    await backend.prompt('First prompt');
    await backend.prompt('Second prompt');

    expect(mediatorInstances[0]?.instance.boot).toHaveBeenCalledOnce();
    expect(mediatorInstances[0]?.instance.ask).toHaveBeenCalledTimes(2);
  });

  it('resets the session after an ACP failure so failover can retry cleanly', async () => {
    const backend = new CopilotAcpReasoningBackend({ command: 'gh' });

    await backend.prompt('First prompt');
    const mediator = mediatorInstances[0]!.instance;
    mediator.ask.mockRejectedValueOnce(new Error('ACP unavailable'));

    await expect(backend.prompt('Failing prompt')).rejects.toThrow('ACP unavailable');
    expect(mediator.shutdown).toHaveBeenCalledOnce();

    await backend.prompt('Retry prompt');
    expect(mediatorInstances).toHaveLength(1);
    expect(mediator.boot).toHaveBeenCalledTimes(2);
  });
});
