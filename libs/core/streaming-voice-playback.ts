/* eslint-disable no-restricted-imports -- playback requires a killable ffplay child process. */
/**
 * Incremental voice playback for replies whose text arrives after playback
 * has already started. Text segments are synthesized and played in order;
 * an optional PCM stream path can bypass artifact files entirely.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { playAudioFile, type PlaybackHandle, type PlaybackResult } from './audio-playback.js';
import type { AudioChunk } from './meeting-session-types.js';

export type StreamingSynthesizedAudio = string | AsyncIterable<AudioChunk>;

export interface StreamingVoicePlaybackOptions {
  synthesize: (
    segment: string,
    index: number,
    signal?: AbortSignal
  ) => Promise<StreamingSynthesizedAudio>;
  play?: (audioPath: string, index: number) => PlaybackHandle;
  playStream?: (audio: AsyncIterable<AudioChunk>, index: number) => PlaybackHandle;
  onSegmentStart?: (info: { index: number; text: string }) => void;
}

export interface StreamingVoicePlaybackMetrics {
  segments_total: number;
  segments_spoken: number;
  first_audio_ms: number | null;
  total_ms: number;
}

export interface StreamingVoicePlaybackResult {
  completed: boolean;
  interrupted: boolean;
  metrics: StreamingVoicePlaybackMetrics;
  audioPaths: string[];
  error?: string;
}

export interface StreamingVoicePlaybackController {
  readonly signal: AbortSignal;
  push(segment: string): void;
  end(): void;
  done: Promise<StreamingVoicePlaybackResult>;
  stop(): Promise<StreamingVoicePlaybackResult>;
}

export interface StreamingTtsAudioPlaybackOptions {
  voiceProfileId: string;
  synthesizeStream: (
    text: AsyncIterable<string>,
    voiceProfileId: string
  ) => AsyncIterable<AudioChunk>;
  playStream?: (audio: AsyncIterable<AudioChunk>, index: number) => PlaybackHandle;
}

/**
 * Play raw PCM16 chunks through ffplay. This is intentionally opt-in because
 * the normal voice profile path still returns governed artifacts. Engines that
 * expose a PCM stream can use this without materializing a WAV first.
 */
