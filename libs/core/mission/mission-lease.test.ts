import { describe, expect, it } from 'vitest';
import { createMissionLeaseManager, type MissionLeaseManager } from './mission-lease.js';

// Deterministic injected clock: all times are plain ms numbers chosen per step.
const T0 = 1_000;
const TTL = 5_000;

let manager: MissionLeaseManager;
const fresh = () => (manager = createMissionLeaseManager());

function codes(result: { issues: { code: string }[] }): string[] {
  return result.issues.map((i) => i.code);
}

describe('mission-lease (Mastra agent-controller lease PoC)', () => {
  describe('acquire / renew / release happy path', () => {
    it('acquires a TTL-bound lease with fence 1', () => {
      fresh();
      const res = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-a',
        ttlMs: TTL,
        now: T0,
      });
      expect(res.ok).toBe(true);
      expect(res.issues).toEqual([]);
      expect(res.lease).toMatchObject({
        resource_id: 'thread-1',
        holder: 'run-a',
        fence: 1,
        status: 'active',
        acquired_at_ms: T0,
        expires_at_ms: T0 + TTL,
        renew_count: 0,
      });
      expect(res.suspended_followers).toEqual([]);
      expect(manager.getHolder('thread-1', T0)).toBe('run-a');
    });

    it('is idempotent for a same-holder re-acquire (no fence bump, no extension)', () => {
      fresh();
      const first = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-a',
        ttlMs: TTL,
        now: T0,
      });
      const again = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-a',
        ttlMs: TTL,
        now: T0 + 1_000,
      });
      expect(again.ok).toBe(true);
      expect(again.lease?.lease_id).toBe(first.lease?.lease_id);
      expect(again.lease?.fence).toBe(1);
      expect(again.lease?.expires_at_ms).toBe(T0 + TTL); // unchanged — renew is explicit
    });

    it('renews by the current holder, refreshing expiry to now + extendMs', () => {
      fresh();
      const acquired = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-a',
        ttlMs: TTL,
        now: T0,
      });
      const renewed = manager.renewLease({
        leaseId: acquired.lease!.lease_id,
        holder: 'run-a',
        extendMs: 2_000,
        now: T0 + 4_000,
      });
      expect(renewed.ok).toBe(true);
      expect(renewed.lease).toMatchObject({
        expires_at_ms: T0 + 6_000,
        renewed_at_ms: T0 + 4_000,
        renew_count: 1,
        status: 'active',
      });
    });

    it('releases by the holder and records released_at', () => {
      fresh();
      const acquired = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-a',
        ttlMs: TTL,
        now: T0,
      });
      const released = manager.releaseLease({
        leaseId: acquired.lease!.lease_id,
        holder: 'run-a',
        now: T0 + 100,
      });
      expect(released.ok).toBe(true);
      expect(released.lease).toMatchObject({ status: 'released', released_at_ms: T0 + 100 });
      expect(manager.getHolder('thread-1', T0 + 100)).toBeUndefined();
    });
  });

  describe('expiry frees the resource', () => {
    it('a lapsed lease is expired at its deadline (expires_at_ms <= now)', () => {
      fresh();
      const acquired = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-a',
        ttlMs: TTL,
        now: T0,
      });
      expect(manager.getLease(acquired.lease!.lease_id, T0 + TTL - 1)?.status).toBe('active');
      // Boundary: expiry is inclusive — at expires_at_ms the lease is dead.
      expect(manager.getLease(acquired.lease!.lease_id, T0 + TTL)?.status).toBe('expired');
    });

    it('another holder can acquire once the lease lapses', () => {
      fresh();
      manager.acquireLease({ resource: 'thread-1', holder: 'run-a', ttlMs: TTL, now: T0 });
      const takeover = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-b',
        ttlMs: TTL,
        now: T0 + TTL,
      });
      expect(takeover.ok).toBe(true);
      expect(takeover.lease).toMatchObject({ holder: 'run-b', fence: 2 });
      expect(manager.getHolder('thread-1', T0 + TTL)).toBe('run-b');
    });
  });

  describe('holder-guarded renewal and release', () => {
    it('rejects renewal by a non-holder with LEASE_NOT_HOLDER and changes nothing', () => {
      fresh();
      const acquired = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-a',
        ttlMs: TTL,
        now: T0,
      });
      const res = manager.renewLease({
        leaseId: acquired.lease!.lease_id,
        holder: 'run-b',
        extendMs: 9_000,
        now: T0 + 100,
      });
      expect(res.ok).toBe(false);
      expect(codes(res)).toEqual(['LEASE_NOT_HOLDER']);
      expect(manager.getLease(acquired.lease!.lease_id, T0 + 100)?.expires_at_ms).toBe(T0 + TTL);
    });

    it('rejects release by a non-holder with LEASE_NOT_HOLDER', () => {
      fresh();
      const acquired = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-a',
        ttlMs: TTL,
        now: T0,
      });
      const res = manager.releaseLease({
        leaseId: acquired.lease!.lease_id,
        holder: 'run-b',
        now: T0 + 100,
      });
      expect(res.ok).toBe(false);
      expect(codes(res)).toEqual(['LEASE_NOT_HOLDER']);
      expect(manager.getLease(acquired.lease!.lease_id, T0 + 100)?.status).toBe('active');
    });
  });

  describe('follower suspension', () => {
    it('a suspended follower cannot acquire, then acquires after release', () => {
      fresh();
      manager.acquireLease({ resource: 'thread-1', holder: 'run-a', ttlMs: TTL, now: T0 });

      const blocked = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-b',
        ttlMs: TTL,
        now: T0 + 10,
      });
      expect(blocked.ok).toBe(false);
      expect(codes(blocked)).toEqual(['LEASE_SUSPENDED']);
      // The blocking lease is echoed so the loser can route to the owner.
      expect(blocked.lease).toMatchObject({ holder: 'run-a', fence: 1 });
      expect(manager.isSuspended('thread-1', 'run-b', T0 + 10)).toBe(true);

      const leaseId = manager.getResourceLease('thread-1', T0 + 10)!.lease_id;
      manager.releaseLease({ leaseId, holder: 'run-a', now: T0 + 20 });
      // Release unsuspends: the contender record stays but its status clears.
      expect(manager.isSuspended('thread-1', 'run-b', T0 + 20)).toBe(false);
      expect(manager.listFollowers('thread-1', T0 + 20)).toEqual([
        { holder: 'run-b', status: 'unsuspended', contended_at_ms: T0 + 10 },
      ]);

      const takeover = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-b',
        ttlMs: TTL,
        now: T0 + 30,
      });
      expect(takeover.ok).toBe(true);
      expect(takeover.lease).toMatchObject({ holder: 'run-b', fence: 2 });
    });

    it('re-suspends a follower that retries while still held', () => {
      fresh();
      manager.acquireLease({ resource: 'thread-1', holder: 'run-a', ttlMs: TTL, now: T0 });
      manager.acquireLease({ resource: 'thread-1', holder: 'run-b', ttlMs: TTL, now: T0 + 10 });
      const retry = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-b',
        ttlMs: TTL,
        now: T0 + 20,
      });
      expect(retry.ok).toBe(false);
      expect(codes(retry)).toEqual(['LEASE_SUSPENDED']);
      // First-contention time is preserved across retries.
      expect(manager.listFollowers('thread-1', T0 + 20)[0].contended_at_ms).toBe(T0 + 10);
    });

    it('explicit suspendFollowers parks named contenders under the live holder', () => {
      fresh();
      manager.acquireLease({ resource: 'thread-1', holder: 'run-a', ttlMs: TTL, now: T0 });
      const res = manager.suspendFollowers({
        resource: 'thread-1',
        now: T0 + 5,
        followers: ['run-b', 'run-c'],
      });
      expect(res.ok).toBe(true);
      expect(res.suspended).toEqual(['run-b', 'run-c']);
      for (const contender of ['run-b', 'run-c']) {
        const blocked = manager.acquireLease({
          resource: 'thread-1',
          holder: contender,
          ttlMs: TTL,
          now: T0 + 6,
        });
        expect(codes(blocked)).toEqual(['LEASE_SUSPENDED']);
      }
    });

    it('suspendFollowers on a free resource is LEASE_NOT_FOUND', () => {
      fresh();
      const res = manager.suspendFollowers({ resource: 'thread-1', now: T0 });
      expect(res.ok).toBe(false);
      expect(codes(res)).toEqual(['LEASE_NOT_FOUND']);
    });
  });

  describe('takeover ordering', () => {
    it('fences increase monotonically across expiry-then-takeover and dead leases stay dead', () => {
      fresh();
      const a = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-a',
        ttlMs: TTL,
        now: T0,
      });
      expect(a.lease?.fence).toBe(1);

      // B and C contend while A holds — suspended in call order.
      manager.acquireLease({ resource: 'thread-1', holder: 'run-b', ttlMs: TTL, now: T0 + 10 });
      manager.acquireLease({ resource: 'thread-1', holder: 'run-c', ttlMs: TTL, now: T0 + 20 });

      // A lapses; B wins the takeover; C stays suspended under B.
      const b = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-b',
        ttlMs: TTL,
        now: T0 + TTL,
      });
      expect(b.ok).toBe(true);
      expect(b.lease?.fence).toBe(2);
      expect(b.lease?.lease_id).toBe('lease-thread-1-2');
      expect(b.suspended_followers).toEqual(['run-c']);
      expect(manager.isSuspended('thread-1', 'run-c', T0 + TTL)).toBe(true);

      // A's dead lease can never be renewed — the tombstone only reports.
      const deadRenew = manager.renewLease({
        leaseId: a.lease!.lease_id,
        holder: 'run-a',
        extendMs: TTL,
        now: T0 + TTL,
      });
      expect(deadRenew.ok).toBe(false);
      expect(codes(deadRenew)).toEqual(['LEASE_SUPERSEDED', 'LEASE_EXPIRED']);

      // B releases; C (the next queued contender) takes over at fence 3.
      manager.releaseLease({ leaseId: b.lease!.lease_id, holder: 'run-b', now: T0 + TTL + 1 });
      const c = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-c',
        ttlMs: TTL,
        now: T0 + TTL + 2,
      });
      expect(c.ok).toBe(true);
      expect(c.lease).toMatchObject({ holder: 'run-c', fence: 3 });
    });
  });

  describe('collect-all validation', () => {
    it('expired renew reports LEASE_EXPIRED', () => {
      fresh();
      const a = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-a',
        ttlMs: TTL,
        now: T0,
      });
      const res = manager.renewLease({
        leaseId: a.lease!.lease_id,
        holder: 'run-a',
        extendMs: TTL,
        now: T0 + TTL,
      });
      expect(res.ok).toBe(false);
      expect(codes(res)).toEqual(['LEASE_EXPIRED']);
    });

    it('collects every argument violation in one call', () => {
      fresh();
      const res = manager.acquireLease({ resource: ' ', holder: '', ttlMs: 0, now: Number.NaN });
      expect(res.ok).toBe(false);
      expect(codes(res)).toEqual([
        'LEASE_INVALID_ARGUMENT',
        'LEASE_INVALID_ARGUMENT',
        'LEASE_INVALID_ARGUMENT',
        'LEASE_INVALID_ARGUMENT',
      ]);
      expect(res.issues.map((i) => i.message).join(' ')).toMatch(/resource.*holder.*ttlMs.*now/s);
    });

    it('collects independent state violations (released + non-holder) together', () => {
      fresh();
      const a = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-a',
        ttlMs: TTL,
        now: T0,
      });
      manager.releaseLease({ leaseId: a.lease!.lease_id, holder: 'run-a', now: T0 + 1 });
      const res = manager.releaseLease({
        leaseId: a.lease!.lease_id,
        holder: 'run-b',
        now: T0 + 2,
      });
      expect(res.ok).toBe(false);
      expect(codes(res)).toEqual(['LEASE_RELEASED', 'LEASE_NOT_HOLDER']);
    });

    it('rejects unknown lease ids with LEASE_NOT_FOUND', () => {
      fresh();
      for (const op of [
        () => manager.renewLease({ leaseId: 'nope', holder: 'run-a', extendMs: 1, now: T0 }),
        () => manager.releaseLease({ leaseId: 'nope', holder: 'run-a', now: T0 }),
      ]) {
        const res = op();
        expect(res.ok).toBe(false);
        expect(codes(res)).toEqual(['LEASE_NOT_FOUND']);
      }
    });
  });

  describe('thread persistence (tombstones)', () => {
    it('released and expired leases remain readable by id and by resource', () => {
      fresh();
      const a = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-a',
        ttlMs: TTL,
        now: T0,
      });
      manager.releaseLease({ leaseId: a.lease!.lease_id, holder: 'run-a', now: T0 + 1 });
      // Tombstone survives: status reads 'released', never disappears.
      expect(manager.getLease(a.lease!.lease_id, T0 + 2)?.status).toBe('released');
      expect(manager.getResourceLease('thread-1', T0 + 2)?.status).toBe('released');

      const b = manager.acquireLease({
        resource: 'thread-1',
        holder: 'run-b',
        ttlMs: TTL,
        now: T0 + 3,
      });
      // Resource view moves to the new lease; the old id still reads back.
      expect(manager.getResourceLease('thread-1', T0 + 3)?.lease_id).toBe(b.lease!.lease_id);
      expect(manager.getLease(a.lease!.lease_id, T0 + 3)?.status).toBe('released');
    });
  });
});

describe('review fixes', () => {
  it('rejects renewal of a superseded lease generation', () => {
    fresh();
    const a = manager.acquireLease({ resource: 'r', holder: 'a', ttlMs: TTL, now: T0 });
    manager.acquireLease({ resource: 'r', holder: 'b', ttlMs: TTL, now: T0 + TTL });
    const res = manager.renewLease({
      leaseId: a.lease!.lease_id,
      holder: 'a',
      extendMs: 9_000,
      now: T0 + TTL + 1,
    });
    expect(res.ok).toBe(false);
    expect(codes(res)).toContain('LEASE_SUPERSEDED');
  });

  it('rejects a deadline that overflows to non-finite', () => {
    fresh();
    const res = manager.acquireLease({
      resource: 'r',
      holder: 'a',
      ttlMs: Number.MAX_VALUE,
      now: Number.MAX_VALUE,
    });
    expect(res.ok).toBe(false);
    expect(codes(res)).toContain('LEASE_INVALID_ARGUMENT');
  });
});
