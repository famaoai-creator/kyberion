import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const auditRecords = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../governance/audit-chain.js', () => ({
  auditChain: {
    record: (entry: Record<string, unknown>) => {
      auditRecords.push(entry);
      return entry;
    },
  },
}));

import { createMemoryLeaseBackend } from './memory-lease-backend.js';
import {
  acquireResourceLeaseSync,
  isResourceLeaseCurrent,
  readResourceLease,
  releaseResourceLeaseSync,
  renewResourceLeaseSync,
  type ResourceLeaseRef,
} from './resource-lease.js';
import { LeaseTermsError } from './lease-terms.js';
import { DeviceLeaseManager } from './device-lease.js';
import * as pathResolver from '../path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof LeaseTermsError ? error.code : String(error);
  }
  return undefined;
}

describe('resource-lease (detached leases on the lease-backend seam)', () => {
  beforeEach(() => auditRecords.splice(0));

  it('acquires, renews and releases with one fence and one audit shape', () => {
    const ref: ResourceLeaseRef = {
      kind: 'dot_slot',
      resourceId: 'dot-a:slot-1',
      leaseKey: 'k1',
      backend: createMemoryLeaseBackend(),
    };
    const lease = acquireResourceLeaseSync({ ...ref, holder: 'dot-a', ttlMs: 100, nowMs: 1000 });
    expect(lease).toMatchObject({
      resource_kind: 'dot_slot',
      owner_id: 'dot-a',
      fence: 1,
      expires_at_ms: 1100,
    });
    expect(
      codeOf(() => acquireResourceLeaseSync({ ...ref, holder: 'dot-b', ttlMs: 100, nowMs: 1050 }))
    ).toBe('LEASE_HELD');
    const renewed = renewResourceLeaseSync({ ...ref, lease, ttlMs: 100, nowMs: 1080 });
    expect(renewed).toMatchObject({ fence: 1, expires_at_ms: 1180 });
    expect(isResourceLeaseCurrent(ref, renewed, 1100)).toBe(true);
    expect(releaseResourceLeaseSync({ ...ref, lease: renewed })).toBe(true);
    expect(readResourceLease(ref)).toMatchObject({ fence: 1, expires_at_ms: 0 });
    // A stale token never releases or renews the next generation.
    const next = acquireResourceLeaseSync({ ...ref, holder: 'dot-b', ttlMs: 100, nowMs: 1090 });
    expect(next.fence).toBe(2);
    expect(releaseResourceLeaseSync({ ...ref, lease })).toBe(false);
    expect(codeOf(() => renewResourceLeaseSync({ ...ref, lease, ttlMs: 100, nowMs: 1095 }))).toBe(
      'LEASE_NOT_HOLDER'
    );

    expect(auditRecords.map((entry) => entry.action)).toEqual([
      'lease.acquire',
      'lease.renew',
      'lease.release',
      'lease.acquire',
    ]);
    for (const entry of auditRecords) {
      expect(entry.operation).toBe('dot_slot:dot-a:slot-1');
      expect(Object.keys(entry.metadata as object).sort()).toEqual(
        expect.arrayContaining(['fence', 'holder', 'resource_id', 'resource_kind'])
      );
    }
    expect(auditRecords[2]!.metadata).not.toHaveProperty('expires_at');
  });

  it('audits the displaced generation as expired when a lapsed lease is taken over', () => {
    const ref: ResourceLeaseRef = {
      kind: 'device',
      resourceId: 'audio:uid',
      leaseKey: 'k2',
      backend: createMemoryLeaseBackend(),
    };
    acquireResourceLeaseSync({ ...ref, holder: 's1', ttlMs: 10, nowMs: 0 });
    acquireResourceLeaseSync({ ...ref, holder: 's2', ttlMs: 10, nowMs: 50 });
    expect(auditRecords.map((entry) => `${entry.action}:${entry.agentId}`)).toEqual([
      'lease.acquire:s1',
      'lease.expire:s1',
      'lease.acquire:s2',
    ]);
  });

  it('dual-reads a pre-W3 record: live blocks, lapsed is replaced', () => {
    const backend = createMemoryLeaseBackend();
    const legacy = { holder: 'old-session', expires_at: new Date(5000).toISOString() };
    const ref: ResourceLeaseRef = {
      kind: 'device',
      resourceId: 'video:uid',
      leaseKey: 'k3',
      backend,
      readLegacy: () => legacy,
    };
    expect(
      codeOf(() => acquireResourceLeaseSync({ ...ref, holder: 'new', ttlMs: 10, nowMs: 4000 }))
    ).toBe('LEASE_HELD');
    expect(acquireResourceLeaseSync({ ...ref, holder: 'new', ttlMs: 10, nowMs: 6000 }).fence).toBe(
      1
    );
  });
});

describe('DeviceLeaseManager (video/audio adapter)', () => {
  const leaseDir = pathResolver.sharedTmp('device-lease-adapter-tests');
  afterEach(() => safeRmSync(leaseDir, { recursive: true, force: true }));

  function lockPath(uid: string): string {
    return `${leaseDir}/${createHash('sha256').update(uid).digest('hex').slice(0, 32)}.json`;
  }

  it('honours a live pre-W3 record at the same path, then fences across sessions', () => {
    const uid = 'uid-legacy-live';
    safeMkdir(leaseDir, { recursive: true });
    safeWriteFile(
      lockPath(uid),
      JSON.stringify({
        lease_id: 'legacy',
        device_uid: uid,
        pid: 1,
        session_id: 'legacy-session',
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        heartbeat_at: new Date().toISOString(),
      })
    );
    const manager = new DeviceLeaseManager('video', leaseDir, new Set(), { lease_dir: leaseDir });
    expect(() => manager.acquire(uid, 'fresh')).toThrow(/already leased/);

    const other = 'uid-fenced';
    const first = manager.acquire(other, 'session-1');
    first.release();
    const released = JSON.parse(String(safeReadFile(lockPath(other), { encoding: 'utf8' })));
    expect(released).toMatchObject({ resource_kind: 'device', fence: 1, expires_at_ms: 0 });
    const second = manager.acquire(other, 'session-2');
    const held = JSON.parse(String(safeReadFile(lockPath(other), { encoding: 'utf8' })));
    expect(held).toMatchObject({ owner_id: 'session-2', fence: 2 });
    expect(second.record.session_id).toBe('session-2');
    second.release();
  });

  it('detects a lost lease on heartbeat and resumes a stalled one nobody took', () => {
    let now = 1000;
    const manager = new DeviceLeaseManager('audio', leaseDir, new Set(), {
      lease_dir: leaseDir,
      now: () => now,
    });
    const lease = manager.acquire('uid-stall', 'session-1', 100);
    now = 5000; // stalled past the TTL; nobody else acquired
    lease.heartbeat();
    expect(Date.parse(lease.record.expires_at)).toBe(5100);
    const stolen = new DeviceLeaseManager('audio', leaseDir, new Set(), {
      lease_dir: leaseDir,
      now: () => now,
    });
    now = 6000;
    const thief = stolen.acquire('uid-stall', 'session-2', 100);
    expect(() => lease.heartbeat()).toThrow(/was lost/);
    thief.release();
  });
});
