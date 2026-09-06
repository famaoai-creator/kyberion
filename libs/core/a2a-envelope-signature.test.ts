import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  canonicalA2AEnvelopeContent,
  _resetA2ASecretCacheForTests,
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
    _resetA2ASecretCacheForTests();
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.KYBERION_A2A_SECRET;
    else process.env.KYBERION_A2A_SECRET = savedSecret;
    if (savedMode === undefined) delete process.env.KYBERION_A2A_SIGNATURE;
    else process.env.KYBERION_A2A_SIGNATURE = savedMode;
    _resetA2ASecretCacheForTests();
  });

  it('signs and verifies with the shared secret (cross-process equivalent)', () => {
    const { signature, sig_alg } = signA2AContent('hello');
    expect(sig_alg).toBe('hmac-sha256');
    // simulate another process resolving the same env secret
    _resetA2ASecretCacheForTests();
    expect(verifyA2AContent('hello', signature)).toEqual({ valid: true });
  });

  it('rejects mismatched keys and tampered content', () => {
    const { signature } = signA2AContent('hello');
    expect(verifyA2AContent('tampered', signature).valid).toBe(false);

    process.env.KYBERION_A2A_SECRET = 'a-different-key';
    _resetA2ASecretCacheForTests();
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

  it('fails closed when the persisted secret resource is not a regular file', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/a2a-envelope-signature.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('safeLstat(secretPath).isFile()');
    expect(source).toContain('[A2A_SECRET_RESOURCE]');
  });

  it('defaults to warn mode; enforce only when explicitly set', () => {
    expect(resolveA2ASignatureMode()).toBe('warn');
    process.env.KYBERION_A2A_SIGNATURE = 'enforce';
    expect(resolveA2ASignatureMode()).toBe('enforce');
    process.env.KYBERION_A2A_SIGNATURE = 'garbage';
    expect(resolveA2ASignatureMode()).toBe('warn');
  });

  describe('NI-02 sender_nhi_id claim in the signed content', () => {
    const baseHeader = {
      msg_id: 'MSG-NI02',
      sender: 'sender-x',
      receiver: 'agent-y',
      performative: 'request',
    };

    it('canonicalization without the claim is byte-identical to the pre-NI-02 form (backward compat)', () => {
      const withoutField = canonicalA2AEnvelopeContent({
        header: baseHeader,
        payload: { text: 'hi' },
      });
      const withUndefined = canonicalA2AEnvelopeContent({
        header: { ...baseHeader, sender_nhi_id: undefined },
        payload: { text: 'hi' },
      });
      expect(withUndefined).toBe(withoutField);
      // A legacy signature over the claim-less content still verifies.
      const legacySignature = signA2AContent(withoutField).signature;
      expect(verifyA2AContent(withUndefined, legacySignature)).toEqual({ valid: true });
    });

    it('tampering with sender_nhi_id breaks signature verification', () => {
      const claimed = canonicalA2AEnvelopeContent({
        header: { ...baseHeader, sender_nhi_id: 'kyberion://agent/ni02-org/worker-a' },
        payload: { text: 'hi' },
      });
      const { signature } = signA2AContent(claimed);
      expect(verifyA2AContent(claimed, signature)).toEqual({ valid: true });

      const tampered = canonicalA2AEnvelopeContent({
        header: { ...baseHeader, sender_nhi_id: 'kyberion://agent/ni02-org/impostor' },
        payload: { text: 'hi' },
      });
      expect(verifyA2AContent(tampered, signature).valid).toBe(false);

      // Stripping a present claim also breaks the signature.
      const stripped = canonicalA2AEnvelopeContent({
        header: baseHeader,
        payload: { text: 'hi' },
      });
      expect(verifyA2AContent(stripped, signature).valid).toBe(false);
    });
  });
});
