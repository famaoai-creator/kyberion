/**
 * Linux v4l2 virtual-camera backend for the camera-output-bridge seam.
 *
 * The older virtual-camera-injection bridge already owns the governed MP4 to
 * v4l2 path. This adapter exposes that capability through the same seam as
 * OBS, so callers do not need an OS-specific branch or a vendor-specific API.
 */

import { registerCameraOutputBridge } from './camera-output-bridge.js';
import type {
  AvatarOutputRequest,
  AvatarOutputResult,
  CameraOutputBridge,
  CameraOutputCapabilities,
  CameraOutputProbe,
} from './camera-output-bridge.js';
import {
  createVirtualCameraInjectionBridge,
  type VirtualCameraInjectionBridge,
} from './virtual-camera-injection-bridge.js';
import { safeExec } from './secure-io.js';

export const V4L2_VIRTUAL_CAMERA_BRIDGE_ID = 'v4l2-virtual-cam' as const;

export interface V4l2VirtualCameraOutputOptions {
  devicePath?: string;
  devicePreference?: string;
  ffmpegBin?: string;
  injectionBridge?: VirtualCameraInjectionBridge;
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

export class V4l2VirtualCameraOutputBridge implements CameraOutputBridge {
  readonly bridge_id = V4L2_VIRTUAL_CAMERA_BRIDGE_ID;
  readonly capabilities = V4L2_VIRTUAL_CAMERA_CAPABILITIES;
  private readonly injectionBridge: VirtualCameraInjectionBridge;

  constructor(private readonly options: V4l2VirtualCameraOutputOptions = {}) {
    this.injectionBridge =
      options.injectionBridge ??
      createVirtualCameraInjectionBridge({
        device_path: options.devicePath,
        device_preference: options.devicePreference,
        ffmpeg_bin: options.ffmpegBin,
      });
  }

  async probe(): Promise<CameraOutputProbe> {
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
    return { available: true };
  }

  async startAvatarOutput(input: AvatarOutputRequest): Promise<AvatarOutputResult> {
    if (input.loop) {
      throw new Error(
        'v4l2 virtual-camera output does not support a persistent loop; use OBS for looping sources'
      );
    }
    const result = await this.injectionBridge.injectFromMp4(input.videoPath, {
      device_path: this.options.devicePath,
      device_preference: input.sourceName || this.options.devicePreference,
    });
    if (result.status !== 'succeeded') {
      throw new Error(result.reason || 'v4l2 virtual-camera injection was blocked');
    }
    return {
      scene: 'v4l2',
      source: result.selected_device_path || this.options.devicePath || 'v4l2',
      virtualCamStarted: true,
    };
  }

  async stopAvatarOutput(): Promise<void> {
    // The current ffmpeg injection is a bounded foreground operation. Once it
    // returns, the device is no longer being fed; there is no persistent
    // process handle to terminate here.
  }
}

export function installV4l2VirtualCameraOutputBridge(
  options: V4l2VirtualCameraOutputOptions = {}
): () => void {
  return registerCameraOutputBridge(new V4l2VirtualCameraOutputBridge(options));
}
