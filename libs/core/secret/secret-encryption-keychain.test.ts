import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('../secure-io.js', async (original) => ({
  ...(await original<typeof import('../secure-io.js')>()),
  safeExecResult: mocks.exec,
}));
import {
  encryptConnectionDocument,
  decryptConnectionDocument,
  overrideSecretEncryptionKeyForTests,
} from './secret-encryption.js';
import { withSecretResolutionSession } from '../foundation/secret-resolution-session.js';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  mocks.exec.mockReset();
  overrideSecretEncryptionKeyForTests(null);
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  overrideSecretEncryptionKeyForTests(null);
});
describe('encryption master Keychain admission', () => {
  it('does not turn a refusal into creation or repeat the read within the operation', () => {
    mocks.exec.mockReturnValue({ status: 51, stdout: '', stderr: 'refused' });
    withSecretResolutionSession(() => {
      expect(() => encryptConnectionDocument({ api_key: 'test-key' })).toThrow(
        'No replacement key'
      );
      expect(() => encryptConnectionDocument({ api_key: 'test-key' })).toThrow(
        'No replacement key'
      );
    });
    expect(mocks.exec).toHaveBeenCalledOnce();
    expect(mocks.exec.mock.calls[0][0]).toBe('security');
  });
  it('never creates an encryption master when decrypting an existing document', () => {
    mocks.exec.mockReturnValue({ status: 44, stdout: '', stderr: 'not found' });
    expect(() =>
      decryptConnectionDocument({
        __kyberion__: 'kyberion-encrypted',
        version: 1,
        algorithm: 'aes-256-gcm',
        iv: '',
        tag: '',
        ciphertext: '',
      })
    ).toThrow('No replacement key');
    expect(mocks.exec).toHaveBeenCalledOnce();
  });
  it('creates only on an actual miss, sends the new master over stdin, and never updates an existing item', () => {
    mocks.exec
      .mockReturnValueOnce({ status: 44, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    encryptConnectionDocument({ api_key: 'test-key' });
    const [command, args, options] = mocks.exec.mock.calls[1];
    expect(command).toBe('swift');
    const material = String(options.input).trim().split('\n').at(-1)!;
    expect(material).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(args)).not.toContain(material);
    const script = String(args.at(-1));
    expect(args.slice(0, -1)).toEqual(['-suppress-warnings', '-e']);
    expect(script).not.toContain('SecItemUpdate');
    expect(script).not.toContain('SecItemDelete');
    // The created master trusts the `security` reader (no prompt in launchd).
    expect(script).toContain(
      'SecTrustedApplicationCreateFromPath("/usr/bin/security", &trustedReader)'
    );
    expect(script).toContain('kSecAttrAccess as String: access');
  });
});
