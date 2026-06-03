import * as path from 'node:path';
import { safeExec, safeMkdir } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import type { VideoFrame } from './meeting-session-types.js';
import type { VideoFrameBus } from './video-frame-bus.js';
import { readVideoFramesFromMp4, writeVideoFramesToMp4 } from './video-frame-archive.js';
import {
  createVirtualDeviceInventoryBridge,
  type VirtualDeviceInventory,
  type VirtualDeviceInventoryBridge,
} from './virtual-device-inventory-bridge.js';

export const VIRTUAL_CAMERA_INJECTION_BRIDGE_ID = 'virtual-camera-injection-bridge' as const;

export type VirtualCameraInjectionBackendId = 'stub' | 'ffmpeg-v4l2';
export type VirtualCameraInjectionMode = 'replay' | 'device';
export type VirtualCameraInjectionStatus = 'succeeded' | 'blocked';

export interface VirtualCameraInjectionRequest {
  /** Optional MP4 source to inject. */
  source_path?: string;
  /** Optional virtual camera or device hint. */
  device_preference?: string;
  /** Optional explicit device path, e.g. /dev/video2 on Linux. */
  device_path?: string;
  /** Optional MP4 sidecar output for replay artifacts. */
  output_path?: string;
  /** Optional fps hint for archive decode/encode. */
  fps?: number;
  /** Optional label for diagnostics. */
  subject_hint?: string;
}

export interface VirtualCameraInjectionHostPlan {
  notes: string[];
  camera?: string[];
}

export interface VirtualCameraInjectionProbe {
  bridge_id: typeof VIRTUAL_CAMERA_INJECTION_BRIDGE_ID;
  platform: NodeJS.Platform;
  backend: VirtualCameraInjectionBackendId;
  available: boolean;
  reason?: string;
  selected_camera?: string;
  selected_device_path?: string;
  inventory?: VirtualDeviceInventory;
  host_plan?: VirtualCameraInjectionHostPlan;
}

export interface VirtualCameraInjectionResult {
  bridge_id: typeof VIRTUAL_CAMERA_INJECTION_BRIDGE_ID;
  platform: NodeJS.Platform;
  backend: VirtualCameraInjectionBackendId;
  mode: VirtualCameraInjectionMode;
  status: VirtualCameraInjectionStatus;
  source_path?: string;
  output_path?: string;
  selected_camera?: string;
  selected_device_path?: string;
  injected_frame_count?: number;
  subject_hint?: string;
  host_plan?: VirtualCameraInjectionHostPlan;
  reason?: string;
}

export interface VirtualCameraInjectionBridgeOptions {
  inventory_bridge?: VirtualDeviceInventoryBridge;
  ffmpeg_bin?: string;
  device_preference?: string;
  device_path?: string;
}

export interface VirtualCameraInjectionBridge {
  readonly bridge_id: typeof VIRTUAL_CAMERA_INJECTION_BRIDGE_ID;
  probe(): Promise<VirtualCameraInjectionProbe>;
  injectFromMp4(inputPath: string, request?: VirtualCameraInjectionRequest): Promise<VirtualCameraInjectionResult>;
  injectFrames(stream: AsyncIterable<VideoFrame>, request?: VirtualCameraInjectionRequest): Promise<VirtualCameraInjectionResult>;
  injectBus(bus: VideoFrameBus, request?: VirtualCameraInjectionRequest): Promise<VirtualCameraInjectionResult>;
}

const DEFAULT_FFMPEG_BIN = 'ffmpeg';

function normalizePreference(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeSlug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'camera';
}

function isAvailableCommand(command: string, args: string[]): boolean {
  try {
    safeExec(command, args, { env: process.env });
    return true;
  } catch {
    return false;
  }
}

