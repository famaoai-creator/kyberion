import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(),
  safeReadFile: vi.fn(),
  executeServicePreset: vi.fn(),
}));

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual('@agent/core') as any;
  return {
    ...actual,
    safeExec: mocks.safeExec,
    safeReadFile: mocks.safeReadFile,
    executeServicePreset: mocks.executeServicePreset,
  };
});

describe('service-actuator handleAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KYBERION_ALLOW_UNSAFE_CLI;
  });

  it('delegates PRESET mode to the shared service engine', async () => {
    mocks.executeServicePreset.mockResolvedValue({ ok: true });
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      service_id: 'github',
      mode: 'PRESET',
      action: 'create_issue',
      params: { owner: 'famaoai', repo: 'kyberion' },
      auth: 'secret-guard',
    });

    expect(mocks.executeServicePreset).toHaveBeenCalledWith(
      'github',
      'create_issue',
      { owner: 'famaoai', repo: 'kyberion' },
      'secret-guard',
    );
    expect(result).toEqual({ ok: true });
  });

  it('blocks raw CLI mode unless explicitly enabled', async () => {
    const { handleAction } = await import('./index.js');

    await expect(
      handleAction({
        service_id: 'slack',
        mode: 'CLI',
        action: 'post-message',
        params: { text: 'hello' },
      }),
    ).rejects.toThrow('CLI execution disabled');
  });

  it('executes raw CLI mode when unsafe CLI is enabled', async () => {
    process.env.KYBERION_ALLOW_UNSAFE_CLI = 'true';
    mocks.safeExec.mockReturnValue('cli-output');
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      service_id: 'voice',
      mode: 'CLI',
      action: 'speak',
      params: { text: 'hello' },
    });

    expect(mocks.safeExec).toHaveBeenCalledWith('voice', ['speak', 'hello']);
    expect(result).toEqual({ output: 'cli-output' });
  });
});
