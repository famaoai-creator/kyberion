import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  assertSafeRepositoryPath,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { nowIso } from '../foundation/time.js';
import type { VideoFrame } from '../meeting/meeting-session-types.js';
import type { VideoFrameBus } from '../video/video-frame-bus.js';
import { platform } from '../platform.js';
import { takeScreenshot } from './os-automation.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from '../seam.js';

export const SCREEN_CAPTURE_BRIDGE_ID = 'screen-capture-bridge' as const;

export type ScreenCaptureBackendId = string;

export interface ScreenCaptureBackendInput {
  output_path: string;
  display_index?: number;
  capture_mode: ScreenCaptureRequest['capture_mode'];
}

export interface ScreenCaptureBackendAdapter {
  readonly backend_id: string;
  readonly platforms: readonly string[];
  readonly priority?: number;
  supports?(input: ScreenCaptureBackendInput): boolean;
  probe():
    Promise<{ available: boolean; reason?: string }> | { available: boolean; reason?: string };
  capture(input: ScreenCaptureBackendInput): Promise<void> | void;
}

const screenCaptureBackendSeam = createSeam<ScreenCaptureBackendAdapter>({
  key: 'screen.capture-backend',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});

export function registerScreenCaptureBackend(
  adapter: ScreenCaptureBackendAdapter,
  metadata: SeamProviderMetadata = {
    provenance: 'plugin',
    source: 'screen-capture-backend-extension',
  }
): () => void {
  if (!adapter || !/^[a-z][a-z0-9._-]*$/u.test(adapter.backend_id)) {
    throw new Error('screen-capture-bridge — invalid backend adapter id');
  }
  if (!Array.isArray(adapter.platforms) || adapter.platforms.length === 0) {
    throw new Error(
      'screen-capture-bridge — backend ' + adapter.backend_id + ' must declare platforms'
    );
  }
  if (typeof adapter.probe !== 'function' || typeof adapter.capture !== 'function') {
    throw new Error(
      'screen-capture-bridge — backend ' +
        adapter.backend_id +
        ' must implement probe() and capture()'
    );
  }
  return screenCaptureBackendSeam.register(adapter.backend_id, adapter, metadata);
}

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
  preferred_backend?: string;
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
  'base64'
);

function defaultOutputPath(ext = '.png'): string {
  const stamp = nowIso().replace(/[:.]/g, '-');
  return path.join(DEFAULT_OUTPUT_DIR, `screen-${stamp}${ext}`);
}

function normalizeCaptureMode(value: unknown): ScreenCaptureRequest['capture_mode'] {
  return value === 'focused_window' ? 'focused_window' : 'screen';
}

