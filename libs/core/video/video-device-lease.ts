/**
 * Video device lease — a thin `device` adapter over the lease-backend seam
 * (W3). Holder, expiry and fencing are decided by `libs/core/lease/`; this
 * module only names the resource (`video:<device_uid>`) and the lease dir.
 */

import * as pathResolver from '../path-resolver.js';
import {
  DeviceLeaseManager,
  type DeviceLease,
  type DeviceLeaseManagerOptions,
  type DeviceLeaseRecord,
} from '../lease/device-lease.js';

export type VideoDeviceLeaseRecord = DeviceLeaseRecord;
export type VideoDeviceLease = DeviceLease<VideoDeviceLeaseRecord>;
export type VideoDeviceLeaseManagerOptions = DeviceLeaseManagerOptions;

const localLeases = new Set<string>();

export class VideoDeviceLeaseManager extends DeviceLeaseManager {
  constructor(options: VideoDeviceLeaseManagerOptions = {}) {
    super('video', pathResolver.shared('runtime/video-leases'), localLeases, options);
  }
}
