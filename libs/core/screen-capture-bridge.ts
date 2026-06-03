import * as path from 'node:path';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import type { VideoFrame } from './meeting-session-types.js';
import type { VideoFrameBus } from './video-frame-bus.js';
import { platform } from './platform.js';
import { takeScreenshot } from './os-automation.js';

export const SCREEN_CAPTURE_BRIDGE_ID = 'screen-capture-bridge' as const;

export type ScreenCaptureBackendId = 'stub' | 'platform' | 'os-automation';

export interface ScreenCaptureRequest {
  save_path?: string;
  display_index?: number;
  capture_mode?: 'screen' | 'focused_window';
  subject_hint?: string;
}

export interface ScreenCaptureStreamRequest extends ScreenCaptureRequest {
  max_frames?: number;
  frame_interval_ms?: number;
}

export interface ScreenCaptureBridgeOptions {
  preferred_backend?: ScreenCaptureBackendId;
}

export interface ScreenCaptureBridgeProbe {
  bridge_id: typeof SCREEN_CAPTURE_BRIDGE_ID;
  platform: NodeJS.Platform;
  backend: ScreenCaptureBackendId;
  available: boolean;
  reason?: string;
}

export interface ScreenCaptureResult {
  bridge_id: typeof SCREEN_CAPTURE_BRIDGE_ID;
  platform: NodeJS.Platform;
  backend: ScreenCaptureBackendId;
  save_path: string;
  display_index?: number;
  capture_mode?: ScreenCaptureRequest['capture_mode'];
  subject_hint?: string;
}

export interface ScreenCaptureBridge {
  readonly bridge_id: typeof SCREEN_CAPTURE_BRIDGE_ID;
  probe(): Promise<ScreenCaptureBridgeProbe>;
  captureScreenshot(input?: ScreenCaptureRequest): Promise<ScreenCaptureResult>;
  captureStream(input?: ScreenCaptureStreamRequest): AsyncIterable<VideoFrame>;
  pipeTo(bus: VideoFrameBus, input?: ScreenCaptureStreamRequest): Promise<void>;
}

const DEFAULT_OUTPUT_DIR = path.join('active', 'shared', 'tmp', 'screen-captures');
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7u1WQAAAAASUVORK5CYII=',
  'base64',
);

function defaultOutputPath(ext = '.png'): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(DEFAULT_OUTPUT_DIR, `screen-${stamp}${ext}`);
}

function normalizeCaptureMode(value: unknown): ScreenCaptureRequest['capture_mode'] {
  return value === 'focused_window' ? 'focused_window' : 'screen';
}

