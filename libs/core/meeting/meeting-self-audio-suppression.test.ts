import { describe, expect, it, vi } from 'vitest';
import { filterSelfAudioFromMeetingInput } from './meeting-participation-coordinator.js';
import type { AudioChunk } from './meeting-session-types.js';

const chunk: AudioChunk = {
  format: { encoding: 'pcm_s16le', sample_rate_hz: 16_000, channels: 1 },
  payload: new Uint8Array(640),
  ts_ms: 0,
};

async function collect(source: AsyncIterable<AudioChunk>): Promise<AudioChunk[]> {
  const result: AudioChunk[] = [];
  for await (const item of source) result.push(item);
  return result;
}

describe('meeting self-audio suppression', () => {
  it('does not forward BlackHole return audio while speaking or during drain', async () => {
    vi.useFakeTimers();
    let speaking = true;
    let drainUntil = Date.now() + 1000;
    let suppressed = 0;
    const source = (async function* () {
      yield chunk;
      speaking = false;
      yield chunk;
      drainUntil = Date.now() - 1;
      yield chunk;
    })();
    const forwarded = await collect(
      filterSelfAudioFromMeetingInput(
        source,
        () => speaking,
        () => drainUntil,
        () => {
          suppressed += 1;
        }
      )
    );
    expect(forwarded).toHaveLength(1);
    expect(suppressed).toBe(2);
    vi.useRealTimers();
  });
});
