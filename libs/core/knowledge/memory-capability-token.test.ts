import { describe, expect, it } from 'vitest';
import {
  assertMemoryWriteCapability,
  issueMemoryCapabilityToken,
  validateMemoryCapabilityToken,
  type MemoryCapabilityToken,
} from './memory-capability-token.js';

const SECRET = 'test-secret-harness-landscape-poc';
const NOW = Date.parse('2026-02-01T00:00:00.000Z');

function issue(overrides: Record<string, unknown> = {}): MemoryCapabilityToken {
  return issueMemoryCapabilityToken(
    {
      partition: 'confidential/acme-corp',
      ops: ['read', 'write'],
      subject: 'agent:worker-1',
      issuer: 'mission:MSN-9',
      expiresAt: NOW + 60_000,
      ...overrides,
    },
    { secret: SECRET, now: NOW }
  );
}

describe('issueMemoryCapabilityToken', () => {
  it('issues a self-contained token with a canonical signed payload', () => {
    const token = issue();
    expect(token.sig_alg).toBe('hmac-sha256');
    expect(token.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(token.payload).toMatchObject({
      version: 1,
      issuer: 'mission:MSN-9',
      subject: 'agent:worker-1',
      partition: 'confidential/acme-corp',
      ops: ['read', 'write'],
      issued_at: '2026-02-01T00:00:00.000Z',
      expires_at: '2026-02-01T00:01:00.000Z',
    });
  });

  it('normalizes a tier shorthand into the partition claim', () => {
    const token = issue({ partition: undefined, tier: 'personal' });
    expect(token.payload.partition).toBe('tier:personal');
  });

  it('deduplicates ops and rejects unknown ops', () => {
    expect(issue({ ops: ['read', 'read', 'write'] }).payload.ops).toEqual(['read', 'write']);
    expect(() => issue({ ops: ['read', 'export'] })).toThrow('unknown_memory_capability_op');
  });

  it('requires partition, issuer, subject, and at least one op', () => {
    expect(() => issue({ partition: undefined, tier: undefined })).toThrow(
      'memory_capability_partition_required'
    );
    expect(() => issue({ issuer: ' ' })).toThrow('memory_capability_issuer_required');
    expect(() => issue({ subject: '' })).toThrow('memory_capability_subject_required');
    expect(() => issue({ ops: [] })).toThrow('memory_capability_ops_required');
  });
});

describe('validateMemoryCapabilityToken', () => {
  it('accepts a valid token for a granted op and partition', () => {
    const token = issue();
    expect(
      validateMemoryCapabilityToken(
        token,
        { partition: 'confidential/acme-corp', op: 'write', now: NOW + 1_000 },
        { secret: SECRET }
      )
    ).toEqual({ ok: true });
  });

  it('verifies after a JSON round-trip regardless of key order', () => {
    const token = issue();
    const repacked = JSON.parse(
      `{"signature":"${token.signature}","sig_alg":"hmac-sha256","payload":{"expires_at":"${token.payload.expires_at}","ops":${JSON.stringify(token.payload.ops)},"partition":"${token.payload.partition}","subject":"${token.payload.subject}","issuer":"${token.payload.issuer}","token_id":"${token.payload.token_id}","issued_at":"${token.payload.issued_at}","version":1}}`
    );
    expect(
      validateMemoryCapabilityToken(
        repacked,
        { partition: 'confidential/acme-corp', op: 'read', now: NOW },
        { secret: SECRET }
      ).ok
    ).toBe(true);
  });

  it('rejects a tampered payload and a wrong secret', () => {
    const token = issue();
    const tampered: MemoryCapabilityToken = {
      ...token,
      payload: { ...token.payload, ops: ['read', 'write', 'promote'] },
    };
    expect(
      validateMemoryCapabilityToken(
        tampered,
        { partition: 'confidential/acme-corp', op: 'promote', now: NOW },
        { secret: SECRET }
      )
    ).toEqual({ ok: false, reason: 'signature_mismatch' });
    expect(
      validateMemoryCapabilityToken(
        token,
        { partition: 'confidential/acme-corp', op: 'read', now: NOW },
        { secret: 'wrong-secret' }
      )
    ).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects malformed tokens without throwing', () => {
    for (const bad of [null, 'token', { payload: {} }, { payload: issue().payload }]) {
      expect(
        validateMemoryCapabilityToken(
          bad,
          { partition: 'confidential/acme-corp', op: 'read', now: NOW },
          { secret: SECRET }
        ).ok
      ).toBe(false);
    }
  });

  it('enforces expiry against the injected clock', () => {
    const token = issue();
    expect(
      validateMemoryCapabilityToken(
        token,
        { partition: 'confidential/acme-corp', op: 'read', now: NOW + 60_000 },
        { secret: SECRET }
      )
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('enforces partition binding and op grants', () => {
    const token = issue();
    expect(
      validateMemoryCapabilityToken(
        token,
        { partition: 'confidential/beta-corp', op: 'read', now: NOW },
        { secret: SECRET }
      )
    ).toEqual({ ok: false, reason: 'partition_mismatch' });
    expect(
      validateMemoryCapabilityToken(
        token,
        { partition: 'confidential/acme-corp', op: 'promote', now: NOW },
        { secret: SECRET }
      )
    ).toEqual({ ok: false, reason: 'op_not_granted' });
    expect(
      validateMemoryCapabilityToken(
        token,
        { tier: 'confidential', op: 'read', now: NOW },
        {
          secret: SECRET,
        }
      )
    ).toEqual({ ok: false, reason: 'partition_mismatch' });
  });
});

describe('assertMemoryWriteCapability', () => {
  it('returns the payload on a valid write grant and throws otherwise', () => {
    const token = issue();
    expect(
      assertMemoryWriteCapability(token, 'confidential/acme-corp', {
        secret: SECRET,
        now: NOW,
      }).subject
    ).toBe('agent:worker-1');
    expect(() =>
      assertMemoryWriteCapability(token, 'confidential/beta-corp', {
        secret: SECRET,
        now: NOW,
      })
    ).toThrow('[MEMORY_CAPABILITY_DENIED]');
    expect(() =>
      assertMemoryWriteCapability(null, 'confidential/acme-corp', { secret: SECRET, now: NOW })
    ).toThrow('[MEMORY_CAPABILITY_DENIED]');
  });
});

describe('review fixes', () => {
  it('rejects an explicitly empty partition scope (fail-closed)', () => {
    const token = issue();
    expect(
      validateMemoryCapabilityToken(
        token,
        { partition: '', op: 'write', now: NOW },
        { secret: SECRET }
      )
    ).toEqual({ ok: false, reason: 'invalid_check' });
    expect(() => assertMemoryWriteCapability(token, '', { secret: SECRET, now: NOW })).toThrow(
      /MEMORY_CAPABILITY_DENIED/
    );
  });

  it('rejects a non-finite verification timestamp', () => {
    const token = issue();
    expect(
      validateMemoryCapabilityToken(
        token,
        { partition: 'confidential/acme-corp', op: 'read', now: 'garbage' },
        { secret: SECRET }
      )
    ).toEqual({ ok: false, reason: 'invalid_check' });
  });
});
