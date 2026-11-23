/**
 * Linux v4l2 virtual-camera backend for the camera-output-bridge seam.
 *
 * The older virtual-camera-injection bridge already owns the governed MP4 to
 * v4l2 path. This adapter exposes that capability through the same seam as
 * OBS, so callers do not need an OS-specific branch or a vendor-specific API.
 */

import { registerCameraOutputBridge } from '@agent/core/camera-output-bridge';
import type {
  AvatarOutputRequest,
  AvatarOutputResult,
  CameraOutputBridge,
  CameraOutputCapabilities,
  CameraOutputProbe,
} from '@agent/core/camera-output-bridge';
import {
  createVirtualCameraInjectionBridge,
  type VirtualCameraInjectionBridge,
} from '@agent/core/virtual/virtual-camera-injection-bridge';
import { safeExec } from '@agent/core/secure-io';
import {
  VideoDeviceLeaseManager,
  type VideoDeviceLease,
} from '@agent/core/video/video-device-lease';
import type { VideoRouteHealth, VideoRouteMetrics } from '@agent/core/video/video-route';

export const V4L2_VIRTUAL_CAMERA_BRIDGE_ID = 'v4l2-virtual-cam' as const;

export interface V4l2VirtualCameraOutputOptions {
  devicePath?: string;
  devicePreference?: string;
  ffmpegBin?: string;
  injectionBridge?: VirtualCameraInjectionBridge;
  session_id?: string;
  lease_ttl_ms?: number;
  lease_manager?: VideoDeviceLeaseManager;
}

export const V4L2_VIRTUAL_CAMERA_CAPABILITIES: CameraOutputCapabilities = {
  virtual_camera: true,
  looping_source: false,
  scene_switching: false,
  local_only: true,
};

function hasFfmpeg(ffmpegBin: string): boolean {
  try {
    safeExec(ffmpegBin, ['-version'], { timeoutMs: 3_000 });
    return true;
  } catch {
    return false;
  }
}

interface V4l2ProbeDetails {
  available: boolean;
  selectedDevicePath?: string;
  reason?: string;
}

export class V4l2VirtualCameraOutputBridge implements CameraOutputBridge {
  readonly bridge_id = V4L2_VIRTUAL_CAMERA_BRIDGE_ID;
  readonly capabilities = V4L2_VIRTUAL_CAMERA_CAPABILITIES;
  private readonly injectionBridge: VirtualCameraInjectionBridge;
  private readonly leaseManager: VideoDeviceLeaseManager;
  private readonly sessionId: string;
  private readonly leaseTtlMs: number;
  private leases: VideoDeviceLease[] = [];
  /** Guards concurrent starts; stop() abandons it without cancelling the call. */
  private activeCall: symbol | null = null;
  private activeResult: AvatarOutputResult | null = null;
  private status: VideoRouteHealth['status'] = 'closed';
  private reason: string | undefined;
  private lastOutputAt: number | undefined;
  private framesOut = 0;

  constructor(private readonly options: V4l2VirtualCameraOutputOptions = {}) {
    this.injectionBridge =
      options.injectionBridge ??
      createVirtualCameraInjectionBridge({
        device_path: options.devicePath,
        device_preference: options.devicePreference,
        ffmpeg_bin: options.ffmpegBin,
      });
    this.leaseManager = options.lease_manager ?? new VideoDeviceLeaseManager();
    this.sessionId = options.session_id ?? `v4l2-${process.pid}-${Date.now()}`;
    this.leaseTtlMs = options.lease_ttl_ms ?? 30_000;
  }

  private async probeDetails(): Promise<V4l2ProbeDetails> {
    if (process.platform !== 'linux') {
      return { available: false, reason: 'v4l2 virtual-camera output requires Linux' };
    }
    const ffmpegBin = this.options.ffmpegBin || 'ffmpeg';
    if (!hasFfmpeg(ffmpegBin)) {
      return { available: false, reason: `${ffmpegBin} is not available` };
    }
    const probe = await this.injectionBridge.probe();
    if (probe.backend !== 'ffmpeg-v4l2' || !probe.selected_device_path) {
      return {
        available: false,
        reason:
          probe.reason ||
          'no writable v4l2 device path selected; configure a v4l2loopback device such as /dev/video2',
      };
    }
    return { available: true, selectedDevicePath: probe.selected_device_path };
  }

