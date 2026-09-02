import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeSuperPipeline: vi.fn(),
  readJson: vi.fn(),
  logger: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock('../libs/actuators/orchestrator-actuator/src/super-nerve/index.js', () => ({
  executeSuperPipeline: mocks.executeSuperPipeline,
}));

vi.mock('@agent/core/foundation', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/core/foundation')>('@agent/core/foundation');
  return { ...actual, readJson: mocks.readJson };
});

vi.mock('@agent/core/core', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/core')>('@agent/core/core');
  return { ...actual, logger: mocks.logger };
});

vi.mock('@agent/core/secure-io', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/core/secure-io')>('@agent/core/secure-io');
  return {
    ...actual,
    assertSafeRepositoryPath: (value: string) => value,
    safeLstat: () => ({ isFile: () => true }),
  };
});

describe('run_a2a', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses explicit argv and emits the response through the harness printer', async () => {
    const message = {
      a2a_version: '1.0',
      header: {
        msg_id: 'msg-1',
        conversation_id: 'conversation-1',
        sender: 'agent:sender',
        performative: 'request',
      },
      payload: { task: 'demo' },
    };
    const result = { status: 'completed' };
    mocks.readJson.mockReturnValue(message);
    mocks.executeSuperPipeline.mockResolvedValue(result);

    const { main } = await import('./run_a2a.js');
    const print = vi.fn();
    await main(['--input', 'active/shared/tmp/a2a-message.json'], print);

    expect(mocks.executeSuperPipeline).toHaveBeenCalledWith(message);
    expect(print).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: result,
        header: expect.objectContaining({
          parent_id: 'msg-1',
          conversation_id: 'conversation-1',
        }),
      })
    );
  });

  it('rejects an A2A message without the required envelope fields', async () => {
    mocks.readJson.mockReturnValue({ payload: {} });

    const { main } = await import('./run_a2a.js');
    await expect(main(['--input', 'active/shared/tmp/a2a-message.json'], vi.fn())).rejects.toThrow(
      /Invalid catalog a2a-envelope/
    );
  });
});