function pickCamera(inventory: VirtualDeviceInventory | undefined, preference?: string): string | undefined {
  const candidates = inventory?.virtual_cameras.length
    ? inventory.virtual_cameras
    : inventory?.cameras ?? [];
  if (candidates.length === 0) return normalizePreference(preference);
  const normalizedPreference = normalizePreference(preference);
  if (!normalizedPreference) return candidates[0]?.name;
  const lowerPreference = normalizedPreference.toLowerCase();
  const exact = candidates.find((candidate) => candidate.name.trim().toLowerCase() === lowerPreference);
  if (exact) return exact.name;
  const contains = candidates.find((candidate) => candidate.name.trim().toLowerCase().includes(lowerPreference));
  if (contains) return contains.name;
  return candidates[0]?.name;
}

function buildHostPlan(platform: NodeJS.Platform, selectedCamera?: string, selectedDevicePath?: string): VirtualCameraInjectionHostPlan {
  const notes = [
    'Runtime can replay frames from mp4, but host-level virtual camera injection requires an OS-specific sink.',
  ];
  const camera: string[] = [];
  if (platform === 'darwin') {
    camera.push(
      'Install or enable a virtual camera sink such as OBS Virtual Camera or another CoreMediaIO-backed device.',
      'Expose a concrete sink that the runtime can target, then select it through the bridge.',
      'Use the replay path for validation when a sink is not yet present.',
    );
  } else if (platform === 'linux') {
    camera.push(
      'Provide a v4l2loopback device path or equivalent writable virtual camera node.',
      'Pass that device path to the bridge so ffmpeg can stream mp4 frames into it.',
      'Confirm the injected device appears in the inventory scan before relying on it in meeting flows.',
    );
  } else {
    camera.push('This platform does not have a native camera injection backend in the runtime bridge.');
  }
  if (selectedCamera) {
    notes.push(`Selected camera hint: ${selectedCamera}.`);
  }
  if (selectedDevicePath) {
    notes.push(`Selected device path: ${selectedDevicePath}.`);
  }
  return { notes, camera };
}

async function collectFrameCount(stream: AsyncIterable<VideoFrame>): Promise<number> {
  let count = 0;
  for await (const _frame of stream) {
    count += 1;
  }
  return count;
}

export class VirtualCameraInjectionBridgeImpl implements VirtualCameraInjectionBridge {
  readonly bridge_id = VIRTUAL_CAMERA_INJECTION_BRIDGE_ID;
  private readonly inventoryBridge: VirtualDeviceInventoryBridge;

  constructor(private readonly opts: VirtualCameraInjectionBridgeOptions = {}) {
    this.inventoryBridge = opts.inventory_bridge ?? createVirtualDeviceInventoryBridge();
  }

  private async resolveSelection(request: VirtualCameraInjectionRequest = {}) {
    const probe = await this.inventoryBridge.probe();
    const inventory = probe.inventory;
    const selectedCamera = pickCamera(
      inventory,
      request.device_preference ?? this.opts.device_preference,
    );
    const selectedDevicePath = normalizePreference(request.device_path ?? this.opts.device_path);
    const ffmpegBin = this.opts.ffmpeg_bin ?? DEFAULT_FFMPEG_BIN;
    const ffmpegAvailable = isAvailableCommand(ffmpegBin, ['-version']);
    const actualDeviceReady =
      process.platform === 'linux'
      && Boolean(selectedDevicePath)
      && ffmpegAvailable;
    const backend: VirtualCameraInjectionBackendId = actualDeviceReady ? 'ffmpeg-v4l2' : 'stub';
    const reason = actualDeviceReady
      ? undefined
      : process.platform === 'linux'
        ? 'no writable v4l2 device path selected; replay-only backend active'
        : 'no native camera injection backend detected; replay-only backend active';
    return {
      inventory,
      selectedCamera,
      selectedDevicePath,
      backend,
      available: true,
      reason,
      host_plan: buildHostPlan(process.platform, selectedCamera, selectedDevicePath),
      ffmpegBin,
    };
  }

  async probe(): Promise<VirtualCameraInjectionProbe> {
    const selection = await this.resolveSelection();
    return {
      bridge_id: VIRTUAL_CAMERA_INJECTION_BRIDGE_ID,
      platform: process.platform,
      backend: selection.backend,
      available: selection.available,
      reason: selection.reason,
      selected_camera: selection.selectedCamera,
      selected_device_path: selection.selectedDevicePath,
      inventory: selection.inventory,
      host_plan: selection.host_plan,
    };
  }