  async probe(): Promise<CameraOutputProbe> {
    const details = await this.probeDetails();
    return details.available
      ? { available: true }
      : { available: false, ...(details.reason ? { reason: details.reason } : {}) };
  }

  async startAvatarOutput(input: AvatarOutputRequest): Promise<AvatarOutputResult> {
    if (this.activeCall !== null) {
      throw new Error('v4l2 virtual-camera output is already processing a video');
    }
    if (input.loop) {
      throw new Error(
        'v4l2 virtual-camera output does not support a persistent loop; use OBS for looping sources'
      );
    }
    const callToken = Symbol('v4l2-call');
    this.activeCall = callToken;
    // Leases owned by this call: a mid-flight stop() abandons the call and
    // releases them early; this call's finally must only release what it
    // still owns, never a lease a later start() has since acquired.
    const ownedLeases: VideoDeviceLease[] = [];
    try {
      const probe = await this.probeDetails();
      if (!probe.available) {
        throw new Error(`[v4l2-virtual-camera] not available: ${probe.reason || 'unknown reason'}`);
      }
      const devicePath = probe.selectedDevicePath;
      const deviceUid = devicePath || this.options.devicePath || input.sourceName || 'v4l2';
      const lease = this.leaseManager.acquire(deviceUid, this.sessionId, this.leaseTtlMs);
      ownedLeases.push(lease);
      this.leases.push(lease);
      const result = await this.injectionBridge.injectFromMp4(input.videoPath, {
        device_path: this.options.devicePath || devicePath,
        device_preference: input.sourceName || this.options.devicePreference,
      });
      if (result.status !== 'succeeded') {
        throw new Error(result.reason || 'v4l2 virtual-camera injection was blocked');
      }
      for (const owned of ownedLeases) {
        if (this.leases.includes(owned)) owned.heartbeat();
      }
      const output: AvatarOutputResult = {
        scene: 'v4l2',
        source: result.selected_device_path || this.options.devicePath || 'v4l2',
        virtualCamStarted: true,
      };
      // A call abandoned by a mid-flight stop() must not publish its
      // result into shared health state owned by a later call.
      if (this.activeCall === callToken) {
        this.activeResult = output;
        this.status = 'healthy';
        this.reason = undefined;
        this.framesOut += result.injected_frame_count ?? 0;
        this.lastOutputAt = Date.now();
      }
      return output;
    } catch (error) {
      if (this.activeCall === callToken) {
        this.activeResult = null;
        this.status = 'failed';
        this.reason = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      // injectFromMp4 is a bounded foreground operation; there is no live
      // writer process after it returns, so do not retain the device lease.
      this.releaseLeases(ownedLeases);
      if (this.activeCall === callToken) this.activeCall = null;
    }
  }

  async stopAvatarOutput(): Promise<void> {
    // Bounded foreground ffmpeg injection leaves no persistent process handle,
    // but the device lease must still be released idempotently so a failed or
    // finished injection cannot hold the v4l2 node forever.
    try {
      this.activeCall = null;
      this.activeResult = null;
      this.status = 'closed';
      this.reason = undefined;
    } finally {
      this.releaseLeases();
    }
  }

  health(): VideoRouteHealth {
    return {
      status: this.status,
      input_process_alive: false,
      output_process_alive: this.activeCall !== null,
      ...(this.lastOutputAt ? { last_output_frame_at_ms: this.lastOutputAt } : {}),
      queue_depth: 0,
      dropped_frames: 0,
      underrun_count: 0,
      device_disconnected: this.status === 'failed' || this.status === 'degraded',
      lease_held: this.leases.length > 0 && this.activeCall !== null,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }

  metrics(): VideoRouteMetrics {
    return {
      frames_in: 0,
      frames_out: this.framesOut,
      dropped_frames: 0,
      dropped_ms: 0,
      underrun_count: 0,
      scaled: false,
    };
  }

  private releaseLeases(leases?: VideoDeviceLease[]): void {
    for (const lease of (leases ?? this.leases).slice()) {
      const index = this.leases.indexOf(lease);
      if (index < 0) continue; // already released, e.g. by a mid-flight stop()
      this.leases.splice(index, 1);
      try {
        lease.release();
      } catch {
        /* release must not mask the original error */
      }
    }
  }
}

export function installV4l2VirtualCameraOutputBridge(
  options: V4l2VirtualCameraOutputOptions = {}
): () => void {
  return registerCameraOutputBridge(new V4l2VirtualCameraOutputBridge(options));
}
