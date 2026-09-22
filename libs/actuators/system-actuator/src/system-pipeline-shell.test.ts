import { afterAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const saved = {
    allow: process.env.KYBERION_ALLOW_UNSAFE_SHELL,
    shell: process.env.SHELL,
  };
  // ALLOW_UNSAFE_SHELL is read once at module load, so opt in before import.
  process.env.KYBERION_ALLOW_UNSAFE_SHELL = 'true';
  process.env.SHELL = '/bin/bash';
  return { saved, safeExecShellScript: vi.fn(() => ' shell-out \n') };
});

vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safeExecShellScript: mocks.safeExecShellScript,
}));

import { pathResolver } from '@agent/core/path-resolver';
import { opCapture } from './system-pipeline-core-helpers.js';

afterAll(() => {
  if (mocks.saved.allow === undefined) delete process.env.KYBERION_ALLOW_UNSAFE_SHELL;
  else process.env.KYBERION_ALLOW_UNSAFE_SHELL = mocks.saved.allow;
  if (mocks.saved.shell === undefined) delete process.env.SHELL;
  else process.env.SHELL = mocks.saved.shell;
});

describe('system:shell capture op', () => {
  it("runs the command as a login-shell script in the operator's $SHELL", async () => {
    // The op-input schema requires `command` while the handler reads `cmd`
    // (pre-existing), so both are supplied here.
    const result = await opCapture(
      'shell',
      { command: 'echo hi', cmd: 'echo hi', env: { FOO: 'bar' }, export_as: 'out' },
      {},
      (value) => value
    );

    expect(result.out).toBe('shell-out');
    expect(mocks.safeExecShellScript).toHaveBeenCalledWith('/bin/bash', 'echo hi', {
      login: true,
      cwd: pathResolver.rootDir(),
      env: { FOO: 'bar' },
    });
  });
});
