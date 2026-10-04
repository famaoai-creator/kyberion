import * as path from 'node:path';
import { assertSafeRepositoryPath, safeExec, safeMkdir } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { resolveFfmpegBin } from '../tool/tool-binary-resolvers.js';
import type { VideoFrame } from '../meeting/meeting-session-types.js';
import type { VideoFrameBus } from '../video/video-frame-bus.js';
import { readVideoFramesFromMp4, writeVideoFramesToMp4 } from '../video/video-frame-archive.js';
import {
  createVirtualDeviceInventoryBridge,
  type VirtualDeviceInventory,
  type VirtualDeviceInventoryBridge,
} from './virtual-device-inventory-bridge.js';
interface VirtualCameraInjectionBackendDescriptor {
  backend_id: string;
  platforms: string[];
  priority: number;
  requires_device_path: boolean;
  timeout_ms: number;
  command_args: string[];
  host_plan?: { notes?: string[]; camera?: string[] };
}
interface VirtualCameraInjectionBackendRegistry {
  version: string;
  backends: VirtualCameraInjectionBackendDescriptor[];
}
const virtualCameraInjectionBackendCatalog = defineCatalog<VirtualCameraInjectionBackendRegistry>({
  id: 'virtual-camera-injection-backends',
  path: () => pathResolver.knowledge('product/governance/virtual-camera-injection-backends.json'),
  schema: pathResolver.knowledge('product/schemas/virtual-camera-injection-backends.schema.json'),
});

function resolveBackendArguments(
  backend: VirtualCameraInjectionBackendDescriptor,
  values: Record<string, string>
): string[] {
  return backend.command_args.map((argument) =>
    argument.replace(/\{([a-z_]+)\}/gu, (_match, key: string) => {
      const value = values[key];
      if (value === undefined)
        throw new Error('[virtual-camera-injection] unsupported argument placeholder: ' + key);
      return value;
    })
  );
}

export const VIRTUAL_CAMERA_INJECTION_BRIDGE_ID = 'virtual-camera-injection-bridge' as const;

export type VirtualCameraInjectionBackendId = string;
export type VirtualCameraInjectionMode = 'replay' | 'device';
export type VirtualCameraInjectionStatus = 'succeeded' | 'blocked';

export interface VirtualCameraInjectionRequest {
  /** Optional MP4 source to inject. */
  source_path?: string;
  /** Optional virtual camera or device hint. */
  device_preference?: string;
  /** Optional explicit device path, e.g. /dev/video2 on Linux. */
  device_path?: string;
  /** Optional registered native injection backend. */
  backend_id?: string;
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
  backend_id?: string;
}

export interface VirtualCameraInjectionBridge {
  readonly bridge_id: typeof VIRTUAL_CAMERA_INJECTION_BRIDGE_ID;
  probe(): Promise<VirtualCameraInjectionProbe>;
  injectFromMp4(
    inputPath: string,
    request?: VirtualCameraInjectionRequest
  ): Promise<VirtualCameraInjectionResult>;
  injectFrames(
    stream: AsyncIterable<VideoFrame>,
    request?: VirtualCameraInjectionRequest
  ): Promise<VirtualCameraInjectionResult>;
  injectBus(
    bus: VideoFrameBus,
    request?: VirtualCameraInjectionRequest
  ): Promise<VirtualCameraInjectionResult>;
}

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

function pickCamera(
  inventory: VirtualDeviceInventory | undefined,
  preference?: string
): string | undefined {
  const candidates = inventory?.virtual_cameras.length
    ? inventory.virtual_cameras
    : (inventory?.cameras ?? []);
  if (candidates.length === 0) return normalizePreference(preference);
  const normalizedPreference = normalizePreference(preference);
  if (!normalizedPreference) return candidates[0]?.name;
  const lowerPreference = normalizedPreference.toLowerCase();
  const exact = candidates.find(
    (candidate) => candidate.name.trim().toLowerCase() === lowerPreference
  );
  if (exact) return exact.name;
  const contains = candidates.find((candidate) =>
    candidate.name.trim().toLowerCase().includes(lowerPreference)
  );
  if (contains) return contains.name;
  return candidates[0]?.name;
}

