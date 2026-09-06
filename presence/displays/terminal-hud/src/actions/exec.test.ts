import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExecResult: vi.fn(() => ({ stdout: 'ok\n', stderr: '', status: 0 })),
}));

vi.mock('@agent/core/secure-io', () => ({ safeExecResult: mocks.safeExecResult }));

import { hudExec } from './exec.js';

describe('terminal HUD command environment', () => {
  afterEach(() => {
    delete process.env.UNRELATED_HUD_TEST_SECRET;
    mocks.safeExecResult.mockClear();
  });

  it('passes the least-privilege child environment and explicit overrides', () => {
    process.env.UNRELATED_HUD_TEST_SECRET = 'must-not-cross-the-boundary';

    expect(hudExec('node', ['-e', ''], { env: { SYSTEM_ROLE: 'surface_runtime' } })).toEqual({
      ok: true,
      output: 'ok',
    });

    const options = mocks.safeExecResult.mock.calls[0]?.[2] as {
      env?: Record<string, string>;
    };
    expect(options.env).toMatchObject({
      FORCE_COLOR: '0',
      SYSTEM_ROLE: 'surface_runtime',
    });
    expect(options.env?.TERM).toBe(process.env.TERM || 'dumb');
    expect(options.env).not.toHaveProperty('UNRELATED_HUD_TEST_SECRET');
  });
});
