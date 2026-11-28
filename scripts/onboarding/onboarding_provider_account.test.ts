import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { inspectInstalledAccount, inspectProviderAccount } from './onboarding_provider_account.js';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  spawn: vi.fn(),
  isWindows: vi.fn(() => false),
}));

vi.mock('@agent/core/secure-io', async (original) => ({
  ...(await original<typeof import('@agent/core/secure-io')>()),
  assertGovernedExec: vi.fn(),
  safeExecResultAsync: mocks.exec,
  safeSpawn: vi.fn(),
}));
vi.mock('@agent/core/provider/provider-managed-env', () => ({
  getManagedProviderCliDefinition: () => null,
  resolveProviderCliCommand: (provider: string) => provider,
}));
vi.mock('node-pty', () => ({ spawn: mocks.spawn }));
vi.mock('@agent/core/platform-facts', async (original) => ({
  ...(await original<typeof import('@agent/core/platform-facts')>()),
  isWindows: mocks.isWindows,
}));

describe('account provider diagnostics', () => {
  it.each([
    [
      'claude',
      '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"hidden"}',
      'max',
    ],
    ['cursor', '{"subscriptionTier":"Pro","userEmail":"hidden"}', 'Pro'],
    [
      'devin',
      'Logged in (via Devin).\n  Plan: Pro\n  Tier: Devin Pro\n  Email: hidden',
      'Devin Pro',
    ],
  ] as const)('reads only account labels for %s', async (provider, stdout, plan) => {
    mocks.exec.mockResolvedValueOnce({ status: 0, stdout });
    const result = await inspectProviderAccount(provider);
    expect(result).toMatchObject({ status: 'available', plan, training_use: 'unknown' });
    expect(JSON.stringify(result)).not.toContain('hidden');
  });

  it('probes an account only after the CLI version command succeeds', async () => {
    mocks.exec.mockClear();
    mocks.exec.mockResolvedValueOnce({ status: 127, stdout: '', error: { code: 'ENOENT' } });
    expect(await inspectInstalledAccount('cursor')).toBeNull();
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    mocks.exec.mockResolvedValueOnce({ status: 0, stdout: '' });
    mocks.exec.mockResolvedValueOnce({ status: 0, stdout: '{"subscriptionTier":"Pro"}' });
    expect(await inspectInstalledAccount('cursor')).toMatchObject({ plan: 'Pro' });
    expect(mocks.exec.mock.calls.map((call) => call[0])).toEqual(Array(3).fill('cursor-agent'));
    expect(mocks.exec.mock.calls.map((call) => call[1])).toEqual([
      ['--version'],
      ['--version'],
      ['about', '--format', 'json'],
    ]);
  });

  it('distinguishes a version check failure from a missing executable', async () => {
    mocks.exec.mockResolvedValueOnce({ status: 42, stdout: '', stderr: 'private diagnostics' });
    const result = await inspectInstalledAccount('cursor');
    expect(result).toMatchObject({ status: 'unavailable', cli_failure: 'version_failed' });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('labels a timed-out version check without exposing command output', async () => {
    mocks.exec.mockResolvedValueOnce({
      status: 1,
      stdout: 'private',
      error: { code: 'ETIMEDOUT' },
    });
    const result = await inspectInstalledAccount('cursor');
    expect(result).toMatchObject({ status: 'unavailable', cli_failure: 'version_timeout' });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each([
    ['ETIMEDOUT', 'timeout'],
    ['ENOBUFS', 'output_limit'],
  ])(
    'preserves account failure %s after a successful version check',
    async (code, account_failure) => {
      mocks.exec.mockResolvedValueOnce({ status: 0, stdout: '1.0' });
      mocks.exec.mockResolvedValueOnce({ status: 1, stdout: 'private', error: { code } });
      const result = await inspectInstalledAccount('cursor');
      expect(result).toMatchObject({ status: 'unavailable', account_failure });
      expect(JSON.stringify(result)).not.toContain('private');
    }
  );

  it('keeps checkout-relative binary overrides valid when launching from a temporary directory', async () => {
    mocks.exec.mockClear();
    vi.stubEnv('KYBERION_CURSOR_CLI_BIN', './tools/test-cursor-agent');
    try {
      mocks.exec.mockResolvedValueOnce({ status: 0, stdout: '1.0' });
      mocks.exec.mockResolvedValueOnce({ status: 0, stdout: '{"subscriptionTier":"Pro"}' });
      const expected = resolve('tools/test-cursor-agent');
      expect(await inspectInstalledAccount('cursor')).toMatchObject({ plan: 'Pro' });
      expect(mocks.exec.mock.calls.map((call) => call[0])).toEqual([expected, expected]);
      expect(mocks.exec.mock.calls[0][2]).toMatchObject({ forceKillOnAbort: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports Grok usage independently of a plan name and drops identifiers', async () => {
    mocks.exec.mockResolvedValueOnce({
      status: 0,
      stdout: '{"weekly":{"used_percent":14,"email":"hidden"},"account_id":123}',
    });
    expect(await inspectProviderAccount('grok')).toMatchObject({
      status: 'available',
      plan: null,
      usage: { weekly: { used_percent: 14 } },
    });
  });

  it('reports a failed probe as unavailable without echoing CLI output', async () => {
    mocks.exec.mockResolvedValueOnce({ status: 1, stdout: 'private', stderr: 'private' });
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error('PTY unavailable');
    });
    expect(await inspectProviderAccount('grok')).toEqual({
      status: 'unavailable',
      provider: 'grok',
      plan: null,
      account_type: null,
      training_use: 'unknown',
    });
  });

  it('reads the Grok plan from the TUI even when JSON returned counters', async () => {
    mocks.exec.mockResolvedValueOnce({ status: 0, stdout: '{"weekly":{"used_percent":14}}' });
    const onData = vi.fn();
    const write = vi.fn();
    const kill = vi.fn();
    mocks.spawn.mockReturnValueOnce({ onData, onExit: vi.fn(), write, kill });
    const reading = inspectProviderAccount('grok', { requirePlan: true });
    await vi.waitFor(() => expect(onData).toHaveBeenCalledOnce());
    const emit = onData.mock.calls[0][0];
    emit('Resume session');
    expect(write).not.toHaveBeenCalled();
    emit('❯');
    expect(write).toHaveBeenCalledExactlyOnceWith('/usage\r');
    emit('Week\u001b[6;23Hy limit (X Premium) ░░ 0%');
    expect(await reading).toMatchObject({
      status: 'available',
      plan: 'X Premium',
      usage: { weekly: { used_percent: 14 } },
    });
    expect(kill).toHaveBeenCalledOnce();
  });

  it('leaves a Grok directory trust prompt unanswered', async () => {
    mocks.exec.mockResolvedValueOnce({ status: 1, stdout: '' });
    const onData = vi.fn();
    const onExit = vi.fn();
    const write = vi.fn();
    mocks.spawn.mockReturnValueOnce({ onData, onExit, write, kill: vi.fn() });
    const reading = inspectProviderAccount('grok');
    await vi.waitFor(() => expect(onData).toHaveBeenCalledOnce());
    onData.mock.calls[0][0]('Do you trust the contents of this directory?');
    onExit.mock.calls[0][0]({ exitCode: 1 });
    expect(write).not.toHaveBeenCalled();
    expect(await reading).toMatchObject({ status: 'unavailable', plan: null });
  });

  it.each([false, true])(
    'extracts the Agy tier and closes the PTY (Windows: %s)',
    async (windows) => {
      mocks.isWindows.mockReturnValueOnce(windows);
      const kill = vi.fn();
      const onData = vi.fn();
      mocks.spawn.mockReturnValue({ onData, onExit: vi.fn(), kill });
      const reading = inspectProviderAccount('agy');
      await vi.waitFor(() => expect(onData).toHaveBeenCalledOnce());
      const emit = onData.mock.calls[0][0];
      emit('unrelated KYBERION-ACCOUNT-TIER:Google ');
      emit('AI Pro;END');
      expect(await reading).toMatchObject({ status: 'available', plan: 'Google AI Pro' });
      expect(kill).toHaveBeenCalledExactlyOnceWith(windows ? undefined : 'SIGKILL');
    }
  );
});
