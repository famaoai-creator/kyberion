import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AudioDeviceLeaseManager } from './audio-device-lease.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import * as pathResolver from './path-resolver.js';

const leaseDir = pathResolver.sharedTmp('audio-device-lease-tests');

afterEach(() => safeRmSync(leaseDir, { recursive: true, force: true }));

describe('AudioDeviceLeaseManager', () => {
  it('rejects concurrent sessions and releases the lease', () => {
    const first = new AudioDeviceLeaseManager({ lease_dir: leaseDir }).acquire(
      'BlackHole_UID',
      'session-1'
    );
    expect(() =>
      new AudioDeviceLeaseManager({ lease_dir: leaseDir }).acquire('BlackHole_UID', 'session-2')
    ).toThrow(/already leased/);
    first.release();
    const second = new AudioDeviceLeaseManager({ lease_dir: leaseDir }).acquire(
      'BlackHole_UID',
      'session-2'
    );
    expect(second.record.session_id).toBe('session-2');
    second.release();
  });

  it('extends expiry during heartbeat', () => {
    let now = 1000;
    const lease = new AudioDeviceLeaseManager({ lease_dir: leaseDir, now: () => now }).acquire(
      'uid-2',
      'session-2',
      100
    );
    const originalExpiry = lease.record.expires_at;
    now = 2000;
    lease.heartbeat();
    expect(lease.record.expires_at).not.toBe(originalExpiry);
    lease.release();
  });

  it('treats schema-invalid lease records as stale and replaces them', () => {
    const deviceUid = 'uid-invalid-record';
    const lockPath = `${leaseDir}/${createHash('sha256')
      .update(deviceUid)
      .digest('hex')
      .slice(0, 32)}.json`;
    safeMkdir(leaseDir, { recursive: true });
    safeWriteFile(
      lockPath,
      JSON.stringify({
        lease_id: 'not-a-uuid',
        device_uid: deviceUid,
        pid: process.pid,
        session_id: 'stale-session',
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        heartbeat_at: new Date().toISOString(),
        unexpected: true,
      })
    );

    const lease = new AudioDeviceLeaseManager({ lease_dir: leaseDir }).acquire(
      deviceUid,
      'fresh-session'
    );
    expect(lease.record.session_id).toBe('fresh-session');
    lease.release();
  });

  it('rejects a lease directory outside the repository', () => {
    expect(() => new AudioDeviceLeaseManager({ lease_dir: '/tmp/audio-device-leases' })).toThrow(
      /outside the repository root/
    );
  });
});
