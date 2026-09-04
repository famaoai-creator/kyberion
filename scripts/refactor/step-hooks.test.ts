import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExecResult: vi.fn(),
  secureFetch: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@agent/core/secure-io', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/core/secure-io')>('@agent/core/secure-io');
  return {
    ...actual,
    safeExecResult: mocks.safeExecResult,
  };
});

vi.mock('@agent/core/network', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/network')>('@agent/core/network');
  return {
    ...actual,
    secureFetch: mocks.secureFetch,
  };
});

vi.mock('@agent/core/core', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/core')>('@agent/core/core');
  return {
    ...actual,
    logger: {
      ...actual.logger,
      warn: mocks.warn,
    },
  };
});

describe('step-hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats an unhandled actuator hook as a rejection', async () => {
    const { runStepHooks } = await import('./step-hooks.js');
    const decision = await runStepHooks(
      [
        {
          type: 'actuator_op',
          op: 'approval:create',
        },
      ],
      {},
      'before',
      async () => async () => ({ handled: false, ctx: {} })
    );

    expect(decision).toBe('abort');
    expect(mocks.warn).toHaveBeenCalled();
  });

  it('honours on_reject=warn for a rejected command hook', async () => {
    const { runStepHooks } = await import('./step-hooks.js');
    mocks.safeExecResult.mockReturnValue({ status: 2, stdout: '', stderr: 'deny' });

    const decision = await runStepHooks(
      [
        {
          type: 'command',
          cmd: 'exit 2',
          on_reject: 'warn',
        },
      ],
      {},
      'before',
      async () => async () => ({ handled: true, ctx: {} })
    );

    expect(decision).toBe('continue');
    expect(mocks.warn).toHaveBeenCalled();
  });

  it('skips an after hook when on_reject=skip', async () => {
    const { runStepHooks } = await import('./step-hooks.js');
    const decision = await runStepHooks(
      [
        {
          type: 'actuator_op',
          op: 'approval:create',
          on_reject: 'skip',
        },
      ],
      {},
      'after',
      async () => async () => ({ handled: false, ctx: {} })
    );

    expect(decision).toBe('continue');
  });

  it('only treats a validated object response as an HTTP hook decision', async () => {
    const { runStepHooks } = await import('./step-hooks.js');
    mocks.secureFetch.mockResolvedValueOnce({ approved: false });

    await expect(
      runStepHooks(
        [{ type: 'http', url: 'https://example.com/hook' }],
        {},
        'before',
        async () => async () => ({ handled: true, ctx: {} })
      )
    ).resolves.toBe('abort');

    mocks.secureFetch.mockResolvedValueOnce(null);
    await expect(
      runStepHooks(
        [{ type: 'http', url: 'https://example.com/hook' }],
        {},
        'before',
        async () => async () => ({ handled: true, ctx: {} })
      )
    ).resolves.toBe('continue');
  });
});
