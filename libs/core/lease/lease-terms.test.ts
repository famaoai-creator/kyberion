import { describe, expect, it } from 'vitest';
import {
  grantLeaseTerms,
  isLeaseHeldBy,
  isLeaseLive,
  leaseExpiresAtIso,
  leaseTermsFromRecord,
  LeaseTermsError,
  releaseLeaseTerms,
  renewLeaseTerms,
} from './lease-terms.js';
import { isLeaseResourceKind, LEASE_RESOURCE_KINDS } from './lease-backend.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof LeaseTermsError ? error.code : 'other';
  }
  return undefined;
}

describe('lease-terms', () => {
  it('declares the five D2 resource kinds', () => {
    expect([...LEASE_RESOURCE_KINDS]).toEqual([
      'work_item',
      'mission',
      'path',
      'device',
      'dot_slot',
    ]);
    expect(isLeaseResourceKind('device')).toBe(true);
    expect(isLeaseResourceKind('grant')).toBe(false);
  });

  it('grants the next fence and refuses while a live generation is held', () => {
    const first = grantLeaseTerms({
      kind: 'work_item',
      resourceId: 'WI-1',
      holder: 'peer-a',
      ttlMs: 1000,
      nowMs: 10_000,
    });
    expect(first).toMatchObject({ holder: 'peer-a', fence: 1, expires_at_ms: 11_000 });
    expect(
      codeOf(() =>
        grantLeaseTerms({
          kind: 'work_item',
          resourceId: 'WI-1',
          holder: 'peer-b',
          ttlMs: 1000,
          nowMs: 10_500,
          previous: { holder: first.holder, fence: first.fence, expires_at: first.expires_at_ms },
        })
      )
    ).toBe('LEASE_HELD');
    // Same holder is not implicit re-entry either.
    expect(
      codeOf(() =>
        grantLeaseTerms({
          kind: 'work_item',
          resourceId: 'WI-1',
          holder: 'peer-a',
          ttlMs: 1000,
          nowMs: 10_500,
          previous: { holder: first.holder, fence: first.fence, expires_at: first.expires_at_ms },
        })
      )
    ).toBe('LEASE_HELD');
    const takeover = grantLeaseTerms({
      kind: 'work_item',
      resourceId: 'WI-1',
      holder: 'peer-b',
      ttlMs: 1000,
      nowMs: 11_000,
      previous: { holder: first.holder, fence: first.fence, expires_at: leaseExpiresAtIso(first) },
    });
    expect(takeover.fence).toBe(2);
  });

  it('treats released generations as free and keeps the fence monotonic', () => {
    const next = grantLeaseTerms({
      kind: 'path',
      resourceId: 's:a.ts',
      holder: 'claude/p1',
      ttlMs: 1000,
      nowMs: 0,
      previous: { holder: 'codex/p2', fence: 7, expires_at: 999_999, released: true },
    });
    expect(next.fence).toBe(8);
    expect(releaseLeaseTerms(next)).toMatchObject({ fence: 8, expires_at_ms: 0 });
  });

  it('renews only for the holder and never revives a lapsed lease', () => {
    const terms = grantLeaseTerms({
      kind: 'device',
      resourceId: 'video:uid',
      holder: 'session-1',
      ttlMs: 100,
      nowMs: 1000,
    });
    expect(renewLeaseTerms(terms, { holder: 'session-1', ttlMs: 100, nowMs: 1050 })).toMatchObject({
      fence: 1,
      expires_at_ms: 1150,
      renewed_at_ms: 1050,
    });
    expect(
      codeOf(() => renewLeaseTerms(terms, { holder: 'session-2', ttlMs: 100, nowMs: 1050 }))
    ).toBe('LEASE_NOT_HOLDER');
    expect(
      codeOf(() => renewLeaseTerms(terms, { holder: 'session-1', ttlMs: 100, nowMs: 1100 }))
    ).toBe('LEASE_EXPIRED');
  });

  it('rejects malformed input', () => {
    const base = { kind: 'mission' as const, resourceId: 'm', holder: 'h', ttlMs: 10, nowMs: 0 };
    expect(codeOf(() => grantLeaseTerms({ ...base, holder: ' ' }))).toBe('LEASE_INVALID_ARGUMENT');
    expect(codeOf(() => grantLeaseTerms({ ...base, ttlMs: 0 }))).toBe('LEASE_INVALID_ARGUMENT');
    expect(codeOf(() => grantLeaseTerms({ ...base, nowMs: Number.NaN }))).toBe(
      'LEASE_INVALID_ARGUMENT'
    );
    expect(
      codeOf(() => grantLeaseTerms({ ...base, previous: { fence: Number.MAX_SAFE_INTEGER } }))
    ).toBe('LEASE_EXHAUSTED');
  });

  it('evaluates liveness for ms and ISO expiries, failing closed on unreadable ones', () => {
    expect(isLeaseLive({ expires_at: new Date(2000).toISOString() }, 1999)).toBe(true);
    expect(isLeaseLive({ expires_at: new Date(2000).toISOString() }, 2000)).toBe(false);
    expect(isLeaseLive({ expires_at_ms: 0 }, 0)).toBe(false);
    expect(isLeaseLive({ expires_at: 'not-a-date' }, 0)).toBe(false);
    expect(isLeaseLive({ expires_at: 5000, released: true }, 0)).toBe(false);
    expect(isLeaseHeldBy({ holder: 'a' }, ' a ')).toBe(true);
    expect(isLeaseHeldBy({ holder: 'a' }, undefined)).toBe(false);
  });

  it('reads legacy records without a fence as generation 0', () => {
    expect(
      leaseTermsFromRecord({
        kind: 'work_item',
        resourceId: 'WI-legacy',
        holder: 'peer',
        expires_at: new Date(5000).toISOString(),
      })
    ).toMatchObject({ fence: 0, expires_at_ms: 5000, acquired_at_ms: 5000 });
  });
});
