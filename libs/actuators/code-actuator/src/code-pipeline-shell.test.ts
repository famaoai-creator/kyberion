import { afterAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const saved = process.env.KYBERION_ALLOW_UNSAFE_SHELL;
  // ALLOW_UNSAFE_SHELL is read once at module load, so opt in before import.
  process.env.KYBERION_ALLOW_UNSAFE_SHELL = 'true';
  return {
    saved,
    runGovernedShellScript: vi.fn(() => ({ stdout: ' shell-out \n', stderr: '', status: 0 })),
  };
});

vi.mock('@agent/core/command-runner', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runGovernedShellScript: mocks.runGovernedShellScript,
}));

import { executePipeline } from './code-pipeline-helpers.js';

afterAll(() => {
  if (mocks.saved === undefined) delete process.env.KYBERION_ALLOW_UNSAFE_SHELL;
  else process.env.KYBERION_ALLOW_UNSAFE_SHELL = mocks.saved;
});

describe('code:shell capture op', () => {
  it('runs the command as a /bin/sh -c script through the governed shell-script runner', async () => {
    const result = await executePipeline([
      { type: 'capture', op: 'shell', params: { cmd: 'echo hi', export_as: 'out' } },
    ] as Parameters<typeof executePipeline>[0]);

    expect(result.context.out).toBe('shell-out');
    expect(mocks.runGovernedShellScript).toHaveBeenCalledWith('/bin/sh', 'echo hi', {
      maxOutputMB: 10,
    });
  });
});
