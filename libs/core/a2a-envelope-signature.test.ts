import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resetA2ASecretCache,
  resolveA2ASecret,
  resolveA2ASignatureMode,
  signA2AContent,
  verifyA2AContent,
} from './a2a-envelope-signature.js';

describe('a2a-envelope-signature (AA-03)', () => {
  const savedSecret = process.env.KYBERION_A2A_SECRET;
  const savedMode = process.env.KYBERION_A2A_SIGNATURE;

  beforeEach(() => {
    process.env.KYBERION_A2A_SECRET = 'test-secret-key';
    delete process.env.KYBERION_A2A_SIGNATURE;
    resetA2ASecretCache();
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.KYBERION_A2A_SECRET;
    else process.env.KYBERION_A2A_SECRET = savedSecret;
    if (savedMode === undefined) delete process.env.KYBERION_A2A_SIGNATURE;
    else process.env.KYBERION_A2A_SIGNATURE = savedMode;
    resetA2ASecretCache();
  });

  it('signs and verifies with the shared secret (cross-process equivalent)', () => {
    const { signature, sig_alg } = signA2AContent('hello');
    expect(sig_alg).toBe('hmac-sha256');
    // simulate another process resolving the same env secret
    resetA2ASecretCache();
    expect(verifyA2AContent('hello', signature)).toEqual({ valid: true });
  });

  it('rejects mismatched keys and tampered content', () => {
    const { signature } = signA2AContent('hello');
    expect(verifyA2AContent('tampered', signature).valid).toBe(false);

    process.env.KYBERION_A2A_SECRET = 'a-different-key';
    resetA2ASecretCache();
    const verdict = verifyA2AContent('hello', signature);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe('signature mismatch');
  });

  it('classifies missing and malformed signatures', () => {
    expect(verifyA2AContent('hello', undefined)).toEqual({
      valid: false,
      reason: 'missing signature',
    });
    expect(verifyA2AContent('hello', 'zz-not-hex').valid).toBe(false);
  });

  it('resolves env secrets without touching the persisted key file', () => {
    expect(resolveA2ASecret()).toBe('test-secret-key');
  });

  it('defaults to warn mode; enforce only when explicitly set', () => {
    expect(resolveA2ASignatureMode()).toBe('warn');
    process.env.KYBERION_A2A_SIGNATURE = 'enforce';
    expect(resolveA2ASignatureMode()).toBe('enforce');
    process.env.KYBERION_A2A_SIGNATURE = 'garbage';
    expect(resolveA2ASignatureMode()).toBe('warn');
  });
});
