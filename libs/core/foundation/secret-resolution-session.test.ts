import { describe, expect, it, vi } from 'vitest';
import {
  memoizedKeychainRead,
  withSecretResolutionSession,
  invalidateKeychainRead,
} from './secret-resolution-session.js';
describe('per-operation Keychain reads', () => {
  it('remembers refusals across awaits and nested calls without retrying', async () => {
    const read = vi.fn(() => null);
    await withSecretResolutionSession(async () => {
      expect(memoizedKeychainRead('svc', 'acct', read)).toBeNull();
      await Promise.resolve();
      withSecretResolutionSession(() => memoizedKeychainRead('svc', 'acct', read));
      expect(read).toHaveBeenCalledOnce();
    });
    withSecretResolutionSession(() => memoizedKeychainRead('svc', 'acct', read));
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('invalidates a read when the same operation writes or deletes that identity', () => {
    const read = vi.fn(() => 'test-key');
    withSecretResolutionSession(() => {
      memoizedKeychainRead('svc', 'acct', read);
      invalidateKeychainRead('svc', 'acct');
      memoizedKeychainRead('svc', 'acct', read);
    });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
