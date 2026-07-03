import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACPMediator, AgentRuntimeCrashedError, AgentTurnTimeoutError } from './acp-mediator.js';

function createReadyMediator(promptImpl: () => Promise<unknown>) {
  const mediator = new ACPMediator({
    threadId: 'runtime-test-agent',
    bootCommand: 'agent',
    bootArgs: [],
  });
  (mediator as any).connection = {
    prompt: vi.fn(promptImpl),
  };
  (mediator as any).acpSessionId = 'session-1';
  return mediator;
}

describe('ACPMediator runtime resilience', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails an unresponsive turn with a typed timeout error', async () => {
    vi.useFakeTimers();
    const mediator = createReadyMediator(() => new Promise(() => {}));

    const turn = mediator.ask('hello', { timeoutMs: 25 });
    const assertion = expect(turn).rejects.toMatchObject({
      name: 'AgentTurnTimeoutError',
      agentId: 'runtime-test-agent',
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(turn).rejects.toBeInstanceOf(AgentTurnTimeoutError);
    await assertion;
  });

  it('rejects a pending turn when the runtime crashes and includes recent logs', async () => {
    const mediator = createReadyMediator(() => new Promise(() => {}));
    const turn = mediator.ask('important prompt', { timeoutMs: 0 });
    const assertion = expect(turn).rejects.toMatchObject({
      name: 'AgentRuntimeCrashedError',
      agentId: 'runtime-test-agent',
      exitCode: 1,
    });

    (mediator as any).markCrashed(1, null);

    await expect(turn).rejects.toBeInstanceOf(AgentRuntimeCrashedError);
    await assertion;
    await turn.catch((error: AgentRuntimeCrashedError) => {
      expect(error.recentLog.some((entry) => entry.type === 'prompt')).toBe(true);
    });
  });

  it('reports process liveness from pid signal checks', () => {
    const mediator = new ACPMediator({
      threadId: 'runtime-test-agent',
      bootCommand: 'agent',
      bootArgs: [],
    });
    (mediator as any).child = { pid: process.pid };

    expect(mediator.isProcessAlive()).toBe(true);

    (mediator as any).markCrashed(1, null);
    expect(mediator.isProcessAlive()).toBe(false);
  });
});
