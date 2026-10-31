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

import { fetchOsKeychainSecretSync, fetchSecretSync } from './secret-bridge.js';

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
    expect(mocks.safeExecResult).not.toHaveBeenCalled();
  });
});
