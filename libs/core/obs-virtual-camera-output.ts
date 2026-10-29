/**
 * OBS Studio virtual-camera output over obs-websocket v5.
 *
 * Lets a rendered talking-avatar MP4 appear as a real camera
 * ("OBS Virtual Camera") that Meet / Zoom / Teams can select.
 * No new dependencies: uses the `ws` package already in the tree
 * plus node:crypto for the v5 challenge handshake.
 *
 * This file is the `obs-virtual-cam` backend of the
 * `camera-output-bridge` seam: probe-gated, capability-declared,
 * and swappable with other camera solutions. Pure-protocol client —
 * the only IO is the WebSocket itself, so unit tests run it against
 * a fake `ws` server. OBS itself must be installed with the virtual
 * camera started and a server password set; without it every call
 * fails closed with setup guidance instead of hanging.
 */

import { createHash } from 'node:crypto';
import { getRegisteredEnvText } from './foundation/env.js';
import {
  registerCameraOutputBridge,
  type AvatarOutputRequest,
  type AvatarOutputResult,
  type CameraOutputBridge,
  type CameraOutputCapabilities,
  type CameraOutputProbe,
} from './camera-output-bridge.js';
export interface ObsVirtualCameraOptions {
  /** ws:// host. Default 127.0.0.1. */
  host?: string;
  /** obs-websocket port. Default 4455. */
  port?: number;
  /** Server password (KYBERION_OBS_WS_PASSWORD when omitted). */
  password?: string;
  /** Connect + handshake timeout. Default 10s. */
  timeoutMs?: number;
  /**
   * Dependency seam for tests. Must attach its message listener
   * synchronously (buffered) — a late subscriber misses the Hello.
   */
  connect?: (url: string) => Promise<BufferedSocket>;
}

export interface ObsSocket {
  send(data: string): void;
  close(): void;
  on(event: 'message' | 'error' | 'close' | 'open', cb: (arg?: unknown) => void): void;
  off?(event: 'error' | 'close', cb: (arg?: unknown) => void): void;
}

export interface ObsSourceFilter {
  filterName: string;
  filterKind: string;
  filterEnabled: boolean;
  filterIndex: number;
}

interface ObsFilterSettings {
  color_filter_v2: {
    gamma?: number;
    contrast?: number;
    brightness?: number;
    saturation?: number;
    hue_shift?: number;
    opacity?: number;
  };
  chroma_key_filter_v2: {
    key_color_type?: 'green' | 'blue' | 'magenta' | 'custom';
    key_color?: number;
    similarity?: number;
    smoothness?: number;
    spill?: number;
  };
  crop_filter: {
    relative?: boolean;
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
    cx?: number;
    cy?: number;
  };
}

export type ObsSourceFilterRequest = {
  [K in keyof ObsFilterSettings]: {
    sourceName: string;
    filterName: string;
    kind: K;
    settings: ObsFilterSettings[K];
    enabled?: boolean;
  };
}[keyof ObsFilterSettings];

const FILTER_NUMBERS: Record<string, Record<string, readonly [number, number, boolean?]>> = {
  color_filter_v2: {
    gamma: [-3, 3],
    contrast: [-4, 4],
    brightness: [-1, 1],
    saturation: [-1, 5],
    hue_shift: [-180, 180],
    opacity: [0, 1],
  },
  chroma_key_filter_v2: {
    key_color: [0, 0xffffffff, true],
    similarity: [1, 1000, true],
    smoothness: [1, 1000, true],
    spill: [1, 1000, true],
  },
  crop_filter: {
    left: [-8192, 8192, true],
    right: [-8192, 8192, true],
    top: [-8192, 8192, true],
    bottom: [-8192, 8192, true],
    cx: [0, 8192, true],
    cy: [0, 8192, true],
  },
};

function sourceName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 512 ||
    /[\u0000-\u001f]/u.test(value)
  )
    throw new Error('[OBS_FILTER_INVALID] A nonempty source/filter name is required');
  return value;
}

