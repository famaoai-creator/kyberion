import { describe, expect, it } from 'vitest';
import { BoundedVideoQueue } from './bounded-video-queue.js';
import type { VideoFrame } from './meeting-session-types.js';

function frame(ts_ms: number, payload: number[] = [1, 2, 3]): VideoFrame {
  return {
    format: { mime_type: 'image/jpeg', width: 640, height: 480 },
    payload: new Uint8Array(payload),
    ts_ms,
  };
}

describe('BoundedVideoQueue', () => {
  it('drops oldest frames on overflow and records metrics', () => {
    const queue = new BoundedVideoQueue({
      max_frames: 2,
      max_buffer_ms: 10_000,
      overflow: 'drop_oldest',
    });
    expect(queue.push(frame(0))).toBe(true);
    expect(queue.push(frame(33))).toBe(true);
    expect(queue.push(frame(66))).toBe(true);
    const metrics = queue.metrics();
    expect(metrics.depth).toBe(2);
    expect(metrics.dropped_frames).toBe(1);
  });

  it('drops newest frames when configured', () => {
    const queue = new BoundedVideoQueue({
      max_frames: 1,
      max_buffer_ms: 10_000,
      overflow: 'drop_newest',
    });
    expect(queue.push(frame(0))).toBe(true);
    expect(queue.push(frame(33))).toBe(false);
    expect(queue.metrics().dropped_frames).toBe(1);
  });

  it('fails the queue on overflow when configured', async () => {
    const queue = new BoundedVideoQueue({ max_frames: 1, max_buffer_ms: 10_000, overflow: 'fail' });
    expect(queue.push(frame(0))).toBe(true);
    expect(() => queue.push(frame(33))).toThrow(/overflow/);
    await expect(queue.next()).rejects.toThrow(/overflow/);
  });
});
