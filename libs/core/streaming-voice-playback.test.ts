import { describe, expect, it } from 'vitest';

import {
  streamVoicePlayback,
  streamTtsAudioPlayback,
  type StreamingSynthesizedAudio,
} from './streaming-voice-playback.js';
import type { PlaybackHandle, PlaybackResult } from './audio-playback.js';
import type { AudioChunk } from './meeting-session-types.js';

const format = {
  encoding: 'pcm_s16le' as const,
  sample_rate_hz: 16_000 as const,
  channels: 1 as const,
};

function immediateHandle(): PlaybackHandle {
  const result: PlaybackResult = { ok: true, interrupted: false };
  return { done: Promise.resolve(result), stop: async () => ({ ...result, interrupted: true }) };
}

describe('streamVoicePlayback', () => {
  it('starts playback as text segments arrive and closes after end()', async () => {
    const synthesized: string[] = [];
    const played: string[] = [];
    const controller = streamVoicePlayback({
      synthesize: async (segment) => {
        synthesized.push(segment);
        return `/tmp/${synthesized.length}.wav`;
      },
      play: (path) => {
        played.push(path);
        return immediateHandle();
      },
    });

    controller.push('最初の文です。');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(synthesized).toEqual(['最初の文です。']);
    controller.push('次の文です。');
    controller.end();

    const result = await controller.done;
    expect(result.completed).toBe(true);
    expect(result.metrics.first_audio_ms).not.toBeNull();
    expect(played).toEqual(['/tmp/1.wav', '/tmp/2.wav']);
  });

  it('accepts a direct PCM stream without requiring an artifact path', async () => {
    const played: number[] = [];
    const directAudio: AsyncIterable<AudioChunk> = (async function* () {
      yield { format, payload: new Uint8Array([0, 0]), ts_ms: 0 };
    })();
    const controller = streamVoicePlayback({
      synthesize: async (): Promise<StreamingSynthesizedAudio> => directAudio,
      playStream: (stream) => {
        const done = (async () => {
          for await (const chunk of stream) played.push(chunk.payload.byteLength);
          return { ok: true, interrupted: false } as PlaybackResult;
        })();
        return { done, stop: async () => ({ ok: true, interrupted: true }) };
      },
    });
    controller.push('PCMストリームです。');
    controller.end();

    const result = await controller.done;
    expect(result.completed).toBe(true);
    expect(played).toEqual([2]);
    expect(result.audioPaths).toEqual([]);
  });

  it('connects a streaming TTS bridge directly to PCM playback', async () => {
    const textSegments: string[] = [];
    const played: number[] = [];
    const controller = streamTtsAudioPlayback({
      voiceProfileId: 'voice-profile',
      synthesizeStream: async function* (text, profileId) {
        expect(profileId).toBe('voice-profile');
        for await (const segment of text) {
          textSegments.push(segment);
          yield { format, payload: new Uint8Array([1, 2]), ts_ms: 0 };
        }
      },
      playStream: (stream) => {
        const done = (async () => {
          for await (const chunk of stream) played.push(chunk.payload.byteLength);
          return { ok: true, interrupted: false } as PlaybackResult;
        })();
        return { done, stop: async () => ({ ok: true, interrupted: true }) };
      },
    });
    controller.push('一つ目。');
    controller.push('二つ目。');
    controller.end();

    const result = await controller.done;
    expect(result.completed).toBe(true);
    expect(textSegments).toEqual(['一つ目。', '二つ目。']);
    expect(played).toEqual([2, 2]);
  });
});
