import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./external-vcs.js', () => ({
  governVcsCommand: (_operation: string, _effect: object, execute: () => unknown) => execute(),
}));

const mocks = vi.hoisted(() => ({ safeExec: vi.fn() }));
vi.mock('../secure-io.js', async (original) => ({
  ...(await original<typeof import('../secure-io.js')>()),
  safeExec: mocks.safeExec,
}));

import { diagnoseGhResult, ghMust, ghPrView, sanitizeGhOutput } from './github.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('GitHub CLI diagnostics', () => {
  it.each([
    ['The token is invalid. lookup api.github.com: no such host', 'dns_failure'],
    ['The token is invalid. error connecting to api.github.com', 'network_failure'],
    ['keychain: could not retrieve credential; token invalid', 'credential_unavailable'],
    ['HTTP 401: Bad credentials', 'credential_rejected'],
    ['The token is invalid.', 'credential_unverified'],
    [
      'Failed to log in. The token in default is invalid. To re-authenticate, run: gh auth login -h github.com',
      'credential_unverified',
    ],
    ['You are not logged into any GitHub hosts', 'credential_missing'],
    ['spawn gh ENOENT', 'cli_missing'],
    ['unrecognized failure', 'command_failure'],
  ])('classifies %s using explicit evidence', (stderr, status) => {
    expect(diagnoseGhResult({ status: 1, stdout: '', stderr })).toEqual(
      expect.objectContaining({ status, connector_status: 'not_probed' })
    );
  });

  it('keeps unknown auth probes unverified while unknown operations remain command failures', () => {
    const result = { status: 1, stdout: '', stderr: 'unrecognized failure' };
    expect(diagnoseGhResult(result, { authProbe: true }).status).toBe('credential_unverified');
    expect(() => ghMust(['auth', 'status'], {}, () => result)).toThrow(
      /gh auth status: credential_unverified/
    );
    expect(() => ghMust(['pr', 'view', 'private-resource'], {}, () => result)).toThrow(
      /gh pr view: command_failure/
    );
  });

  it.each([
    ['token'.repeat(100_000), 'command_failure'],
    ['invalid'.repeat(100_000), 'command_failure'],
    ['token'.repeat(100_000) + ' invalid', 'credential_unverified'],
    ['invalid'.repeat(100_000) + ' credential', 'credential_unverified'],
    ['token\ninvalid', 'command_failure'],
    ['invalid\rcredential', 'command_failure'],
    ['AUTHENTICATION unverified', 'credential_unverified'],
  ])('handles long repeated markers and line boundaries (case %#)', (stderr, status) => {
    expect(diagnoseGhResult({ status: 1, stdout: '', stderr }).status).toBe(status);
  });

  it.each([
    ['no pull requests found for branch secret-branch', 'missing_resource'],
    ['GraphQL: Resource not accessible by integration (repository)', 'permission_denied'],
    ['HTTP 403: Forbidden', 'permission_denied'],
    ['unknown flag: --secret-flag', 'invalid_arguments'],
  ])(
    'keeps operation failures actionable without exposing their raw output',
    (stderr, category) => {
      const run = () => ({ status: 1, stdout: '', stderr });
      expect(() => ghPrView({ ref: 'secret-resource', fields: 'number' }, run)).toThrow(
        new RegExp(`gh pr view: ${category}`)
      );
      try {
        ghPrView({ ref: 'secret-resource', fields: 'number' }, run);
      } catch (error) {
        expect(String(error)).not.toMatch(/secret-resource|secret-branch|secret-flag/);
      }
    }
  );

  it('never copies arbitrary command names or token arguments into diagnostic labels', () => {
    expect(() =>
      ghMust(['secret-command', 'secret-value'], {}, () => ({
        status: 1,
        stdout: '',
        stderr: 'unknown failure secret-value',
      }))
    ).toThrow(/VCS_TYPED_VERB_REQUIRED/);
    expect(() =>
      ghMust(['secret-command', 'secret-value'], {}, () => ({
        status: 1,
        stdout: '',
        stderr: 'unknown failure secret-value',
      }))
    ).not.toThrow(/secret-command|secret-value/);
  });

  it('does not infer connector readiness from successful shell authentication', () => {
    expect(diagnoseGhResult({ status: 0, stdout: '', stderr: '' })).toEqual(
      expect.objectContaining({ status: 'ready', connector_status: 'not_probed' })
    );
  });

  it('redacts registered credentials, GitHub token patterns and credential lines', () => {
    vi.stubEnv('GH_TOKEN', 'custom-sensitive-value');
    const output = sanitizeGhOutput(
      'custom-sensitive-value ghp_unknownsecret\nToken: unknown-format-secret'
    );
    expect(output).not.toMatch(/custom-sensitive-value|ghp_unknownsecret|unknown-format-secret/);
    expect(output).toContain('[REDACTED]');
  });

  it('forwards registered credentials on the default throwing execution path', () => {
    vi.stubEnv('GH_TOKEN', 'registered-test-secret');
    mocks.safeExec.mockReturnValue('ok');
    expect(ghMust(['auth', 'status'])).toBe('ok');
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'gh',
      ['auth', 'status'],
      expect.objectContaining({
        env: expect.objectContaining({ GH_TOKEN: 'registered-test-secret' }),
      })
    );
    ghMust(['auth', 'status'], { env: { GH_TOKEN: 'explicit-test-secret' } });
    expect(mocks.safeExec.mock.calls[1]?.[2].env.GH_TOKEN).toBe('explicit-test-secret');
  });

  it('never includes arbitrary CLI output or credentials in thrown diagnostics', () => {
    mocks.safeExec.mockImplementation(() => {
      throw new Error('token arbitrary-secret invalid; lookup api.github.com: no such host');
    });
    expect(() => ghMust(['auth', 'status'])).toThrow(/dns_failure/);
    expect(() => ghMust(['auth', 'status'])).not.toThrow(/arbitrary-secret/);
    expect(() =>
      ghMust(['auth', 'status'], {}, () => ({
        status: 1,
        stdout: '',
        stderr: 'HTTP 401 secret-value',
      }))
    ).toThrow(/credential_rejected/);
  });
});
