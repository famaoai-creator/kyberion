import { describe, expect, it } from 'vitest';
import { parseShareGrantInput } from './share-grant-input';

describe('parseShareGrantInput', () => {
  it('accepts each supported operation shape', () => {
    expect(
      parseShareGrantInput({
        operation: 'register_resource',
        resourceRef: 'artifact:one',
        tenantSlug: 'tenant-a',
        taint: 'confidential',
        provenanceMissionId: 'mission-1',
      })
    ).toMatchObject({ operation: 'register_resource', taint: 'confidential' });
    expect(
      parseShareGrantInput({
        operation: 'issue_link',
        resourceRef: 'artifact:one',
        role: 'view',
        ttlMs: 60_000,
      })
    ).toEqual({
      operation: 'issue_link',
      resourceRef: 'artifact:one',
      role: 'view',
      ttlMs: 60_000,
    });
    expect(
      parseShareGrantInput({
        operation: 'register_session',
        resourceRef: 'artifact:one',
        token: 'share-token',
        sessionId: 'session-1',
        connectedAt: '2026-08-09T00:00:00.000Z',
      })
    ).toMatchObject({ operation: 'register_session', sessionId: 'session-1' });
  });

  it('rejects unknown fields, invalid enums, coercive numbers, and bad dates', () => {
    expect(() => parseShareGrantInput(null)).toThrow('payload must be an object');
    expect(() => parseShareGrantInput([])).toThrow('payload must be an object');
    expect(() =>
      parseShareGrantInput({
        operation: 'grant_edge',
        resourceRef: 'artifact:one',
        grantee: 'p',
        targetTenantSlug: 'tenant-a',
        role: 'view',
        extra: true,
      })
    ).toThrow('unexpected share grant field');
    expect(() =>
      parseShareGrantInput({
        operation: 'register_resource',
        resourceRef: 'artifact:one',
        tenantSlug: 'tenant-a',
        taint: 'secret',
      })
    ).toThrow('taint');
    expect(() =>
      parseShareGrantInput({
        operation: 'issue_link',
        resourceRef: 'artifact:one',
        role: 'view',
        ttlMs: '60000',
      })
    ).toThrow('ttlMs');
    expect(() =>
      parseShareGrantInput({
        operation: 'register_session',
        resourceRef: 'artifact:one',
        token: 'token',
        sessionId: 'session',
        connectedAt: 'not-a-date',
      })
    ).toThrow('connectedAt');
  });
});