/** Snapshot the exact allowlisted effect before admission or network I/O. */
export function validateObsSourceFilterRequest(
  input: ObsSourceFilterRequest
): ObsSourceFilterRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('[OBS_FILTER_INVALID] Expected a filter request');
  for (const key of Object.keys(input))
    if (!['sourceName', 'filterName', 'kind', 'settings', 'enabled'].includes(key))
      throw new Error(`[OBS_FILTER_INVALID] Unknown request field: ${key}`);
  const limits = Object.hasOwn(FILTER_NUMBERS, input.kind) ? FILTER_NUMBERS[input.kind] : undefined;
  if (!limits) throw new Error('[OBS_FILTER_INVALID] Unsupported filter kind');
  if (!input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings))
    throw new Error('[OBS_FILTER_INVALID] Expected filter settings');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean')
    throw new Error('[OBS_FILTER_INVALID] enabled must be boolean');
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.settings)) {
    const range = Object.hasOwn(limits, key) ? limits[key] : undefined;
    if (range) {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < range[0] ||
        value > range[1] ||
        (range[2] && !Number.isInteger(value))
      )
        throw new Error(`[OBS_FILTER_INVALID] Invalid ${key}`);
    } else if (input.kind === 'chroma_key_filter_v2' && key === 'key_color_type') {
      if (typeof value !== 'string' || !['green', 'blue', 'magenta', 'custom'].includes(value))
        throw new Error('[OBS_FILTER_INVALID] Invalid key_color_type');
    } else if (input.kind === 'crop_filter' && key === 'relative') {
      if (typeof value !== 'boolean')
        throw new Error('[OBS_FILTER_INVALID] relative must be boolean');
    } else throw new Error(`[OBS_FILTER_INVALID] Unsupported setting: ${key}`);
    settings[key] = value;
  }
  return Object.freeze({
    sourceName: sourceName(input.sourceName),
    filterName: sourceName(input.filterName),
    kind: input.kind,
    settings: Object.freeze(settings),
    enabled: input.enabled ?? true,
  }) as ObsSourceFilterRequest;
}

type MessageHandler = (raw: unknown) => void;

/**
 * ws emits buffered frames immediately after `open` — a listener
 * attached one microtask later already misses the Hello. Attach at
 * connect time and replay the backlog to late subscribers.
 */
interface BufferedSocket extends ObsSocket {
  subscribeMessages(handler: MessageHandler): () => void;
}

