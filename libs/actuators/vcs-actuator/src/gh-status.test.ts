import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@agent/core/governance/audit-chain', () => ({ auditChain: { record: vi.fn() } }));

const mocks = vi.hoisted(() => ({ safeExecResult: vi.fn() }));
vi.mock('@agent/core/secure-io', async (original) => ({
  ...(await original<typeof import('@agent/core/secure-io')>()),
  safeExecResult: mocks.safeExecResult,
}));
import { handleAction } from './vcs-helpers.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('gh_status diagnostics', () => {
  it('preserves fields while distinguishing DNS failure and redacting credentials', async () => {
    vi.stubEnv('GH_TOKEN', 'custom-test-secret');
    mocks.safeExecResult.mockImplementation((_bin, args) =>
      args[0] === '--version'
        ? { status: 0, stdout: 'gh version 2.0.0\n', stderr: '' }
        : {
            status: 1,
            stdout: '',
            stderr: 'Token: custom-test-secret\nlookup api.github.com: no such host',
          }
    );
    const output = await handleAction({ op: 'gh_status' });
    expect(output).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          version: 'gh version 2.0.0',
          auth_ok: false,
          diagnostic: expect.objectContaining({
            status: 'dns_failure',
            connector_status: 'not_probed',
          }),
        }),
      })
    );
    expect(JSON.stringify(output)).not.toContain('custom-test-secret');
  });
});