  async injectFromMp4(inputPath: string, request: VirtualCameraInjectionRequest = {}): Promise<VirtualCameraInjectionResult> {
    const selection = await this.resolveSelection(request);
    const sourcePath = pathResolver.rootResolve(inputPath);
    const frameCount = await collectFrameCount(readVideoFramesFromMp4(sourcePath, {
      fps: request.fps,
    }));

    if (request.output_path) {
      safeMkdir(path.dirname(pathResolver.rootResolve(request.output_path)), { recursive: true });
    }

    if (selection.backend === 'ffmpeg-v4l2') {
      const devicePath = selection.selectedDevicePath;
      if (!devicePath) {
        return {
          bridge_id: VIRTUAL_CAMERA_INJECTION_BRIDGE_ID,
          platform: process.platform,
          backend: 'ffmpeg-v4l2',
          mode: 'device',
          status: 'blocked',
          source_path: sourcePath,
          selected_camera: selection.selectedCamera,
          selected_device_path: devicePath,
          injected_frame_count: frameCount,
          subject_hint: request.subject_hint,
          host_plan: selection.host_plan,
          reason: 'no writable v4l2 device path selected',
        };
      }
      safeExec(
        selection.ffmpegBin,
        [
          '-y',
          '-re',
          '-i',
          sourcePath,
          '-vf',
          'format=yuv420p',
          '-f',
          'v4l2',
          devicePath,
        ],
        { env: process.env, timeoutMs: 120_000 },
      );
      return {
        bridge_id: VIRTUAL_CAMERA_INJECTION_BRIDGE_ID,
        platform: process.platform,
        backend: 'ffmpeg-v4l2',
        mode: 'device',
        status: 'succeeded',
        source_path: sourcePath,
        selected_camera: selection.selectedCamera,
        selected_device_path: devicePath,
        injected_frame_count: frameCount,
        subject_hint: request.subject_hint,
      };
    }

    const replayOutputPath = request.output_path
      ? pathResolver.rootResolve(request.output_path)
      : pathResolver.sharedTmp(path.join('camera-injection-replay', `${safeSlug(selection.selectedCamera || 'camera')}-${Date.now()}.mp4`));
    const replayResult = await writeVideoFramesToMp4(
      replayOutputPath,
      readVideoFramesFromMp4(sourcePath, { fps: request.fps }),
      { fps: request.fps, cleanup: true },
    );
    return {
      bridge_id: VIRTUAL_CAMERA_INJECTION_BRIDGE_ID,
      platform: process.platform,
      backend: 'stub',
      mode: 'replay',
      status: 'succeeded',
      source_path: sourcePath,
      output_path: replayResult.output_path,
      selected_camera: selection.selectedCamera,
      selected_device_path: selection.selectedDevicePath,
      injected_frame_count: replayResult.frame_count,
      subject_hint: request.subject_hint,
      host_plan: selection.host_plan,
    };
  }

  async injectFrames(
    stream: AsyncIterable<VideoFrame>,
    request: VirtualCameraInjectionRequest = {},
  ): Promise<VirtualCameraInjectionResult> {
    const tempMp4Path = pathResolver.sharedTmp(
      path.join(
        'camera-injection',
        `${safeSlug(request.subject_hint || request.device_preference || 'stream')}-${Date.now()}.mp4`,
      ),
    );
    const archive = await writeVideoFramesToMp4(tempMp4Path, stream, { fps: request.fps, cleanup: true });
    return this.injectFromMp4(archive.output_path, {
      ...request,
      source_path: archive.output_path,
    });
  }

  async injectBus(bus: VideoFrameBus, request: VirtualCameraInjectionRequest = {}): Promise<VirtualCameraInjectionResult> {
    return this.injectFrames(bus.frameStream(), request);
  }
}

export function createVirtualCameraInjectionBridge(
  opts: VirtualCameraInjectionBridgeOptions = {},
): VirtualCameraInjectionBridge {
  return new VirtualCameraInjectionBridgeImpl(opts);
}