function bufferSocketMessages(socket: ObsSocket): BufferedSocket {
  const backlog: unknown[] = [];
  const handlers = new Set<MessageHandler>();
  socket.on('message', (raw: unknown) => {
    if (handlers.size === 0) {
      // Only handshake/control responses cross this client, never camera frames.
      if (backlog.length >= 32) backlog.shift();
      backlog.push(raw);
      return;
    }
    for (const handler of [...handlers]) {
      try {
        handler(raw);
      } catch {
        /* subscriber-local failure; keep the channel alive */
      }
    }
  });
  const buffered = socket as BufferedSocket;
  buffered.subscribeMessages = (handler: MessageHandler): (() => void) => {
    for (const raw of backlog.splice(0)) {
      try {
        handler(raw);
      } catch {
        /* noop */
      }
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  };
  return buffered;
}

interface ObsResponse {
  op?: number;
  d?: {
    requestId?: string;
    requestStatus?: { result: boolean; code?: number; comment?: string };
    responseData?: Record<string, unknown>;
  };
}

function v5Auth(password: string, challenge: string, salt: string): string {
  // OBS WebSocket v5 handshake mandates this SHA-256 challenge-response.
  const sha256 = (value: string): string => createHash('sha256').update(value).digest('base64');
  return sha256(sha256(password + salt) + challenge);
}

async function defaultConnect(url: string, timeoutMs: number): Promise<BufferedSocket> {
  const { default: WebSocket } = (await import('ws')) as unknown as {
    default: new (
      url: string,
      options?: { maxPayload: number }
    ) => ObsSocket & {
      readyState: number;
      once(event: string, cb: (...args: unknown[]) => void): void;
    };
  };
  return new Promise<BufferedSocket>((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url, { maxPayload: 1024 * 1024 }) as ObsSocket & {
      once(event: string, cb: (...args: unknown[]) => void): void;
    };
    const buffered = bufferSocketMessages(socket);
    const timer = setTimeout(() => {
      settled = true;
      socket.close();
      reject(new Error(`OBS connect timed out: ${url}`));
    }, timeoutMs);
    socket.once('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(buffered);
    });
    socket.once('error', (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export class ObsVirtualCamera {
  constructor(private readonly options: ObsVirtualCameraOptions = {}) {}

  private get timeoutMs(): number {
    return Math.max(1000, Number(this.options.timeoutMs) || 10_000);
  }

  /** Handshake-only reachability check for probes (no session setup). */
  async checkReachable(): Promise<void> {
    const host = (this.options.host || '127.0.0.1').trim() || '127.0.0.1';
    const port = Number(this.options.port) || 4455;
    const connect = this.options.connect ?? ((url: string) => defaultConnect(url, this.timeoutMs));
    const socket = await connect(`ws://${host}:${port}`).catch((err: unknown) => {
      throw new Error(
        `OBS is not reachable at ws://${host}:${port} (${err instanceof Error ? err.message : String(err)}). Install OBS Studio, enable Settings → General → WebSocket Server, and start the virtual camera.`
      );
    });
    try {
      await this.waitHello(socket);
    } finally {
      try {
        socket.close();
      } catch {
        /* noop */
      }
    }
  }

  private async request(
    socket: BufferedSocket,
    requestType: string,
    requestData?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const requestId = `${requestType}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
    const response = await this.waitMessage<ObsResponse>(
      socket,
      (message) => message.op === 7 && message.d?.requestId === requestId,
      `request: ${requestType}`,
      () => socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }))
    );
    const status = response.d?.requestStatus;
    if (!status?.result) {
      throw new Error(
        `OBS ${requestType} failed: ${status?.comment || `code ${status?.code ?? '?'}`}`
      );
    }
    return response.d?.responseData ?? {};
  }

  private async waitMessage<T>(
    socket: BufferedSocket,
    accepts: (message: T) => boolean,
    label: string,
    send?: () => void
  ): Promise<T> {
    let unsubscribe = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onFailure: (error?: unknown) => void = () => undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        onFailure = () => reject(new Error(`OBS connection closed during ${label}`));
        socket.on('close', onFailure);
        socket.on('error', onFailure);
        timer = setTimeout(() => reject(new Error(`OBS ${label} timed out`)), this.timeoutMs);
        unsubscribe = socket.subscribeMessages((raw) => {
          let message: T;
          try {
            message = JSON.parse(String(raw)) as T;
          } catch {
            return;
          }
          if (message && accepts(message)) resolve(message);
        });
        send?.();
      });
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
      socket.off?.('close', onFailure);
      socket.off?.('error', onFailure);
    }
  }

  private async identify(socket: BufferedSocket): Promise<void> {
    const { challenge, salt } = await this.waitHello(socket);
    const identify: Record<string, unknown> = { rpcVersion: 1, eventSubscriptions: 0 };
    if (challenge && salt) {
      const password = this.options.password;
      if (!password)
        throw new Error('OBS requires a WebSocket password: set KYBERION_OBS_WS_PASSWORD.');
      identify.authentication = v5Auth(password, challenge, salt);
    }
    await this.waitMessage<{ op?: number }>(
      socket,
      (message) => message.op === 2,
      'identify',
      () => socket.send(JSON.stringify({ op: 1, d: identify }))
    );
  }

  private async withIdentifiedSocket<T>(run: (socket: BufferedSocket) => Promise<T>): Promise<T> {
    const host = this.options.host || '127.0.0.1';
    const connect = this.options.connect ?? ((url: string) => defaultConnect(url, this.timeoutMs));
    const socket = await connect(`ws://${host}:${this.options.port || 4455}`);
    try {
      await this.identify(socket);
      return await run(socket);
    } finally {
      socket.close();
    }
  }

  /** Read filter metadata only; arbitrary plugin settings may contain credentials. */
  async listSourceFilters(name: string): Promise<ObsSourceFilter[]> {
    const source = sourceName(name);
    return this.withIdentifiedSocket((socket) => this.readSourceFilters(socket, source));
  }

  private async readSourceFilters(
    socket: BufferedSocket,
    source: string
  ): Promise<ObsSourceFilter[]> {
    const data = await this.request(socket, 'GetSourceFilterList', { sourceName: source });
    if (!Array.isArray(data.filters)) throw new Error('[OBS_FILTER_RESPONSE] Missing filter list');
    return data.filters.map((entry: unknown) => {
      const filter = entry as Partial<ObsSourceFilter> | null;
      if (
        !filter ||
        typeof filter.filterName !== 'string' ||
        typeof filter.filterKind !== 'string' ||
        typeof filter.filterEnabled !== 'boolean' ||
        !Number.isInteger(filter.filterIndex)
      )
        throw new Error('[OBS_FILTER_RESPONSE] Invalid filter metadata');
      return {
        filterName: filter.filterName,
        filterKind: filter.filterKind,
        filterEnabled: filter.filterEnabled,
        filterIndex: filter.filterIndex!,
      };
    });
  }

  /** Configure one existing OBS source; approval belongs to the governed caller. */
  async applySourceFilter(input: ObsSourceFilterRequest): Promise<ObsSourceFilter> {
    const request = validateObsSourceFilterRequest(input);
    return this.withIdentifiedSocket(async (socket) => {
      const filters = await this.readSourceFilters(socket, request.sourceName);
      const existing = filters.find((filter) => filter.filterName === request.filterName);
      if (existing && existing.filterKind !== request.kind)
        throw new Error('[OBS_FILTER_KIND_DRIFT] Existing filter has a different kind');
      // OBS creates enabled filters; never briefly expose an effect requested disabled.
      if (!existing && request.enabled === false)
        throw new Error(
          '[OBS_FILTER_DISABLED_CREATE] Only existing filters can be configured disabled'
        );
      const target = { sourceName: request.sourceName, filterName: request.filterName };
      // Disable before changing settings so a failed disable never exposes a new live effect.
      if (request.enabled === false) {
        await this.request(socket, 'SetSourceFilterEnabled', {
          ...target,
          filterEnabled: false,
        });
      }
      if (existing) {
        await this.request(socket, 'SetSourceFilterSettings', {
          ...target,
          filterSettings: request.settings,
          overlay: true,
        });
      } else {
        await this.request(socket, 'CreateSourceFilter', {
          ...target,
          filterKind: request.kind,
          filterSettings: request.settings,
        });
      }
      if (request.enabled === true) {
        await this.request(socket, 'SetSourceFilterEnabled', {
          ...target,
          filterEnabled: true,
        });
      }
      const actual = await this.request(socket, 'GetSourceFilter', target);
      const settings = actual.filterSettings as Record<string, unknown> | undefined;
      if (
        actual.filterKind !== request.kind ||
        actual.filterEnabled !== request.enabled ||
        !settings ||
        Object.entries(request.settings).some(([key, value]) => settings[key] !== value)
      )
        throw new Error('[OBS_FILTER_UNVERIFIED] OBS did not confirm the requested filter state');
      return {
        filterName: request.filterName,
        filterKind: request.kind,
        filterEnabled: request.enabled!,
        filterIndex: existing?.filterIndex ?? filters.length,
      };
    });
  }

  private waitHello(socket: BufferedSocket): Promise<{ challenge?: string; salt?: string }> {
    return this.waitMessage<{
      op?: number;
      d?: { authentication?: { challenge: string; salt: string } };
    }>(socket, (message) => message.op === 0, 'hello').then(
      (message) => message.d?.authentication ?? {}
    );
  }

  /**
   * Show `videoPath` on the OBS virtual camera: ensure scene + looping
   * ffmpeg media source, switch to it, and start the virtual camera.
   */
  async startAvatarOutput(input: {
    videoPath: string;
    sceneName?: string;
    sourceName?: string;
    loop?: boolean;
  }): Promise<{ scene: string; source: string; virtualCamStarted: boolean }> {
    const host = (this.options.host || '127.0.0.1').trim() || '127.0.0.1';
    const port = Number(this.options.port) || 4455;
    const scene = String(input.sceneName || 'Kyberion Avatar').trim() || 'Kyberion Avatar';
    const source = String(input.sourceName || 'Avatar Video').trim() || 'Avatar Video';
    const connect = this.options.connect ?? ((url: string) => defaultConnect(url, this.timeoutMs));
    const socket = await connect(`ws://${host}:${port}`).catch((err: unknown) => {
      throw new Error(
        `OBS is not reachable at ws://${host}:${port} (${err instanceof Error ? err.message : String(err)}). Install OBS Studio, enable Settings → General → WebSocket Server, and start the virtual camera.`
      );
    });
    try {
      await this.identify(socket);

      const scenes = (await this.request(socket, 'GetSceneList')) as {
        scenes?: Array<{ sceneName?: string }>;
      };
      if (!Array.isArray(scenes.scenes) || !scenes.scenes.some((s) => s.sceneName === scene)) {
        await this.request(socket, 'CreateScene', { sceneName: scene });
      }
      await this.request(socket, 'SetCurrentProgramScene', { sceneName: scene });

      const inputs = (await this.request(socket, 'GetInputList')) as {
        inputs?: Array<{ inputName?: string }>;
      };
      const settings = {
        local_file: input.videoPath,
        loop: input.loop !== false,
        restart_on_activate: true,
      };
      if (Array.isArray(inputs.inputs) && inputs.inputs.some((i) => i.inputName === source)) {
        await this.request(socket, 'SetInputSettings', {
          inputName: source,
          inputSettings: settings,
          overlay: true,
        });
      } else {
        await this.request(socket, 'CreateInput', {
          sceneName: scene,
          inputName: source,
          inputKind: 'ffmpeg_source',
          inputSettings: settings,
          sceneItemEnabled: true,
        });
      }
      await this.request(socket, 'StartVirtualCam');
      return { scene, source, virtualCamStarted: true };
    } finally {
      try {
        socket.close();
      } catch {
        /* noop */
      }
    }
  }

  /** Stop the virtual camera, leaving scenes and sources in place. */
  async stopAvatarOutput(): Promise<{ virtualCamStarted: boolean }> {
    const host = (this.options.host || '127.0.0.1').trim() || '127.0.0.1';
    const port = Number(this.options.port) || 4455;
    const connect = this.options.connect ?? ((url: string) => defaultConnect(url, this.timeoutMs));
    const socket = await connect(`ws://${host}:${port}`);
    try {
      await this.identify(socket);
      await this.request(socket, 'StopVirtualCam');
      return { virtualCamStarted: false };
    } finally {
      try {
        socket.close();
      } catch {
        /* noop */
      }
    }
  }
}

export const OBS_VIRTUAL_CAMERA_BRIDGE_ID = 'obs-virtual-cam' as const;

export const OBS_VIRTUAL_CAMERA_CAPABILITIES: CameraOutputCapabilities = {
  virtual_camera: true,
  looping_source: true,
  scene_switching: true,
  local_only: true,
};

export interface ObsVirtualCameraBridgeOptions extends ObsVirtualCameraOptions {}

/**
 * `camera-output-bridge` seam backend: drives OBS Studio over its
 * WebSocket server. Registered explicitly (never silently) so
 * deployments with other camera solutions (v4l2 loopback, …)
 * resolve those instead.
 */
export class ObsVirtualCameraOutputBridge implements CameraOutputBridge {
  readonly bridge_id = OBS_VIRTUAL_CAMERA_BRIDGE_ID;
  readonly capabilities = OBS_VIRTUAL_CAMERA_CAPABILITIES;
  private started = false;
  private activeResult: AvatarOutputResult | null = null;
  private status: 'healthy' | 'degraded' | 'failed' | 'closed' = 'closed';
  private reason: string | undefined;
  private lastOutputAt: number | undefined;

  constructor(private readonly options: ObsVirtualCameraBridgeOptions = {}) {}

  private clientWithTimeout(timeoutMs: number): ObsVirtualCamera {
    const password =
      String(this.options.password || '').trim() ||
      String(getRegisteredEnvText('KYBERION_OBS_WS_PASSWORD') || '').trim();
    return new ObsVirtualCamera({ ...this.options, timeoutMs, ...(password ? { password } : {}) });
  }

  async probe(): Promise<CameraOutputProbe> {
    try {
      // Handshake-only probe: connect, wait for Hello, close.
      // Full session setup stays in startAvatarOutput.
      await this.clientWithTimeout(3000).checkReachable();
      return { available: true };
    } catch (err) {
      return {
        available: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async startAvatarOutput(input: AvatarOutputRequest): Promise<AvatarOutputResult> {
    if (this.started && this.activeResult) return this.activeResult;
    try {
      const result = await this.clientWithTimeout(10_000).startAvatarOutput({
        videoPath: input.videoPath,
        ...(input.sceneName ? { sceneName: input.sceneName } : {}),
        ...(input.sourceName ? { sourceName: input.sourceName } : {}),
        ...(input.loop !== undefined ? { loop: input.loop } : {}),
      });
      this.activeResult = result;
      this.started = true;
      this.status = 'healthy';
      this.reason = undefined;
      this.lastOutputAt = Date.now();
      return result;
    } catch (error) {
      this.started = false;
      this.activeResult = null;
      this.status = 'failed';
      this.reason = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async stopAvatarOutput(): Promise<void> {
    try {
      await this.clientWithTimeout(10_000).stopAvatarOutput();
      this.started = false;
      this.activeResult = null;
      this.status = 'closed';
      this.reason = undefined;
    } catch (error) {
      this.status = 'failed';
      this.reason = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  health(): import('./video/video-route.js').VideoRouteHealth {
    return {
      status: this.status,
      input_process_alive: false,
      output_process_alive: this.started,
      ...(this.lastOutputAt ? { last_output_frame_at_ms: this.lastOutputAt } : {}),
      queue_depth: 0,
      dropped_frames: 0,
      underrun_count: 0,
      device_disconnected: this.status === 'failed' || this.status === 'degraded',
      lease_held: false,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }

  metrics(): import('./video/video-route.js').VideoRouteMetrics {
    return {
      frames_in: 0,
      // OBS does not expose per-frame counters through this bridge.
      frames_out: 0,
      dropped_frames: 0,
      dropped_ms: 0,
      underrun_count: 0,
      scaled: false,
    };
  }
}

export function installObsVirtualCameraOutputBridge(
  options: ObsVirtualCameraBridgeOptions = {}
): () => void {
  return registerCameraOutputBridge(new ObsVirtualCameraOutputBridge(options));
}