export function playPcmAudioStream(
  audio: AsyncIterable<AudioChunk>,
  options: { command?: string[]; onFirstChunk?: () => void } = {}
): PlaybackHandle {
  let child: ChildProcessWithoutNullStreams | null = null;
  let iterator: AsyncIterator<AudioChunk> | null = null;
  let settled = false;
  let interrupted = false;
  let firstChunk = true;
  let resolveDone: (result: PlaybackResult) => void = () => undefined;
  const done = new Promise<PlaybackResult>((resolve) => {
    resolveDone = resolve;
  });

  const settle = (result: PlaybackResult): void => {
    if (settled) return;
    settled = true;
    resolveDone(result);
  };

  const pump = async (): Promise<void> => {
    try {
      let format: AudioChunk['format'] | undefined;
      iterator = audio[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const chunk = next.value;
        if (interrupted) return;
        format ||= chunk.format;
        if (firstChunk) {
          firstChunk = false;
          options.onFirstChunk?.();
        }
        if (!child) {
          const command = options.command?.length
            ? options.command
            : [
                'ffplay',
                '-nodisp',
                '-autoexit',
                '-loglevel',
                'error',
                '-f',
                's16le',
                '-ar',
                String(format.sample_rate_hz),
                '-ac',
                String(format.channels),
                '-i',
                'pipe:0',
              ];
          child = spawn(command[0], command.slice(1), {
            stdio: ['pipe', 'ignore', 'pipe'],
          });
          child.once('error', (error) => settle({ ok: false, interrupted, error: error.message }));
          child.once('close', (code) => {
            if (interrupted) settle({ ok: true, interrupted: true });
            else
              settle(
                code === 0
                  ? { ok: true, interrupted: false }
                  : { ok: false, interrupted: false, error: `ffplay exited with code ${code}` }
              );
          });
        }
        if (!child.stdin.write(Buffer.from(chunk.payload))) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => {
              child?.stdin.off('error', onError);
              resolve();
            };
            const onError = (error: Error) => {
              child?.stdin.off('drain', onDrain);
              reject(error);
            };
            child?.stdin.once('drain', onDrain);
            child?.stdin.once('error', onError);
          });
        }
      }
      child?.stdin.end();
      if (!child) settle({ ok: true, interrupted: false });
    } catch (error) {
      if (!interrupted)
        settle({
          ok: false,
          interrupted: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  };
  void pump();

  return {
    done,
    stop: async () => {
      interrupted = true;
      try {
        await iterator?.return?.();
        child?.stdin.end();
        child?.kill('SIGTERM');
      } catch {
        /* already stopped */
      }
      if (!child) settle({ ok: true, interrupted: true });
      return done;
    },
  };
}

export function probePcmAudioStreaming(): { available: boolean; reason?: string } {
  const probe = spawnSync('which', ['ffplay'], { stdio: 'ignore' });
  return probe.error || probe.status !== 0
    ? { available: false, reason: 'ffplay is not available on PATH' }
    : { available: true };
}

export function streamVoicePlayback(
  options: StreamingVoicePlaybackOptions
): StreamingVoicePlaybackController {
  const queue: string[] = [];
  let notify: (() => void) | null = null;
  let ended = false;
  let cancelled = false;
  let currentPlayback: PlaybackHandle | null = null;
  let resolveCancellation: (() => void) | null = null;
  const cancellation = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  const abortController = new AbortController();
  const startedAt = Date.now();
  const audioPaths: string[] = [];
  let firstAudioMs: number | null = null;
  let spoken = 0;
  let total = 0;
  let error: string | undefined;

  const waitForSegment = async (): Promise<string | null> => {
    for (;;) {
      if (queue.length) return queue.shift() as string;
      if (ended || cancelled) return null;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  };

  const run = async (): Promise<StreamingVoicePlaybackResult> => {
    try {
      for (let index = 0; ; index += 1) {
        const segment = await Promise.race([waitForSegment(), cancellation.then(() => null)]);
        if (segment === null) break;
        total += 1;
        const audio = await Promise.race([
          options.synthesize(segment, index, abortController.signal),
          cancellation.then(() => null),
        ]);
        if (audio === null || cancelled) break;
        options.onSegmentStart?.({ index, text: segment });
        if (typeof audio === 'string') {
          audioPaths.push(audio);
          currentPlayback = (options.play ?? ((path) => playAudioFile(path)))(audio, index);
        } else {
          currentPlayback = (options.playStream ?? ((stream) => playPcmAudioStream(stream)))(
            audio,
            index
          );
        }
        if (firstAudioMs === null) firstAudioMs = Date.now() - startedAt;
        const result = await currentPlayback.done;
        currentPlayback = null;
        if (!result.ok && !result.interrupted) {
          error = result.error || 'playback failed';
          break;
        }
        spoken += 1;
        if (cancelled || result.interrupted) break;
      }
    } catch (caught) {
      if (!cancelled) error = caught instanceof Error ? caught.message : String(caught);
    }
    return {
      completed: !cancelled && !error && ended && queue.length === 0 && spoken === total,
      interrupted: cancelled,
      metrics: {
        segments_total: total,
        segments_spoken: spoken,
        first_audio_ms: firstAudioMs,
        total_ms: Date.now() - startedAt,
      },
      audioPaths,
      ...(error ? { error } : {}),
    };
  };
  const done = run();

  const wake = (): void => {
    notify?.();
    notify = null;
  };
  return {
    signal: abortController.signal,
    push: (segment) => {
      if (ended || cancelled || !segment.trim()) return;
      queue.push(segment.trim());
      wake();
    },
    end: () => {
      ended = true;
      wake();
    },
    done,
    stop: async () => {
      if (cancelled) return done;
      cancelled = true;
      abortController.abort();
      resolveCancellation?.();
      if (currentPlayback) await currentPlayback.stop();
      return done;
    },
  };
}

/** Connect the existing governed streaming-TTS bridge directly to playback. */
export function streamTtsAudioPlayback(
  options: StreamingTtsAudioPlaybackOptions
): StreamingVoicePlaybackController {
  const queue: string[] = [];
  let notify: (() => void) | null = null;
  let ended = false;
  let cancelled = false;
  let currentPlayback: PlaybackHandle | null = null;
  let resolveCancellation: (() => void) | null = null;
  const cancellation = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  const abortController = new AbortController();
  const startedAt = Date.now();
  let segmentsTotal = 0;
  let firstAudioMs: number | null = null;
  let error: string | undefined;

  const text = (async function* (): AsyncGenerator<string> {
    for (;;) {
      if (queue.length) {
        yield queue.shift() as string;
        continue;
      }
      if (ended || cancelled) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  })();

  const run = async (): Promise<StreamingVoicePlaybackResult> => {
    try {
      const audio = options.synthesizeStream(text, options.voiceProfileId);
      currentPlayback = (
        options.playStream ??
        ((stream) =>
          playPcmAudioStream(stream, {
            onFirstChunk: () => {
              if (firstAudioMs === null) firstAudioMs = Date.now() - startedAt;
            },
          }))
      )(audio, 0);
      const result = await Promise.race([
        currentPlayback.done,
        cancellation.then(() => ({ ok: true, interrupted: true }) as PlaybackResult),
      ]);
      if (firstAudioMs === null && result.ok && !result.interrupted)
        firstAudioMs = Date.now() - startedAt;
      if (!result.ok && !result.interrupted) error = result.error || 'streaming playback failed';
    } catch (caught) {
      if (!cancelled) error = caught instanceof Error ? caught.message : String(caught);
    }
    return {
      completed: !cancelled && !error && ended,
      interrupted: cancelled,
      metrics: {
        segments_total: segmentsTotal,
        segments_spoken: error || cancelled ? 0 : segmentsTotal,
        first_audio_ms: firstAudioMs,
        total_ms: Date.now() - startedAt,
      },
      audioPaths: [],
      ...(error ? { error } : {}),
    };
  };
  const done = run();

  const wake = (): void => {
    notify?.();
    notify = null;
  };
  return {
    signal: abortController.signal,
    push: (segment) => {
      if (ended || cancelled || !segment.trim()) return;
      queue.push(segment.trim());
      segmentsTotal += 1;
      wake();
    },
    end: () => {
      ended = true;
      wake();
    },
    done,
    stop: async () => {
      if (cancelled) return done;
      cancelled = true;
      abortController.abort();
      ended = true;
      wake();
      resolveCancellation?.();
      if (currentPlayback) await currentPlayback.stop();
      return done;
    },
  };
}
