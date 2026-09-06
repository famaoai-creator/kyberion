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
  d?: {
    requestId?: string;
    requestStatus?: { result: boolean; code?: number; comment?: string };
    responseData?: Record<string, unknown>;
  };
}

function v5Auth(password: string, challenge: string, salt: string): string {
  const sha256 = (value: string): string => createHash('sha256').update(value).digest('base64');
  return sha256(sha256(password + salt) + challenge);
}

async function defaultConnect(url: string, timeoutMs: number): Promise<BufferedSocket> {
  const { default: WebSocket } = (await import('ws')) as unknown as {
    default: new (url: string) => ObsSocket & {
      readyState: number;
      once(event: string, cb: (...args: unknown[]) => void): void;
    };
  };
  return new Promise<BufferedSocket>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`OBS connect timed out: ${url}`)), timeoutMs);
    let settled = false;
    const socket = new WebSocket(url) as ObsSocket & {
      once(event: string, cb: (...args: unknown[]) => void): void;
    };
    const buffered = bufferSocketMessages(socket);
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
    const response = await new Promise<ObsResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`OBS request timed out: ${requestType}`)),
        this.timeoutMs
      );
      let unsubscribe: () => void = () => undefined;
      const onMessage = (raw: unknown): void => {
        const text = typeof raw === 'string' ? raw : String((raw as { toString?: unknown }) ?? '');
        let parsed: ObsResponse;
        try {
          parsed = JSON.parse(text) as ObsResponse;
        } catch {
          return;
        }
        if (parsed.d?.requestId !== requestId) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(parsed);
      };
      unsubscribe = socket.subscribeMessages(onMessage);
      socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
    const status = response.d?.requestStatus;
    if (!status?.result) {
      throw new Error(
        `OBS ${requestType} failed: ${status?.comment || `code ${status?.code ?? '?'}`}`
      );
    }
    return response.d?.responseData ?? {};
  }

  private waitHello(socket: BufferedSocket): Promise<{ challenge?: string; salt?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OBS hello timed out')), this.timeoutMs);
      let unsubscribe: () => void = () => undefined;
      const onMessage = (raw: unknown): void => {
        const text = typeof raw === 'string' ? raw : String((raw as { toString?: unknown }) ?? '');
        let parsed: { op?: number; d?: { authentication?: { challenge: string; salt: string } } };
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        if (parsed.op !== 0) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(parsed.d?.authentication ?? {});
      };
      unsubscribe = socket.subscribeMessages(onMessage);
      socket.on('error', (err: unknown) => {
        clearTimeout(timer);
        unsubscribe();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
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
      const { challenge, salt } = await this.waitHello(socket);
      const identify: Record<string, unknown> = { rpcVersion: 1 };
      if (challenge && salt) {
        const password = String(this.options.password || '').trim();
        if (!password) {
          throw new Error(
            'OBS requires a WebSocket password: set KYBERION_OBS_WS_PASSWORD (same value as OBS Settings → General → WebSocket Server → Server Password).'
          );
        }
        identify.authentication = v5Auth(password, challenge, salt);
      }
      socket.send(JSON.stringify({ op: 1, d: identify }));
      // The server answers Identify with Identified (op 2); requests below
      // would fail fast if authentication was rejected.

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
      const { challenge, salt } = await this.waitHello(socket);
      const identify: Record<string, unknown> = { rpcVersion: 1 };
      if (challenge && salt) {
        const password = String(this.options.password || '').trim();
        if (!password)
          throw new Error('OBS requires a WebSocket password: set KYBERION_OBS_WS_PASSWORD.');
        identify.authentication = v5Auth(password, challenge, salt);
      }
      socket.send(JSON.stringify({ op: 1, d: identify }));
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

  startAvatarOutput(input: AvatarOutputRequest): Promise<AvatarOutputResult> {
    return this.clientWithTimeout(10_000).startAvatarOutput({
      videoPath: input.videoPath,
      ...(input.sceneName ? { sceneName: input.sceneName } : {}),
      ...(input.sourceName ? { sourceName: input.sourceName } : {}),
      ...(input.loop !== undefined ? { loop: input.loop } : {}),
    });
  }

  stopAvatarOutput(): Promise<void> {
    return this.clientWithTimeout(10_000)
      .stopAvatarOutput()
      .then(() => undefined);
  }
}

export function installObsVirtualCameraOutputBridge(
  options: ObsVirtualCameraBridgeOptions = {}
): () => void {
  return registerCameraOutputBridge(new ObsVirtualCameraOutputBridge(options));
}
