import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { VideoDeviceLeaseManager } from './video-device-lease.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import * as pathResolver from './path-resolver.js';

const leaseDir = pathResolver.sharedTmp('video-device-lease-tests');

afterEach(() => safeRmSync(leaseDir, { recursive: true, force: true }));

describe('VideoDeviceLeaseManager', () => {
  it('rejects concurrent sessions and releases the lease', () => {
    const first = new VideoDeviceLeaseManager({ lease_dir: leaseDir }).acquire(
      '/dev/video2',
      'session-1'
    );
    expect(() =>
      new VideoDeviceLeaseManager({ lease_dir: leaseDir }).acquire('/dev/video2', 'session-2')
    ).toThrow(/already leased/);
    first.release();
    const second = new VideoDeviceLeaseManager({ lease_dir: leaseDir }).acquire(
      '/dev/video2',
      'session-2'
    );
    expect(second.record.session_id).toBe('session-2');
    second.release();
  });

  it('extends expiry during heartbeat', () => {
    let now = 1000;
    const lease = new VideoDeviceLeaseManager({ lease_dir: leaseDir, now: () => now }).acquire(
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

  it('treats invalid lease records as stale and replaces them', () => {
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

    const lease = new VideoDeviceLeaseManager({ lease_dir: leaseDir }).acquire(
      deviceUid,
      'fresh-session'
    );
    expect(lease.record.session_id).toBe('fresh-session');
    lease.release();
  });

  it('does not remove a replacement lease owned by another session', () => {
    const deviceUid = 'uid-replaced-record';
    const lockPath = `${leaseDir}/${createHash('sha256')
      .update(deviceUid)
      .digest('hex')
      .slice(0, 32)}.json`;
    const lease = new VideoDeviceLeaseManager({ lease_dir: leaseDir }).acquire(
      deviceUid,
      'session-1'
    );
    safeWriteFile(
      lockPath,
      JSON.stringify({
        ...lease.record,
        lease_id: 'replacement-lease',
        session_id: 'session-2',
      })
    );

    expect(() => lease.heartbeat()).toThrow(/was lost/);
    lease.release();
    const replacement = JSON.parse(String(safeReadFile(lockPath, { encoding: 'utf8' }))) as {
      lease_id: string;
    };
    expect(replacement.lease_id).toBe('replacement-lease');
  });

  it('rejects a lease directory outside the repository', () => {
    expect(() => new VideoDeviceLeaseManager({ lease_dir: '/tmp/video-device-leases' })).toThrow(
      /outside the repository root/
    );
  });
});
