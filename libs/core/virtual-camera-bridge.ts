import * as path from 'node:path';
import { safeExistsSync, safeMkdir, safeExec, safeWriteFile, safeReadFile, safeRmSync } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import type { VideoFrame } from './meeting-session-types.js';
import type { VideoFrameBus } from './video-frame-bus.js';
import type { VirtualDeviceInventory, VirtualDeviceInventoryBridge } from './virtual-device-inventory-bridge.js';

export const VIRTUAL_CAMERA_BRIDGE_ID = 'virtual-camera-bridge' as const;

export type VirtualCameraBackendId = 'stub' | 'imagesnap' | 'ffmpeg' | 'libcamera-still';
// `swift-avfoundation` is macOS-native AVFoundation capture via the helper script.
export type VirtualCameraBackendIdExtended = VirtualCameraBackendId | 'swift-avfoundation';

export interface VirtualCameraCaptureRequest {
  /** Optional output path; defaults to a governed shared temp path. */
  save_path?: string;
  /** Human-readable camera hint (e.g. rear-camera/front-camera/default). */
  device_preference?: string;
  /** Higher-level intent carried from task-session policy. */
  camera_intent?: 'record' | 'share' | 'reference' | 'ocr_source';
  /** Optional subject hint for trace / audit metadata. */
  subject_hint?: string;
}

export interface VirtualCameraCaptureStreamRequest {
  /** Optional device preference if the caller wants to override the selected camera. */
  device_preference?: string;
  /** How many frames to emit before ending the stream. Defaults to 1. */
  max_frames?: number;
  /** Delay between frames when emitting a stream from still captures. */
  frame_interval_ms?: number;
  camera_intent?: VirtualCameraCaptureRequest['camera_intent'];
  subject_hint?: string;
}

export interface VirtualCameraBridgeOptions {
  preferred_backend?: VirtualCameraBackendIdExtended;
  device_preference?: string;
  imagesnap_bin?: string;
  swift_bin?: string;
  ffmpeg_bin?: string;
  libcamera_still_bin?: string;
  inventory_bridge?: VirtualDeviceInventoryBridge;
}

export interface VirtualCameraBridgeProbe {
  bridge_id: typeof VIRTUAL_CAMERA_BRIDGE_ID;
  platform: NodeJS.Platform;
  backend: VirtualCameraBackendIdExtended;
  available: boolean;
  reason?: string;
  device_preference?: string;
  selected_camera?: string;
  inventory?: VirtualDeviceInventory;
}

export interface VirtualCameraCaptureResult {
  bridge_id: typeof VIRTUAL_CAMERA_BRIDGE_ID;
  platform: NodeJS.Platform;
  backend: VirtualCameraBackendIdExtended;
  save_path: string;
  device_preference?: string;
  selected_camera?: string;
  camera_intent?: VirtualCameraCaptureRequest['camera_intent'];
  subject_hint?: string;
}

export interface VirtualCameraBridge {
  readonly bridge_id: typeof VIRTUAL_CAMERA_BRIDGE_ID;
  probe(): Promise<VirtualCameraBridgeProbe>;
  capturePhoto(input: VirtualCameraCaptureRequest): Promise<VirtualCameraCaptureResult>;
  captureStream(input?: VirtualCameraCaptureStreamRequest): AsyncIterable<VideoFrame>;
  pipeTo(bus: VideoFrameBus, input?: VirtualCameraCaptureStreamRequest): Promise<void>;
}

const DEFAULT_IMAGESNAP_BIN = 'imagesnap';
const DEFAULT_FFMPEG_BIN = 'ffmpeg';
const DEFAULT_LIBCAMERA_STILL_BIN = 'libcamera-still';
const DEFAULT_OUTPUT_DIR = path.join('active', 'shared', 'tmp', 'camera-captures');
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7u1WQAAAAASUVORK5CYII=',
  'base64',
);

function defaultOutputPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(DEFAULT_OUTPUT_DIR, `camera-${stamp}.png`);
}

function normalizeDevicePreference(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function pickCameraPreference(
  inventory: VirtualDeviceInventory | undefined,
  preference?: string,
): string | undefined {
  const candidates = inventory?.cameras ?? [];
  if (candidates.length === 0) return normalizeDevicePreference(preference);
  const normalizedPreference = normalizeDevicePreference(preference);
  if (!normalizedPreference) return candidates[0]?.name;
  const lowerPreference = normalizedPreference.toLowerCase();
  const exactMatch = candidates.find((candidate) => candidate.name.trim().toLowerCase() === lowerPreference);
  if (exactMatch) return exactMatch.name;
  const containsMatch = candidates.find((candidate) => candidate.name.trim().toLowerCase().includes(lowerPreference));
  if (containsMatch) return containsMatch.name;
  return candidates[0]?.name;
}

function isAvailableCommand(command: string, args: string[]): boolean {
  try {
    safeExec(command, args, { env: process.env });
    return true;
  } catch {
    return false;
  }
}

function chooseBackend(input: {
  preferred_backend?: VirtualCameraBackendIdExtended;
  device_preference?: string;
  imagesnap_bin?: string;
  swift_bin?: string;
  ffmpeg_bin?: string;
  libcamera_still_bin?: string;
}): { backend: VirtualCameraBackendIdExtended; available: boolean; reason?: string } {
  const preferred = input.preferred_backend;
  if (preferred && preferred !== 'stub') {
    if (preferred === 'imagesnap') {
      const bin = input.imagesnap_bin ?? DEFAULT_IMAGESNAP_BIN;
      return isAvailableCommand(bin, ['-h'])
        ? { backend: 'imagesnap', available: true }
        : { backend: 'imagesnap', available: false, reason: `${bin} not available` };
    }
    if (preferred === 'ffmpeg') {
      const bin = input.ffmpeg_bin ?? DEFAULT_FFMPEG_BIN;
      return isAvailableCommand(bin, ['-version'])
        ? { backend: 'ffmpeg', available: true }
        : { backend: 'ffmpeg', available: false, reason: `${bin} not available` };
    }
    if (preferred === 'swift-avfoundation') {
      const bin = input.swift_bin ?? 'swift';
      return isAvailableCommand(bin, ['--version'])
        ? { backend: 'swift-avfoundation', available: true }
        : { backend: 'swift-avfoundation', available: false, reason: `${bin} not available` };
    }
    const bin = input.libcamera_still_bin ?? DEFAULT_LIBCAMERA_STILL_BIN;
    return isAvailableCommand(bin, ['--help'])
      ? { backend: 'libcamera-still', available: true }
      : { backend: 'libcamera-still', available: false, reason: `${bin} not available` };
  }
  if (preferred === 'stub') return { backend: 'stub', available: true };

  if (process.platform === 'darwin') {
    const bin = input.imagesnap_bin ?? DEFAULT_IMAGESNAP_BIN;
    if (isAvailableCommand(bin, ['-h'])) return { backend: 'imagesnap', available: true };
    const swiftBin = input.swift_bin ?? 'swift';
    if (isAvailableCommand(swiftBin, ['--version'])) return { backend: 'swift-avfoundation', available: true };
    const ffmpegBin = input.ffmpeg_bin ?? DEFAULT_FFMPEG_BIN;
    if (isAvailableCommand(ffmpegBin, ['-version'])) return { backend: 'ffmpeg', available: true };
  }

  if (process.platform === 'linux') {
    const ffmpegBin = input.ffmpeg_bin ?? DEFAULT_FFMPEG_BIN;
    const libcameraBin = input.libcamera_still_bin ?? DEFAULT_LIBCAMERA_STILL_BIN;
    if (input.device_preference || safeExistsSync('/dev/video0')) {
      if (isAvailableCommand(ffmpegBin, ['-version'])) return { backend: 'ffmpeg', available: true };
    }
    if (isAvailableCommand(libcameraBin, ['--help'])) return { backend: 'libcamera-still', available: true };
    if (isAvailableCommand(ffmpegBin, ['-version'])) return { backend: 'ffmpeg', available: true };
  }

  return { backend: 'stub', available: true, reason: 'no real camera backend detected; using stub' };
}

export class VirtualCameraBridgeImpl implements VirtualCameraBridge {
  readonly bridge_id = VIRTUAL_CAMERA_BRIDGE_ID;

  constructor(private readonly opts: VirtualCameraBridgeOptions = {}) {}

  async probe(): Promise<VirtualCameraBridgeProbe> {
    const inventory = this.opts.inventory_bridge ? (await this.opts.inventory_bridge.probe()).inventory : undefined;
    const selectedCamera = pickCameraPreference(inventory, this.opts.device_preference);
    const choice = chooseBackend({
      preferred_backend: this.opts.preferred_backend,
      device_preference: selectedCamera ?? normalizeDevicePreference(this.opts.device_preference),
      imagesnap_bin: this.opts.imagesnap_bin,
      swift_bin: this.opts.swift_bin,
      ffmpeg_bin: this.opts.ffmpeg_bin,
      libcamera_still_bin: this.opts.libcamera_still_bin,
    });
    return {
      bridge_id: VIRTUAL_CAMERA_BRIDGE_ID,
      platform: process.platform,
      backend: choice.backend,
      available: choice.available,
      reason: choice.reason,
      device_preference: normalizeDevicePreference(this.opts.device_preference),
      selected_camera: selectedCamera,
      inventory,
    };
  }

  async capturePhoto(input: VirtualCameraCaptureRequest): Promise<VirtualCameraCaptureResult> {
    const savePath = path.resolve(input.save_path ?? defaultOutputPath());
    const devicePreference = normalizeDevicePreference(input.device_preference ?? this.opts.device_preference);
    const probe = await this.probe();
    const selectedCamera = probe.selected_camera ?? pickCameraPreference(probe.inventory, devicePreference);
    const chosen = {
      ...probe,
      device_preference: selectedCamera ?? devicePreference,
    };
    if (!chosen.available) {
      throw new Error(`[virtual-camera-bridge] not available: ${chosen.reason || 'unknown reason'}`);
    }

    safeMkdir(path.dirname(savePath), { recursive: true });

    if (chosen.backend === 'stub') {
      safeWriteFile(savePath, PLACEHOLDER_PNG);
      return {
        bridge_id: VIRTUAL_CAMERA_BRIDGE_ID,
        platform: process.platform,
        backend: 'stub',
        save_path: savePath,
        device_preference: devicePreference,
        selected_camera: selectedCamera,
        camera_intent: input.camera_intent,
        subject_hint: input.subject_hint,
      };
    }

    if (chosen.backend === 'imagesnap') {
      const bin = this.opts.imagesnap_bin ?? DEFAULT_IMAGESNAP_BIN;
      const args = selectedCamera ? ['-d', selectedCamera, savePath] : devicePreference ? ['-d', devicePreference, savePath] : [savePath];
      safeExec(bin, args, { env: process.env });
      return {
        bridge_id: VIRTUAL_CAMERA_BRIDGE_ID,
        platform: process.platform,
        backend: 'imagesnap',
        save_path: savePath,
        device_preference: devicePreference,
        selected_camera: selectedCamera,
        camera_intent: input.camera_intent,
        subject_hint: input.subject_hint,
      };
    }

    if (chosen.backend === 'swift-avfoundation') {
      const bin = this.opts.swift_bin ?? 'swift';
      const script = pathResolver.rootResolve('libs/core/virtual-camera-capture.swift');
      const tempCapture = path.resolve(path.dirname(savePath), `${path.basename(savePath, path.extname(savePath))}-${Date.now()}.jpg`);
      const deviceArg = selectedCamera ?? devicePreference;
      const args = [script, '--output', tempCapture];
      if (deviceArg) {
        args.push('--device', deviceArg);
      }
      safeExec(bin, args, { env: process.env, timeoutMs: 120000 });
      if (/\.png$/i.test(savePath)) {
        const sips = 'sips';
        safeExec(sips, ['-s', 'format', 'png', tempCapture, '--out', savePath], { env: process.env });
        safeRmSync(tempCapture, { force: true });
      } else if (tempCapture !== savePath) {
        safeExec('cp', [tempCapture, savePath], { env: process.env });
        safeRmSync(tempCapture, { force: true });
      }
      return {
        bridge_id: VIRTUAL_CAMERA_BRIDGE_ID,
        platform: process.platform,
        backend: 'swift-avfoundation',
        save_path: savePath,
        device_preference: devicePreference,
        selected_camera: selectedCamera,
        camera_intent: input.camera_intent,
        subject_hint: input.subject_hint,
      };
    }

    if (chosen.backend === 'libcamera-still') {
      const bin = this.opts.libcamera_still_bin ?? DEFAULT_LIBCAMERA_STILL_BIN;
      safeExec(bin, ['-n', '-o', savePath], { env: process.env });
      return {
        bridge_id: VIRTUAL_CAMERA_BRIDGE_ID,
        platform: process.platform,
        backend: 'libcamera-still',
        save_path: savePath,
        device_preference: devicePreference,
        selected_camera: selectedCamera,
        camera_intent: input.camera_intent,
        subject_hint: input.subject_hint,
      };
    }

    const bin = this.opts.ffmpeg_bin ?? DEFAULT_FFMPEG_BIN;
    const device = devicePreference && devicePreference.startsWith('/dev/')
      ? devicePreference
      : '/dev/video0';
    safeExec(
      bin,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'video4linux2',
        '-i',
        device,
        '-frames:v',
        '1',
        savePath,
      ],
      { env: process.env },
    );
    return {
      bridge_id: VIRTUAL_CAMERA_BRIDGE_ID,
      platform: process.platform,
      backend: 'ffmpeg',
      save_path: savePath,
      device_preference: devicePreference,
      selected_camera: selectedCamera,
      camera_intent: input.camera_intent,
      subject_hint: input.subject_hint,
    };
  }

  async *captureStream(input: VirtualCameraCaptureStreamRequest = {}): AsyncIterable<VideoFrame> {
    const frameCount = Math.max(1, Number(input.max_frames || 1));
    const intervalMs = Math.max(0, Number(input.frame_interval_ms || 250));
    for (let index = 0; index < frameCount; index += 1) {
      const tempPath = pathResolver.sharedTmp(
        path.join('camera-stream', `frame-${Date.now()}-${index}.jpg`),
      );
      const result = await this.capturePhoto({
        save_path: tempPath,
        device_preference: input.device_preference ?? this.opts.device_preference,
        camera_intent: input.camera_intent,
        subject_hint: input.subject_hint,
      });
      const payload = safeReadFile(result.save_path, { encoding: null });
      const framePayload = Buffer.isBuffer(payload) ? new Uint8Array(payload) : new Uint8Array(Buffer.from(payload));
      yield {
        format: { mime_type: /\.png$/i.test(result.save_path) ? 'image/png' : 'image/jpeg' },
        payload: framePayload,
        ts_ms: index * intervalMs,
      };
      safeRmSync(result.save_path, { force: true });
      if (index < frameCount - 1 && intervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  }

  async pipeTo(bus: VideoFrameBus, input: VirtualCameraCaptureStreamRequest = {}): Promise<void> {
    await bus.writeFrames(this.captureStream(input));
  }
}

export function createVirtualCameraBridge(
  opts: VirtualCameraBridgeOptions = {},
): VirtualCameraBridge {
  return new VirtualCameraBridgeImpl(opts);
}
