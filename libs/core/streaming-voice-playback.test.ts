import { describe, expect, it } from 'vitest';

import {
  createPlaybackPauseGate,
  gateAudioStream,
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

  it('pause() holds the next file segment until resume()', async () => {
    const played: string[] = [];
    const controller = streamVoicePlayback({
      synthesize: async (segment) => `/tmp/${segment}.wav`,
      play: (path) => {
        played.push(path);
        return immediateHandle();
      },
    });
    controller.pause?.();
    controller.push('a');
    controller.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(played).toEqual([]);

    controller.resume?.();
    const result = await controller.done;
    expect(result.completed).toBe(true);
    expect(played).toEqual(['/tmp/a.wav']);
  });

  it('stop() releases a paused controller as interrupted', async () => {
    const played: string[] = [];
    const controller = streamVoicePlayback({
      synthesize: async (segment) => `/tmp/${segment}.wav`,
      play: (path) => {
        played.push(path);
        return immediateHandle();
      },
    });
    controller.pause?.();
    controller.push('a');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await controller.stop();
    expect(result.interrupted).toBe(true);
    expect(played).toEqual([]);
  });

  it('falls back to stop-and-replay when pause() reports failure (N4)', async () => {
    const played: string[] = [];
    let stops = 0;
    const controller = streamVoicePlayback({
      synthesize: async (segment) => `/tmp/${segment}.wav`,
      play: (path) => {
        played.push(path);
        if (played.length > 1) return immediateHandle();
        let resolveDone: (r: PlaybackResult) => void = () => undefined;
        const done = new Promise<PlaybackResult>((resolve) => {
          resolveDone = resolve;
        });
        return {
          done,
          // SIGSTOP failed to reach the child; pause() reports it instead of
          // the caller assuming silence.
          pause: () => false,
          stop: async () => {
            stops += 1;
            resolveDone({ ok: true, interrupted: true });
            return done;
          },
        };
      },
    });
    controller.push('a');
    controller.end();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(played).toEqual(['/tmp/a.wav']);

    controller.pause?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stops).toBe(1);

    controller.resume?.();
    const result = await controller.done;
    expect(result.completed).toBe(true);
    expect(played).toEqual(['/tmp/a.wav', '/tmp/a.wav']);
    expect(result.metrics.segments_spoken).toBe(1);
  });

  it('does not stop a handle that simply has no pause() support', async () => {
    const played: string[] = [];
    let stops = 0;
    let resolveDone: (r: PlaybackResult) => void = () => undefined;
    const controller = streamVoicePlayback({
      synthesize: async (segment) => `/tmp/${segment}.wav`,
      play: (path) => {
        played.push(path);
        const done = new Promise<PlaybackResult>((resolve) => {
          resolveDone = resolve;
        });
        return {
          done,
          stop: async () => {
            stops += 1;
            resolveDone({ ok: true, interrupted: true });
            return done;
          },
        };
      },
    });
    controller.push('a');
    controller.end();
    await new Promise((resolve) => setTimeout(resolve, 10));

    controller.pause?.();
    controller.resume?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stops).toBe(0);

    resolveDone({ ok: true, interrupted: false });
    const result = await controller.done;
    expect(result.completed).toBe(true);
    expect(played).toEqual(['/tmp/a.wav']);
  });

  it('pause() buffers PCM chunks of the streaming TTS path until resume()', async () => {
    const played: number[] = [];
    const controller = streamTtsAudioPlayback({
      voiceProfileId: 'voice-profile',
      synthesizeStream: async function* (text) {
        for await (const _segment of text) {
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
    controller.pause?.();
    controller.push('一つ目。');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(played).toEqual([]);

    controller.resume?.();
    controller.end();
    const result = await controller.done;
    expect(result.completed).toBe(true);
    expect(played).toEqual([2]);
  });

  it('falls back to stop-and-restart the streaming TTS path when pause() reports failure (N4)', async () => {
    const played: number[] = [];
    let stops = 0;
    let calls = 0;
    const controller = streamTtsAudioPlayback({
      voiceProfileId: 'voice-profile',
      synthesizeStream: async function* (text) {
        for await (const _segment of text) {
          yield { format, payload: new Uint8Array([1, 2]), ts_ms: 0 };
        }
      },
      playStream: (stream) => {
        calls += 1;
        if (calls === 1) {
          let resolveDone: (r: PlaybackResult) => void = () => undefined;
          const done = new Promise<PlaybackResult>((resolve) => {
            resolveDone = resolve;
          });
          return {
            done,
            // SIGSTOP failed to reach the child; pause() reports it instead
            // of the caller assuming silence.
            pause: () => false,
            stop: async () => {
              stops += 1;
              resolveDone({ ok: true, interrupted: true });
              return done;
            },
          };
        }
        const done = (async () => {
          for await (const chunk of stream) played.push(chunk.payload.byteLength);
          return { ok: true, interrupted: false } as PlaybackResult;
        })();
        return { done, stop: async () => ({ ok: true, interrupted: true }) };
      },
    });

    controller.pause?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stops).toBe(1);
    expect(played).toEqual([]);

    controller.resume?.();
    controller.push('一つ目。');
    controller.end();

    const result = await controller.done;
    expect(result.completed).toBe(true);
    expect(calls).toBe(2);
    expect(played).toEqual([2]);
  });
});

describe('playback pause gate', () => {
  it('holds gated chunks without dropping any', async () => {
    const gate = createPlaybackPauseGate();
    const source = (async function* (): AsyncGenerator<AudioChunk> {
      for (let i = 0; i < 3; i += 1) yield { format, payload: new Uint8Array([i]), ts_ms: i };
    })();
    gate.pause();
    const seen: number[] = [];
    const consumed = (async () => {
      for await (const chunk of gateAudioStream(source, gate)) seen.push(chunk.payload[0]);
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual([]);
    expect(gate.paused).toBe(true);
    gate.resume();
    await consumed;
    expect(seen).toEqual([0, 1, 2]);
  });
});
