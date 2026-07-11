import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  decryptConnectionDocument,
  encryptConnectionDocument,
  isEncryptedConnectionEnvelope,
  overrideSecretEncryptionKeyForTests,
  resolveSecretEncryptionMode,
} from './secret-encryption.js';

const KEY = randomBytes(32);

afterEach(() => {
  overrideSecretEncryptionKeyForTests(null);
});

describe('resolveSecretEncryptionMode', () => {
  it('defaults to none and accepts keychain', () => {
    expect(resolveSecretEncryptionMode({})).toBe('none');
    expect(resolveSecretEncryptionMode({ KYBERION_SECRET_ENCRYPTION: '' })).toBe('none');
    expect(resolveSecretEncryptionMode({ KYBERION_SECRET_ENCRYPTION: 'keychain' })).toBe(
      'keychain'
    );
  });

  it('throws on unknown modes instead of silently writing plaintext', () => {
    expect(() => resolveSecretEncryptionMode({ KYBERION_SECRET_ENCRYPTION: 'age' })).toThrow(
      /unsupported/
    );
  });
});

describe('envelope codec', () => {
  it('round-trips a document', () => {
    overrideSecretEncryptionKeyForTests(KEY);
    const document = { api_key: 'sk-123', nested: { region: 'ap-northeast-1' } };
    const envelope = encryptConnectionDocument(document);

    expect(isEncryptedConnectionEnvelope(envelope)).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain('sk-123');
    expect(decryptConnectionDocument(envelope)).toEqual(document);
  });

  it('rejects tampered ciphertext and wrong keys', () => {
    overrideSecretEncryptionKeyForTests(KEY);
    const envelope = encryptConnectionDocument({ token: 'secret-value' });

    const tampered = {
      ...envelope,
      ciphertext: Buffer.from('tampered-data').toString('base64'),
    };
    expect(() => decryptConnectionDocument(tampered)).toThrow();

    overrideSecretEncryptionKeyForTests(randomBytes(32));
    expect(() => decryptConnectionDocument(envelope)).toThrow();
  });

  it('does not classify plaintext documents as envelopes', () => {
    expect(isEncryptedConnectionEnvelope({ api_key: 'plain' })).toBe(false);
    expect(isEncryptedConnectionEnvelope(null)).toBe(false);
    expect(isEncryptedConnectionEnvelope('str')).toBe(false);
  });
});
