import type { VideoFrame, VideoFormat } from './meeting-session-types.js';
import { BoundedVideoQueue, DEFAULT_VIDEO_BUFFER_POLICY } from './bounded-video-queue.js';
import {
  sameVideoFormat,
  type VideoBufferPolicy,
  type VideoRouteHealth,
  type VideoRouteMetrics,
} from './video-route.js';
import { VideoDeviceLeaseManager, type VideoDeviceLease } from './video-device-lease.js';

export const VIDEO_FRAME_BUS_ID = 'stub' as const;

export type VideoFrameBusId = 'stub' | 'v4l2' | 'obs' | 'replay';

export interface VideoFrameBusProbe {
  bus_id: VideoFrameBusId;
  available: boolean;
  reason?: string;
  format?: VideoFormat;
  buffered_frames?: number;
}

export interface VideoFrameBus {
  readonly bus_id: VideoFrameBusId;
  probe(): Promise<VideoFrameBusProbe>;
  open(format?: VideoFormat): Promise<void>;
  frameStream(): AsyncIterable<VideoFrame>;
  writeFrames(stream: AsyncIterable<VideoFrame>): Promise<void>;
  close(): Promise<void>;
  health(): VideoRouteHealth;
  metrics(): VideoRouteMetrics;
}

export interface StubVideoFrameBusOptions {
  buffer_policy?: VideoBufferPolicy;
  session_id?: string;
  device_uid?: string;
  lease_ttl_ms?: number;
  lease_manager?: VideoDeviceLeaseManager;
}

const DEFAULT_FORMAT: VideoFormat = { mime_type: 'image/jpeg' };

function normalizeFormat(format: VideoFormat): VideoFormat {
  if (format.mime_type !== 'image/jpeg' && format.mime_type !== 'image/png') {
    throw new Error(`[video-frame-bus] unsupported mime_type: ${format.mime_type}`);
  }
  return { ...format };
}

export class StubVideoFrameBus implements VideoFrameBus {
  readonly bus_id: VideoFrameBusId = VIDEO_FRAME_BUS_ID;
  private opened = false;
  private everOpened = false;
  private closed = false;
  private closing = false;
  private format: VideoFormat | null = null;
  private readonly queue: BoundedVideoQueue;
  private status: VideoRouteHealth['status'] = 'closed';
  private reason: string | undefined;
  private lastInputAt: number | undefined;
  private lastOutputAt: number | undefined;
  private readonly metricsValue: VideoRouteMetrics = {
    frames_in: 0,
    frames_out: 0,
    dropped_frames: 0,
    dropped_ms: 0,
    underrun_count: 0,
    scaled: false,
  };
  private readonly leaseManager: VideoDeviceLeaseManager | undefined;
  private readonly sessionId: string;
  private readonly deviceUid: string | undefined;
  private readonly leaseTtlMs: number;
  private leases: VideoDeviceLease[] = [];

  constructor(opts: StubVideoFrameBusOptions = {}) {
    this.queue = new BoundedVideoQueue(opts.buffer_policy ?? DEFAULT_VIDEO_BUFFER_POLICY);
    this.sessionId = opts.session_id ?? `videobus-${process.pid}-${Date.now()}`;
    this.deviceUid = opts.device_uid?.trim() ? opts.device_uid.trim() : undefined;
    this.leaseTtlMs = opts.lease_ttl_ms ?? 30_000;
    this.leaseManager =
      opts.lease_manager ?? (this.deviceUid ? new VideoDeviceLeaseManager() : undefined);
  }

  async probe(): Promise<VideoFrameBusProbe> {
    return {
      bus_id: this.bus_id,
      available: true,
      format: this.format ?? undefined,
      buffered_frames: this.queue.metrics().depth,
    };
  }

  async open(format: VideoFormat = DEFAULT_FORMAT): Promise<void> {
    if (this.opened) {
      if (format && this.format && !sameVideoFormat(format, this.format)) {
        throw new Error('[video-frame-bus] bus already opened with a different format');
      }
      if (!this.format) {
        this.format = normalizeFormat(format);
      }
      return;
    }
    if (this.closed) throw new Error('[video-frame-bus] cannot reopen a closed bus');
    this.format = normalizeFormat(format);
    try {
      if (this.deviceUid && this.leaseManager) {
        this.leases.push(
          this.leaseManager.acquire(this.deviceUid, this.sessionId, this.leaseTtlMs)
        );
      }
    } catch (error) {
      this.releaseLeases();
      throw error;
    }
    this.opened = true;
    this.everOpened = true;
    this.status = 'healthy';
  }

