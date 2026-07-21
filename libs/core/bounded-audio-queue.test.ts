import { describe, expect, it } from 'vitest';
import { BoundedAudioQueue } from './bounded-audio-queue.js';
import type { AudioChunk } from './meeting-session-types.js';

const format = {
  encoding: 'pcm_s16le' as const,
  sample_rate_hz: 16_000 as const,
  channels: 1 as const,
};
const chunk = (ts_ms: number): AudioChunk => ({
  format,
  payload: new Uint8Array(640),
  ts_ms,
});

describe('BoundedAudioQueue', () => {
  it('drops oldest chunks and records backpressure metrics', () => {
    const queue = new BoundedAudioQueue({
      max_chunks: 2,
      max_buffer_ms: 100,
      overflow: 'drop_oldest',
    });
    queue.push(chunk(0));
    queue.push(chunk(40));
    queue.push(chunk(80));
    expect(queue.metrics().dropped_chunks).toBe(1);
    expect(queue.metrics().depth).toBe(2);
  });

  it('does not retain unbounded audio when dropping newest', () => {
    const queue = new BoundedAudioQueue({
      max_chunks: 1,
      max_buffer_ms: 100,
      overflow: 'drop_newest',
    });
    expect(queue.push(chunk(0))).toBe(true);
    expect(queue.push(chunk(40))).toBe(false);
    expect(queue.metrics().depth).toBe(1);
    expect(queue.metrics().dropped_chunks).toBe(1);
  });

  it('fails consumers when overflow policy is fail', async () => {
    const queue = new BoundedAudioQueue({ max_chunks: 1, max_buffer_ms: 100, overflow: 'fail' });
    queue.push(chunk(0));
    queue.push(chunk(40));
    await expect(queue.next()).rejects.toThrow('audio queue overflow');
  });
});
