/**
 * Audio device lease — a thin `device` adapter over the lease-backend seam
 * (W3). Holder, expiry and fencing are decided by `libs/core/lease/`; this
 * module only names the resource (`audio:<device_uid>`) and the lease dir.
 */

import * as pathResolver from '../path-resolver.js';
import {
  DeviceLeaseManager,
  type DeviceLease,
  type DeviceLeaseManagerOptions,
  type DeviceLeaseRecord,
} from '../lease/device-lease.js';

export type AudioDeviceLeaseRecord = DeviceLeaseRecord;
export type AudioDeviceLease = DeviceLease<AudioDeviceLeaseRecord>;
export type AudioDeviceLeaseManagerOptions = DeviceLeaseManagerOptions;

const localLeases = new Set<string>();

export class AudioDeviceLeaseManager extends DeviceLeaseManager {
  constructor(options: AudioDeviceLeaseManagerOptions = {}) {
    super('audio', pathResolver.shared('runtime/audio-leases'), localLeases, options);
  }
}
