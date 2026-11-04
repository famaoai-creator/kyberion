import { describe, expect, it, vi } from 'vitest';
import {
  memoizedNativeSecretRead,
  invalidateNativeSecretRead,
  memoizedKeychainRead,
  withSecretResolutionSession,
  invalidateKeychainRead,
} from './secret-resolution-session.js';
describe('per-operation native-secret reads', () => {
  it('remembers refusals across awaits and nested calls without retrying', async () => {
    const read = vi.fn(() => null);
    await withSecretResolutionSession(async () => {
      expect(memoizedNativeSecretRead('svc', 'acct', read)).toBeNull();
      await Promise.resolve();
      withSecretResolutionSession(() => memoizedNativeSecretRead('svc', 'acct', read));
      expect(read).toHaveBeenCalledOnce();
    });
    withSecretResolutionSession(() => memoizedNativeSecretRead('svc', 'acct', read));
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('invalidates a read when the same operation writes or deletes that identity', () => {
    const read = vi.fn(() => 'test-key');
    withSecretResolutionSession(() => {
      memoizedNativeSecretRead('svc', 'acct', read);
      invalidateNativeSecretRead('svc', 'acct');
      memoizedNativeSecretRead('svc', 'acct', read);
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps the old keychain helper names as compatibility aliases', () => {
    const read = vi.fn(() => 'test-key');
    withSecretResolutionSession(() => {
      expect(memoizedKeychainRead('svc', 'acct', read)).toBe('test-key');
      invalidateKeychainRead('svc', 'acct');
      expect(memoizedNativeSecretRead('svc', 'acct', read)).toBe('test-key');
    });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
