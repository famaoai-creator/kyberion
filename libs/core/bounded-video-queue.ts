import type { VideoFrame } from './meeting-session-types.js';
import type { VideoBufferPolicy } from './video-route.js';

export interface BoundedVideoQueueMetrics {
  depth: number;
  buffered_ms: number;
  dropped_frames: number;
  dropped_ms: number;
}

const DEFAULT_FRAME_MS = 33;

function frameDurationMs(frame: VideoFrame, previousTs?: number): number {
  if (previousTs !== undefined) {
    const delta = frame.ts_ms - previousTs;
    if (Number.isFinite(delta) && delta > 0 && delta <= 1000) return Math.round(delta);
  }
  return DEFAULT_FRAME_MS;
}

export class BoundedVideoQueue {
  private readonly queue: Array<{ frame: VideoFrame; durationMs: number }> = [];
  private readonly waiters: Array<{
    resolve: (frame: VideoFrame | null) => void;
    reject: (error: unknown) => void;
  }> = [];
  private bufferedMs = 0;
  private droppedFrames = 0;
  private droppedMs = 0;
  private closed = false;
  private failure: Error | null = null;
  private lastTs: number | undefined;

  constructor(private readonly policy: VideoBufferPolicy) {
    if (!Number.isInteger(policy.max_frames) || policy.max_frames < 1) {
      throw new Error('VideoBufferPolicy.max_frames must be a positive integer');
    }
    if (!Number.isFinite(policy.max_buffer_ms) || policy.max_buffer_ms <= 0) {
      throw new Error('VideoBufferPolicy.max_buffer_ms must be positive');
    }
  }

  push(frame: VideoFrame): boolean {
    if (this.closed) return false;
    const durationMs = frameDurationMs(frame, this.lastTs);
    if (this.waiters.length > 0) {
      this.waiters.shift()!.resolve(frame);
      this.lastTs = frame.ts_ms;
      return true;
    }

    const wouldOverflow = (): boolean =>
      this.queue.length >= this.policy.max_frames ||
      this.bufferedMs + durationMs > this.policy.max_buffer_ms;
    if (!wouldOverflow()) {
      this.queue.push({ frame, durationMs });
      this.bufferedMs += durationMs;
      this.lastTs = frame.ts_ms;
      return true;
    }

    if (this.policy.overflow === 'drop_newest') {
      this.recordDrop(durationMs);
      return false;
    }
    if (this.policy.overflow === 'fail') {
      const error = new Error('video queue overflow');
      this.failure = error;
      this.close(error);
      throw error;
    }

    while (this.queue.length > 0 && wouldOverflow()) {
      const removed = this.queue.shift()!;
      this.bufferedMs -= removed.durationMs;
      this.recordDrop(removed.durationMs);
    }
    if (wouldOverflow()) {
      this.recordDrop(durationMs);
      return false;
    }
    this.queue.push({ frame, durationMs });
    this.bufferedMs += durationMs;
    this.lastTs = frame.ts_ms;
    return true;
  }

  async next(): Promise<VideoFrame | null> {
    if (this.failure) throw this.failure;
    if (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.bufferedMs -= entry.durationMs;
      return entry.frame;
    }
    if (this.closed) return null;
    return new Promise<VideoFrame | null>((resolve, reject) =>
      this.waiters.push({ resolve, reject })
    );
  }

  close(error?: Error): void {
    if (error) this.failure = error;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (this.failure) waiter.reject(this.failure);
      else waiter.resolve(null);
    }
  }

  metrics(): BoundedVideoQueueMetrics {
    return {
      depth: this.queue.length,
      buffered_ms: this.bufferedMs,
      dropped_frames: this.droppedFrames,
      dropped_ms: this.droppedMs,
    };
  }

  private recordDrop(durationMs: number): void {
    this.droppedFrames += 1;
    this.droppedMs += durationMs;
  }
}

export const DEFAULT_VIDEO_BUFFER_POLICY: VideoBufferPolicy = {
  max_frames: 90,
  max_buffer_ms: 3000,
  overflow: 'drop_oldest',
};