function normalizeDisplayIndex(value: unknown): number | undefined {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

function detectImageMimeType(payload: Uint8Array, fallbackPath: string): VideoFrame['format']['mime_type'] {
  if (
    payload.byteLength >= 8
    && payload[0] === 0x89
    && payload[1] === 0x50
    && payload[2] === 0x4E
    && payload[3] === 0x47
    && payload[4] === 0x0D
    && payload[5] === 0x0A
    && payload[6] === 0x1A
    && payload[7] === 0x0A
  ) {
    return 'image/png';
  }
  if (payload.byteLength >= 3 && payload[0] === 0xFF && payload[1] === 0xD8 && payload[2] === 0xFF) {
    return 'image/jpeg';
  }
  return /\.png$/i.test(fallbackPath) ? 'image/png' : 'image/jpeg';
}

async function captureViaPlatform(outputPath: string, mode: ScreenCaptureRequest['capture_mode']): Promise<void> {
  if (mode === 'focused_window') {
    await platform.captureFocusedWindow(outputPath);
    return;
  }
  await platform.captureScreen(outputPath);
}

export class ScreenCaptureBridgeImpl implements ScreenCaptureBridge {
  readonly bridge_id = SCREEN_CAPTURE_BRIDGE_ID;

  constructor(private readonly opts: ScreenCaptureBridgeOptions = {}) {}

  async probe(): Promise<ScreenCaptureBridgeProbe> {
    if (this.opts.preferred_backend === 'stub') {
      return {
        bridge_id: SCREEN_CAPTURE_BRIDGE_ID,
        platform: process.platform,
        backend: 'stub',
        available: true,
      };
    }
    const capabilities = await platform.getCapabilities();
    const available = capabilities.hasScreenCapture;
    return {
      bridge_id: SCREEN_CAPTURE_BRIDGE_ID,
      platform: process.platform,
      backend: this.opts.preferred_backend ?? (capabilities.hasScreenCapture ? 'platform' : 'stub'),
      available,
      reason: available ? undefined : 'screen capture unavailable on this host',
    };
  }

  async captureScreenshot(input: ScreenCaptureRequest = {}): Promise<ScreenCaptureResult> {
    const savePath = path.resolve(input.save_path ?? defaultOutputPath());
    const captureMode = normalizeCaptureMode(input.capture_mode);
    const displayIndex = normalizeDisplayIndex(input.display_index);
    const probe = await this.probe();
    const backend = this.opts.preferred_backend ?? probe.backend;
    const runtimeBackend: ScreenCaptureBackendId =
      backend === 'stub'
        ? 'stub'
        : (process.platform === 'darwin' && typeof displayIndex === 'number' && captureMode !== 'focused_window'
          ? 'os-automation'
          : 'platform');
    safeMkdir(path.dirname(savePath), { recursive: true });

    if (backend === 'stub') {
      safeWriteFile(savePath, PLACEHOLDER_PNG);
      return {
        bridge_id: SCREEN_CAPTURE_BRIDGE_ID,
        platform: process.platform,
        backend,
        save_path: savePath,
        display_index: displayIndex,
        capture_mode: captureMode,
        subject_hint: input.subject_hint,
      };
    }

    if (process.platform === 'darwin' && typeof displayIndex === 'number' && captureMode !== 'focused_window') {
      takeScreenshot(savePath, { displayIndex });
    } else {
      await captureViaPlatform(savePath, captureMode);
    }

      return {
        bridge_id: SCREEN_CAPTURE_BRIDGE_ID,
        platform: process.platform,
        backend: runtimeBackend,
        save_path: savePath,
        display_index: displayIndex,
        capture_mode: captureMode,
        subject_hint: input.subject_hint,
    };
  }

  async *captureStream(input: ScreenCaptureStreamRequest = {}): AsyncIterable<VideoFrame> {
    const frameCount = Math.max(1, Number(input.max_frames || 1));
    const intervalMs = Math.max(0, Number(input.frame_interval_ms || 250));
    for (let index = 0; index < frameCount; index += 1) {
      const tempPath = pathResolver.sharedTmp(
        path.join('screen-stream', `frame-${Date.now()}-${index}.png`),
      );
      const result = await this.captureScreenshot({
        save_path: tempPath,
        display_index: input.display_index,
        capture_mode: input.capture_mode,
        subject_hint: input.subject_hint,
      });
      const payload = safeReadFile(result.save_path, { encoding: null });
      const framePayload = Buffer.isBuffer(payload) ? new Uint8Array(payload) : new Uint8Array(Buffer.from(payload));
      yield {
        format: { mime_type: detectImageMimeType(framePayload, result.save_path) },
        payload: framePayload,
        ts_ms: index * intervalMs,
      };
      safeRmSync(result.save_path, { force: true });
      if (index < frameCount - 1 && intervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  }

  async pipeTo(bus: VideoFrameBus, input: ScreenCaptureStreamRequest = {}): Promise<void> {
    await bus.writeFrames(this.captureStream(input));
  }
}

export function createScreenCaptureBridge(opts: ScreenCaptureBridgeOptions = {}): ScreenCaptureBridge {
  return new ScreenCaptureBridgeImpl(opts);
}
