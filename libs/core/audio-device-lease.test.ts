import { afterEach, describe, expect, it } from 'vitest';
import { AudioDeviceLeaseManager } from './audio-device-lease.js';
import { safeRmSync } from './secure-io.js';
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
});