function normalizeDisplayIndex(value: unknown): number | undefined {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

function detectImageMimeType(
  payload: Uint8Array,
  fallbackPath: string
): VideoFrame['format']['mime_type'] {
  if (
    payload.byteLength >= 8 &&
    payload[0] === 0x89 &&
    payload[1] === 0x50 &&
    payload[2] === 0x4e &&
    payload[3] === 0x47 &&
    payload[4] === 0x0d &&
    payload[5] === 0x0a &&
    payload[6] === 0x1a &&
    payload[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    payload.byteLength >= 3 &&
    payload[0] === 0xff &&
    payload[1] === 0xd8 &&
    payload[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  return /\.png$/i.test(fallbackPath) ? 'image/png' : 'image/jpeg';
}

async function captureViaPlatform(
  outputPath: string,
  mode: ScreenCaptureRequest['capture_mode']
): Promise<void> {
  if (mode === 'focused_window') {
    await platform.captureFocusedWindow(outputPath);
    return;
  }
  await platform.captureScreen(outputPath);
}

let screenCaptureBuiltinsRegistered = false;

function ensureScreenCaptureBuiltins(): void {
  if (screenCaptureBuiltinsRegistered) return;
  registerScreenCaptureBackend(
    {
      backend_id: 'platform',
      platforms: ['*'],
      priority: 100,
      async probe() {
        const capabilities = await platform.getCapabilities();
        return capabilities.hasScreenCapture
          ? { available: true }
          : {
              available: false,
              reason: 'screen capture unavailable on this host',
            };
      },
      capture: (input) => captureViaPlatform(input.output_path, input.capture_mode),
    },
    { provenance: 'builtin', source: 'screen-capture-bridge' }
  );
  registerScreenCaptureBackend(
    {
      backend_id: 'os-automation',
      platforms: ['darwin'],
      priority: 200,
      supports: (input) =>
        typeof input.display_index === 'number' && input.capture_mode !== 'focused_window',
      probe: () => ({ available: true }),
      capture: (input) => {
        takeScreenshot(input.output_path, {
          displayIndex: input.display_index!,
        });
      },
    },
    { provenance: 'builtin', source: 'screen-capture-bridge' }
  );
  registerScreenCaptureBackend(
    {
      backend_id: 'stub',
      platforms: ['*'],
      priority: -1000,
      probe: () => ({ available: true }),
      capture: (input) => {
        safeWriteFile(input.output_path, PLACEHOLDER_PNG);
      },
    },
    { provenance: 'builtin', source: 'screen-capture-bridge' }
  );
  screenCaptureBuiltinsRegistered = true;
}

ensureScreenCaptureBuiltins();

function listScreenCaptureBackends(): ScreenCaptureBackendAdapter[] {
  ensureScreenCaptureBuiltins();
  return screenCaptureBackendSeam.list().map((entry) => entry.implementation);
}

async function resolveScreenCaptureBackend(
  preferredBackend: string | undefined,
  input: ScreenCaptureBackendInput
): Promise<{
  backend: ScreenCaptureBackendAdapter;
  available: boolean;
  reason?: string;
}> {
  const backends = listScreenCaptureBackends();
  if (preferredBackend) {
    const backend = backends.find((entry) => entry.backend_id === preferredBackend);
    if (!backend)
      return {
        backend: backends.find((entry) => entry.backend_id === 'stub')!,
        available: false,
        reason: 'unknown screen capture backend: ' + preferredBackend,
      };
    if (!(backend.platforms.includes('*') || backend.platforms.includes(process.platform))) {
      return {
        backend,
        available: false,
        reason:
          'screen capture backend ' + preferredBackend + ' is unsupported on ' + process.platform,
      };
    }
    if (backend.supports && !backend.supports(input)) {
      return {
        backend,
        available: false,
        reason:
          'screen capture backend ' +
          preferredBackend +
          ' does not support the requested capture mode',
      };
    }
    const probe = await backend.probe();
    return { backend, ...probe };
  }
  const candidates = backends
    .filter((entry) => entry.backend_id !== 'stub')
    .filter((entry) => entry.platforms.includes('*') || entry.platforms.includes(process.platform))
    .filter((entry) => !entry.supports || entry.supports(input))
    .sort(
      (left, right) =>
        (right.priority ?? 0) - (left.priority ?? 0) ||
        left.backend_id.localeCompare(right.backend_id)
    );
  let lastReason: string | undefined;
  for (const backend of candidates) {
    const probe = await backend.probe();
    if (probe.available) return { backend, ...probe };
    lastReason = probe.reason ?? lastReason;
  }
  const stub = backends.find((entry) => entry.backend_id === 'stub');
  if (!stub) throw new Error('screen-capture-bridge — built-in stub backend is not registered');
  return {
    backend: stub,
    available: false,
    reason: lastReason ?? 'screen capture unavailable on this host',
  };
}

export class ScreenCaptureBridgeImpl implements ScreenCaptureBridge {
  readonly bridge_id = SCREEN_CAPTURE_BRIDGE_ID;

  constructor(private readonly opts: ScreenCaptureBridgeOptions = {}) {}

  async probe(): Promise<ScreenCaptureBridgeProbe> {
    const selection = await resolveScreenCaptureBackend(this.opts.preferred_backend, {
      output_path: '',
      capture_mode: 'screen',
    });
    return {
      bridge_id: SCREEN_CAPTURE_BRIDGE_ID,
      platform: process.platform,
      backend: selection.backend.backend_id,
      available: selection.available,
      reason: selection.reason,
    };
  }

  async captureScreenshot(input: ScreenCaptureRequest = {}): Promise<ScreenCaptureResult> {
    const savePath = assertSafeRepositoryPath(
      pathResolver.rootResolve(input.save_path ?? defaultOutputPath()),
      { allowMissingLeaf: true }
    );
    const captureMode = normalizeCaptureMode(input.capture_mode);
    const displayIndex = normalizeDisplayIndex(input.display_index);
    const selection = await resolveScreenCaptureBackend(this.opts.preferred_backend, {
      output_path: savePath,
      display_index: displayIndex,
      capture_mode: captureMode,
    });
    if (this.opts.preferred_backend && !selection.available) {
      throw new Error(selection.reason ?? 'requested screen capture backend is unavailable');
    }
    safeMkdir(path.dirname(savePath), { recursive: true });
    await selection.backend.capture({
      output_path: savePath,
      display_index: displayIndex,
      capture_mode: captureMode,
    });

    return {
      bridge_id: SCREEN_CAPTURE_BRIDGE_ID,
      platform: process.platform,
      backend: selection.backend.backend_id,
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
      const tempPath = assertSafeRepositoryPath(
        pathResolver.sharedTmp(
          path.join('screen-stream', `frame-${Date.now()}-${randomUUID()}-${index}.png`)
        ),
        { allowMissingLeaf: true }
      );
      try {
        const result = await this.captureScreenshot({
          save_path: tempPath,
          display_index: input.display_index,
          capture_mode: input.capture_mode,
          subject_hint: input.subject_hint,
        });
        if (!safeLstat(result.save_path).isFile()) {
          throw new Error(
            `[SCREEN_CAPTURE_RESOURCE] captured frame must be a regular file: ${result.save_path}`
          );
        }
        const payload = safeReadFile(result.save_path, { encoding: null });
        const framePayload = Buffer.isBuffer(payload)
          ? new Uint8Array(payload)
          : new Uint8Array(Buffer.from(payload));
        yield {
          format: {
            mime_type: detectImageMimeType(framePayload, result.save_path),
          },
          payload: framePayload,
          ts_ms: index * intervalMs,
        };
      } finally {
        try {
          if (!safeLstat(tempPath).isDirectory()) safeRmSync(tempPath, { force: true });
        } catch {
          // A missing or non-removable frame must not mask the capture result.
        }
      }
      if (index < frameCount - 1 && intervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  }

  async pipeTo(bus: VideoFrameBus, input: ScreenCaptureStreamRequest = {}): Promise<void> {
    await bus.writeFrames(this.captureStream(input));
  }
}

export function createScreenCaptureBridge(
  opts: ScreenCaptureBridgeOptions = {}
): ScreenCaptureBridge {
  return new ScreenCaptureBridgeImpl(opts);
}
