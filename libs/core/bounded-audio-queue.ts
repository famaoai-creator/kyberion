import type { AudioChunk } from './meeting-session-types.js';
import { chunkDurationMs, type AudioBufferPolicy } from './audio-route.js';

export interface BoundedAudioQueueMetrics {
  depth: number;
  buffered_ms: number;
  dropped_chunks: number;
  dropped_ms: number;
}

export class BoundedAudioQueue {
  private readonly queue: AudioChunk[] = [];
  private readonly waiters: Array<(chunk: AudioChunk | null) => void> = [];
  private bufferedMs = 0;
  private droppedChunks = 0;
  private droppedMs = 0;
  private closed = false;
  private failure: Error | null = null;

  constructor(private readonly policy: AudioBufferPolicy) {
    if (!Number.isInteger(policy.max_chunks) || policy.max_chunks < 1) {
      throw new Error('AudioBufferPolicy.max_chunks must be a positive integer');
    }
    if (!Number.isFinite(policy.max_buffer_ms) || policy.max_buffer_ms <= 0) {
      throw new Error('AudioBufferPolicy.max_buffer_ms must be positive');
    }
  }

  push(chunk: AudioChunk): boolean {
    if (this.closed) return false;
    const durationMs = chunkDurationMs(chunk);
    if (this.waiters.length > 0) {
      this.waiters.shift()!(chunk);
      return true;
    }

    const wouldOverflow = (): boolean =>
      this.queue.length >= this.policy.max_chunks ||
      this.bufferedMs + durationMs > this.policy.max_buffer_ms;
    if (!wouldOverflow()) {
      this.queue.push(chunk);
      this.bufferedMs += durationMs;
      return true;
    }

    if (this.policy.overflow === 'drop_newest') {
      this.recordDrop(durationMs);
      return false;
    }
    if (this.policy.overflow === 'fail') {
      this.failure = new Error('audio queue overflow');
      this.close();
      return false;
    }

    while (this.queue.length > 0 && wouldOverflow()) {
      const removed = this.queue.shift()!;
      this.bufferedMs -= chunkDurationMs(removed);
      this.recordDrop(chunkDurationMs(removed));
    }
    if (wouldOverflow()) {
      this.recordDrop(durationMs);
      return false;
    }
    this.queue.push(chunk);
    this.bufferedMs += durationMs;
    return true;
  }

  async next(): Promise<AudioChunk | null> {
    if (this.failure) throw this.failure;
    if (this.queue.length > 0) {
      const chunk = this.queue.shift()!;
      this.bufferedMs -= chunkDurationMs(chunk);
      return chunk;
    }
    if (this.closed) return null;
    return new Promise<AudioChunk | null>((resolve) => this.waiters.push(resolve));
  }

  close(error?: Error): void {
    if (error) this.failure = error;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()!(null);
  }

  metrics(): BoundedAudioQueueMetrics {
    return {
      depth: this.queue.length,
      buffered_ms: this.bufferedMs,
      dropped_chunks: this.droppedChunks,
      dropped_ms: this.droppedMs,
    };
  }

  private recordDrop(durationMs: number): void {
    this.droppedChunks += 1;
    this.droppedMs += durationMs;
  }
}

export const DEFAULT_AUDIO_BUFFER_POLICY: AudioBufferPolicy = {
  max_chunks: 128,
  max_buffer_ms: 2000,
  overflow: 'drop_oldest',
};
