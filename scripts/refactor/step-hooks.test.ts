import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExecResult: vi.fn(),
  secureFetch: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@agent/core', async () => {
  const actual = (await vi.importActual('@agent/core')) as any;
  return {
    ...actual,
    safeExecResult: mocks.safeExecResult,
    secureFetch: mocks.secureFetch,
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
      async () => async () => ({ handled: false, ctx: {} }),
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
      async () => async () => ({ handled: true, ctx: {} }),
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
      async () => async () => ({ handled: false, ctx: {} }),
    );

    expect(decision).toBe('continue');
  });
});