function buildHostPlan(
  selectedCamera?: string,
  selectedDevicePath?: string,
  backend?: VirtualCameraInjectionBackendDescriptor
): VirtualCameraInjectionHostPlan {
  const notes = [
    'Runtime can replay frames from mp4, but host-level virtual camera injection requires an OS-specific sink.',
    ...(backend?.host_plan?.notes ?? []),
  ];
  const camera = backend?.host_plan?.camera
    ? [...backend.host_plan.camera]
    : [
        'No native injection backend is configured for the current platform; use the replay output for validation.',
      ];
  if (selectedCamera) notes.push(`Selected camera hint: ${selectedCamera}.`);
  if (selectedDevicePath) notes.push(`Selected device path: ${selectedDevicePath}.`);
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
      request.device_preference ?? this.opts.device_preference
    );
    const selectedDevicePath = normalizePreference(request.device_path ?? this.opts.device_path);
    const ffmpegBin = this.opts.ffmpeg_bin ?? resolveFfmpegBin();
    const requestedBackend = normalizePreference(request.backend_id ?? this.opts.backend_id);
    const registry = virtualCameraInjectionBackendCatalog.load();
    if (
      requestedBackend &&
      !registry.backends.some((backend) => backend.backend_id === requestedBackend)
    )
      throw new Error('Unknown virtual camera injection backend: ' + requestedBackend);
    const candidates = registry.backends
      .filter(
        (backend) =>
          backend.platforms.includes(process.platform) &&
          (!backend.requires_device_path || Boolean(selectedDevicePath))
      )
      .sort(
        (left, right) =>
          right.priority - left.priority || left.backend_id.localeCompare(right.backend_id)
      );
    const candidate = requestedBackend
      ? candidates.find((backend) => backend.backend_id === requestedBackend)
      : candidates[0];
    const ffmpegAvailable = candidate ? isAvailableCommand(ffmpegBin, ['-version']) : false;
    const backend = candidate && ffmpegAvailable ? candidate : undefined;
    const reason = backend
      ? undefined
      : requestedBackend
        ? 'requested backend is unavailable for this platform or required device path'
        : 'no configured native camera backend is available; replay-only backend active';
    return {
      inventory,
      selectedCamera,
      selectedDevicePath,
      backend,
      backendId: backend?.backend_id ?? 'stub',
      available: true,
      reason,
      host_plan: buildHostPlan(selectedCamera, selectedDevicePath, backend),
      ffmpegBin,
    };
  }

  async probe(): Promise<VirtualCameraInjectionProbe> {
    const selection = await this.resolveSelection();
    return {
      bridge_id: VIRTUAL_CAMERA_INJECTION_BRIDGE_ID,
      platform: process.platform,
      backend: selection.backendId,
      available: selection.available,
      reason: selection.reason,
      selected_camera: selection.selectedCamera,
      selected_device_path: selection.selectedDevicePath,
      inventory: selection.inventory,
      host_plan: selection.host_plan,
    };
  }

  async injectFromMp4(
    inputPath: string,
    request: VirtualCameraInjectionRequest = {}
  ): Promise<VirtualCameraInjectionResult> {
    const selection = await this.resolveSelection(request);
    const sourcePath = assertSafeRepositoryPath(pathResolver.rootResolve(inputPath), {
      allowMissingLeaf: true,
    });
    const frameCount = await collectFrameCount(
      readVideoFramesFromMp4(sourcePath, {
        fps: request.fps,
      })
    );

    if (selection.backend) {
      const devicePath = selection.selectedDevicePath;
      if (selection.backend.requires_device_path && !devicePath) {
        return {
          bridge_id: VIRTUAL_CAMERA_INJECTION_BRIDGE_ID,
          platform: process.platform,
          backend: selection.backendId,
          mode: 'device',
          status: 'blocked',
          source_path: sourcePath,
          selected_camera: selection.selectedCamera,
          selected_device_path: devicePath,
          injected_frame_count: frameCount,
          subject_hint: request.subject_hint,
          host_plan: selection.host_plan,
          reason: 'required device path was not selected',
        };
      }
      const args = resolveBackendArguments(selection.backend, {
        source: sourcePath,
        device: devicePath ?? '',
        fps: String(request.fps ?? 30),
      });
      safeExec(selection.ffmpegBin, args, {
        env: process.env,
        timeoutMs: selection.backend.timeout_ms,
      });
      return {
        bridge_id: VIRTUAL_CAMERA_INJECTION_BRIDGE_ID,
        platform: process.platform,
        backend: selection.backendId,
        mode: 'device',
        status: 'succeeded',
        source_path: sourcePath,
        selected_camera: selection.selectedCamera,
        selected_device_path: devicePath,
        injected_frame_count: frameCount,
        subject_hint: request.subject_hint,
        host_plan: selection.host_plan,
      };
    }

    const replayOutputPath = request.output_path
      ? assertSafeRepositoryPath(pathResolver.rootResolve(request.output_path), {
          allowMissingLeaf: true,
        })
      : assertSafeRepositoryPath(
          pathResolver.sharedTmp(
            path.join(
              'camera-injection-replay',
              `${safeSlug(selection.selectedCamera || 'camera')}-${Date.now()}.mp4`
            )
          ),
          { allowMissingLeaf: true }
        );
    safeMkdir(path.dirname(replayOutputPath), { recursive: true });
    const replayResult = await writeVideoFramesToMp4(
      replayOutputPath,
      readVideoFramesFromMp4(sourcePath, { fps: request.fps }),
      { fps: request.fps, cleanup: true }
    );
    return {
      bridge_id: VIRTUAL_CAMERA_INJECTION_BRIDGE_ID,
      platform: process.platform,
      backend: selection.backendId,
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
    request: VirtualCameraInjectionRequest = {}
  ): Promise<VirtualCameraInjectionResult> {
    const tempMp4Path = assertSafeRepositoryPath(
      pathResolver.sharedTmp(
        path.join(
          'camera-injection',
          `${safeSlug(request.subject_hint || request.device_preference || 'stream')}-${Date.now()}.mp4`
        )
      ),
      { allowMissingLeaf: true }
    );
    const archive = await writeVideoFramesToMp4(tempMp4Path, stream, {
      fps: request.fps,
      cleanup: true,
    });
    return this.injectFromMp4(archive.output_path, {
      ...request,
      source_path: archive.output_path,
    });
  }

  async injectBus(
    bus: VideoFrameBus,
    request: VirtualCameraInjectionRequest = {}
  ): Promise<VirtualCameraInjectionResult> {
    return this.injectFrames(bus.frameStream(), request);
  }
}

export function createVirtualCameraInjectionBridge(
  opts: VirtualCameraInjectionBridgeOptions = {}
): VirtualCameraInjectionBridge {
  return new VirtualCameraInjectionBridgeImpl(opts);
}
