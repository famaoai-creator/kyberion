/**
 * fetchOsKeychainSecretSync reads the OS keychain only: unlike fetchSecretSync
 * it never falls through to SECRET_* env (or the in-repo file vault), so a
 * caller can require that a value lives outside the repository.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ safeExecResult: vi.fn() }));

vi.mock('../secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../secure-io.js')>();
  return { ...actual, safeExecResult: mocks.safeExecResult };
});

import {
  fetchNativeSecretSync,
  fetchOsKeychainSecretSync,
  fetchSecretSync,
  readNativeSecretSync,
  WindowsCredentialManagerSecretProvider,
} from './secret-bridge.js';

const originalPlatform = process.platform;
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('fetchOsKeychainSecretSync', () => {
  afterEach(() => {
    setPlatform(originalPlatform);
    mocks.safeExecResult.mockReset();
    vi.unstubAllEnvs();
  });

  it('returns the keychain value on darwin', () => {
    setPlatform('darwin');
    mocks.safeExecResult.mockReturnValue({ status: 0, stdout: 'from-keychain\n', stderr: '' });
    expect(fetchOsKeychainSecretSync('kyberion-backup', 'passphrase')).toBe('from-keychain');
    expect(mocks.safeExecResult).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-a', 'passphrase', '-s', 'kyberion-backup', '-w'],
      expect.objectContaining({ timeoutMs: 10_000 })
    );
  });

  it('misses without falling through to SECRET_* env, while fetchSecretSync falls through', () => {
    setPlatform('darwin');
    mocks.safeExecResult.mockReturnValue({ status: 44, stdout: '', stderr: 'not found' });
    vi.stubEnv('SECRET_KYBERION_BACKUP_PASSPHRASE', 'from-env-store');
    expect(fetchOsKeychainSecretSync('kyberion-backup', 'passphrase')).toBeNull();
    expect(fetchSecretSync('kyberion-backup', 'passphrase')).toBe('from-env-store');
  });

  it('is a miss on platforms without a sync keychain read', () => {
    setPlatform('linux');
    expect(fetchOsKeychainSecretSync('kyberion-backup', 'passphrase')).toBeNull();
    expect(readNativeSecretSync('kyberion-backup', 'passphrase')).toBeNull();
    expect(mocks.safeExecResult).not.toHaveBeenCalled();
  });

  it('reads the Windows Credential Manager through the native-secret abstraction', () => {
    setPlatform('win32');
    mocks.safeExecResult.mockReturnValue({ status: 0, stdout: 'from-windows-vault', stderr: '' });

    expect(readNativeSecretSync('kyberion-backup', 'passphrase')).toEqual({
      value: 'from-windows-vault',
      backend: 'windows_credential_manager',
    });
    expect(fetchNativeSecretSync('kyberion-backup', 'passphrase')).toBe('from-windows-vault');
    expect(fetchSecretSync('kyberion-backup', 'passphrase')).toBe('from-windows-vault');

    const [binary, args, options] = mocks.safeExecResult.mock.calls[0] as [
      string,
      string[],
      { input: string; timeoutMs: number },
    ];
    expect(binary).toBe('powershell.exe');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(args[3]).toContain('CredRead');
    expect(options).toMatchObject({
      timeoutMs: 10_000,
    });
    expect(JSON.parse(options.input)).toMatchObject({
      target: expect.stringMatching(/^Kyberion\.Secret\.v1\.[a-f0-9]{64}$/),
      legacyTarget: 'kyberion-backup',
      account: 'passphrase',
      value: '',
    });
    expect(args.join(' ')).not.toContain('from-windows-vault');
    expect(args[3]).toContain('Get-OwnedCredentialValue $legacyTarget');
    expect(args[3]).toContain('[StringComparison]::Ordinal');
  });

  it('uses distinct Credential Manager targets for accounts sharing a service', () => {
    setPlatform('win32');
    mocks.safeExecResult.mockReturnValue({ status: 2, stdout: '', stderr: 'not found' });
    const provider = new WindowsCredentialManagerSecretProvider();

    expect(provider.getSync('shared-service', 'account-a')).toBeNull();
    expect(provider.getSync('shared-service', 'account-b')).toBeNull();

    const calls = mocks.safeExecResult.mock.calls as Array<[string, string[], { input: string }]>;
    expect(calls).toHaveLength(2);
    const first = JSON.parse(calls[0]![2].input);
    const second = JSON.parse(calls[1]![2].input);
    expect(first.target).not.toBe(second.target);
    expect(first.legacyTarget).toBe('shared-service');
    expect(second.legacyTarget).toBe('shared-service');
    for (const [, args] of calls) {
      expect(args[3]).toContain('CredRead($credentialTarget');
      expect(args[3]).toContain('CredDelete($credentialTarget');
      expect(args[3]).toContain('[StringComparison]::Ordinal');
    }
  });
});
