import { describe, expect, it } from 'vitest';

import { teeAudio } from './audio-tee.js';
import type { AudioChunk } from './meeting-session-types.js';

function chunk(id: number): AudioChunk {
  return {
    format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
    payload: new Uint8Array([id]),
    ts_ms: id,
  };
}

async function collect(iter: AsyncIterable<AudioChunk>): Promise<number[]> {
  const seen: number[] = [];
  for await (const c of iter) seen.push(c.ts_ms);
  return seen;
}

describe('teeAudio', () => {
  it('delivers every chunk to every consumer', async () => {
    async function* source(): AsyncIterable<AudioChunk> {
      for (let i = 0; i < 5; i++) yield chunk(i);
    }
    const [a, b, c] = teeAudio(source(), 3);
    const [seenA, seenB, seenC] = await Promise.all([collect(a), collect(b), collect(c)]);
    expect(seenA).toEqual([0, 1, 2, 3, 4]);
    expect(seenB).toEqual([0, 1, 2, 3, 4]);
    expect(seenC).toEqual([0, 1, 2, 3, 4]);
  });

  it('ends all consumers when the source fails', async () => {
    async function* source(): AsyncIterable<AudioChunk> {
      yield chunk(0);
      throw new Error('bus died');
    }
    const [a, b] = teeAudio(source(), 2);
    const [seenA, seenB] = await Promise.all([collect(a), collect(b)]);
    expect(seenA).toEqual([0]);
    expect(seenB).toEqual([0]);
  });

  it('rejects a non-positive consumer count', () => {
    async function* source(): AsyncIterable<AudioChunk> {
      /* empty */
    }
    expect(() => teeAudio(source(), 0)).toThrow(/positive integer/);
  });
});