  async *frameStream(): AsyncIterable<VideoFrame> {
    if (this.closed) return;
    if (!this.everOpened) {
      this.ensureOpenedWithDefault();
    }
    // Drain buffered frames even after close(), mirroring the pre-parity
    // replay behavior relied on by injectBus-style consumers.
    while (true) {
      let frame: VideoFrame | null;
      try {
        frame = await this.queue.next();
      } catch (error) {
        this.markDegraded(error instanceof Error ? error.message : String(error));
        throw error;
      }
      if (frame === null) return;
      this.metricsValue.frames_in += 1;
      this.lastInputAt = Date.now();
      yield frame;
    }
  }

  async writeFrames(stream: AsyncIterable<VideoFrame>): Promise<void> {
    for await (const frame of stream) {
      if (this.closing) return;
      if (this.status === 'degraded') {
        throw new Error(
          `[video-frame-bus] bus is degraded${this.reason ? `: ${this.reason}` : ''}`
        );
      }
      this.ensureOpenedWithFormat(frame.format);
      if (!this.format || !sameVideoFormat(frame.format, this.format)) {
        throw new Error('[video-frame-bus] frame format mismatch');
      }
      try {
        for (const lease of this.leases) lease.heartbeat();
        const accepted = this.queue.push(frame);
        if (!accepted) continue;
        this.metricsValue.frames_out += 1;
        this.lastOutputAt = Date.now();
      } catch (error) {
        this.releaseLeases();
        this.markDegraded(error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
  }

  async close(): Promise<void> {
    if (this.closing || this.closed) return;
    try {
      this.closing = true;
      this.queue.close();
      this.status = 'closed';
    } finally {
      this.releaseLeases();
      this.opened = false;
      this.closed = true;
    }
  }

  health(): VideoRouteHealth {
    const queue = this.queue.metrics();
    const alive = this.opened && !this.closing && !this.closed;
    const degraded = this.status === 'degraded';
    return {
      status: this.closed || this.closing ? 'closed' : degraded ? 'degraded' : this.status,
      input_process_alive: alive,
      output_process_alive: alive,
      ...(this.lastInputAt ? { last_input_frame_at_ms: this.lastInputAt } : {}),
      ...(this.lastOutputAt ? { last_output_frame_at_ms: this.lastOutputAt } : {}),
      queue_depth: queue.depth,
      dropped_frames: queue.dropped_frames,
      underrun_count: this.metricsValue.underrun_count,
      device_disconnected: degraded,
      lease_held: this.leases.length > 0 && alive,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }

  metrics(): VideoRouteMetrics {
    const queue = this.queue.metrics();
    return {
      ...this.metricsValue,
      dropped_frames: queue.dropped_frames,
      dropped_ms: queue.dropped_ms,
    };
  }

  private ensureOpenedWithDefault(): void {
    if (this.opened) return;
    if (this.closed) throw new Error('[video-frame-bus] bus is closed');
    // Reader-side auto-open must not lock the negotiated format: the first
    // written frame adopts it (screen/camera stubs emit png or jpeg per
    // backend). Explicit open() remains the strict, audio-parity path.
    if (this.deviceUid && this.leaseManager) {
      this.leases.push(this.leaseManager.acquire(this.deviceUid, this.sessionId, this.leaseTtlMs));
    }
    this.opened = true;
    this.everOpened = true;
    this.status = 'healthy';
  }

  private ensureOpenedWithFormat(format: VideoFormat): void {
    if (!this.opened) {
      if (this.closed) throw new Error('[video-frame-bus] bus is closed');
      this.format = normalizeFormat(format);
      if (this.deviceUid && this.leaseManager) {
        this.leases.push(
          this.leaseManager.acquire(this.deviceUid, this.sessionId, this.leaseTtlMs)
        );
      }
      this.opened = true;
      this.everOpened = true;
      this.status = 'healthy';
      return;
    }
    if (!this.format) {
      this.format = normalizeFormat(format);
    }
  }

  private markDegraded(message: string): void {
    if (this.closing || this.closed) return;
    this.status = 'degraded';
    this.reason = message;
  }

  private releaseLeases(): void {
    for (const lease of this.leases.splice(0)) {
      try {
        lease.release();
      } catch {
        /* release must not mask the original error */
      }
    }
  }
}
