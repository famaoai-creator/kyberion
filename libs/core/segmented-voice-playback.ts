/**
 * Segmented voice playback — sentence-level synthesis pipelined with
 * playback so the assistant starts speaking after the FIRST sentence is
 * ready instead of after the whole reply is synthesized.
 *
 * While segment N plays, segment N+1 synthesizes in the background.
 * The controller is cancellable end-to-end: `stop()` halts the current
 * playback, discards in-flight synthesis results, and prevents further
 * segments from starting — this is the barge-in hook for the realtime
 * voice loop.
 *
 * Synthesis and playback are injected, so the pipeline itself is
 * backend-agnostic and hermetic to test.
 */

import { playAudioFile, type PlaybackHandle } from './audio-playback.js';
import { splitVoiceTextIntoChunks } from './voice-text-chunking.js';
import {
  createPlaybackPauseGate,
  type PausablePlaybackHandle,
} from './streaming-voice-playback.js';

/** Sentence-sized segments: small enough that the first chunk synthesizes fast. */
export const DEFAULT_SPEECH_SEGMENT_CHARS = 160;

export interface SegmentedSpeechOptions {
  text: string;
  /** Max characters per segment (sentence boundaries are preferred). */
  maxSegmentChars?: number;
  /** Synthesize one text segment to an audio file; returns its path. */
  /** The signal is aborted when stop() is called; backends should cancel work promptly. */
  synthesize: (segment: string, index: number, signal?: AbortSignal) => Promise<string>;
  /** Play an audio file; defaults to the platform player. */
  play?: (audioPath: string, index: number) => PlaybackHandle;
  onSegmentStart?: (info: { index: number; total: number; text: string }) => void;
}

export interface SegmentedSpeechMetrics {
  segments_total: number;
  segments_spoken: number;
  /** ms from start until the first audio actually began playing. */
  first_audio_ms: number | null;
  total_ms: number;
}

export interface SegmentedSpeechResult {
  completed: boolean;
  interrupted: boolean;
  metrics: SegmentedSpeechMetrics;
  audioPaths: string[];
  error?: string;
}

export interface SegmentedSpeechController {
  done: Promise<SegmentedSpeechResult>;
  /** Stop speaking now: halts playback and discards pending synthesis. Idempotent. */
  stop(): Promise<SegmentedSpeechResult>;
  /**
   * Silence output now and hold the next segment. A pausable player handle is
   * paused in place; any other player is stopped and its segment is replayed
   * from the start on resume(), so no audio keeps feeding the mic meanwhile.
   */
  pause?(): void;
  resume?(): void;
}

export function speakSegmented(options: SegmentedSpeechOptions): SegmentedSpeechController {
  const segments = splitVoiceTextIntoChunks(
    options.text,
    options.maxSegmentChars ?? DEFAULT_SPEECH_SEGMENT_CHARS
  );
  const play = options.play ?? ((audioPath: string) => playAudioFile(audioPath));

  let cancelled = false;
  let currentPlayback: PlaybackHandle | null = null;
  // Set when pause() stopped a non-pausable segment that must replay on resume.
  let stoppedForPause = false;
  const gate = createPlaybackPauseGate();
  const startedAt = Date.now();
  let firstAudioMs: number | null = null;
  const audioPaths: string[] = [];
  let spoken = 0;
  let error: string | undefined;
  const abortController = new AbortController();
  let resolveCancellation: (() => void) | null = null;
  const cancellation = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });

  type SynthesisResult = { ok: true; path: string } | { ok: false; error: unknown };
  type CancelledResult = { cancelled: true };
  const synthesize = (segment: string, index: number): Promise<SynthesisResult> =>
    Promise.resolve()
      .then(() => options.synthesize(segment, index, abortController.signal))
      .then(
        (path) => ({ ok: true as const, path }),
        (synthesisError) => ({ ok: false as const, error: synthesisError })
      );

  const playSegment = async (audioPath: string, index: number) => {
    stoppedForPause = false;
    currentPlayback = play(audioPath, index);
    if (firstAudioMs === null) firstAudioMs = Date.now() - startedAt;
    const result = await currentPlayback.done;
    currentPlayback = null;
    return result;
  };

  const run = async (): Promise<SegmentedSpeechResult> => {
    try {
      // Prime the pipeline: kick off synthesis of segment 0, then loop —
      // await synth(i), start synth(i+1), play i while i+1 synthesizes.
      let nextSynthesis: Promise<SynthesisResult> | null = segments.length
        ? synthesize(segments[0], 0)
        : null;
      for (let index = 0; index < segments.length; index += 1) {
        const synthesis = await Promise.race<SynthesisResult | CancelledResult>([
          nextSynthesis as Promise<SynthesisResult>,
          cancellation.then(() => ({ cancelled: true as const })),
        ]);
        if ('cancelled' in synthesis) break;
        if (synthesis.ok === false) {
          throw synthesis.error instanceof Error
            ? synthesis.error
            : new Error(String(synthesis.error));
        }
        const audioPath = synthesis.path;
        if (cancelled) break;
        await Promise.race([gate.wait(), cancellation]);
        if (cancelled) break;
        nextSynthesis =
          index + 1 < segments.length ? synthesize(segments[index + 1], index + 1) : null;
        audioPaths.push(audioPath);
        options.onSegmentStart?.({ index, total: segments.length, text: segments[index] });
        let result = await playSegment(audioPath, index);
        while (result.interrupted && stoppedForPause && !cancelled) {
          stoppedForPause = false;
          await Promise.race([gate.wait(), cancellation]);
          if (cancelled) break;
          result = await playSegment(audioPath, index);
        }
        if (!result.ok && !result.interrupted) {
          error = result.error || 'playback failed';
          break;
        }
        spoken += 1;
        if (cancelled || result.interrupted) break;
      }
      // Every synthesis promise is normalized with an error handler at
      // creation time, so cancellation cannot create an unhandled rejection.
    } catch (err) {
      if (!cancelled) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      completed: !cancelled && !error && spoken === segments.length,
      interrupted: cancelled,
      metrics: {
        segments_total: segments.length,
        segments_spoken: spoken,
        first_audio_ms: firstAudioMs,
        total_ms: Date.now() - startedAt,
      },
      audioPaths,
      ...(error ? { error } : {}),
    };
  };

  const done = run();

  return {
    done,
    pause: () => {
      gate.pause();
      const handle = currentPlayback as Partial<PausablePlaybackHandle> | null;
      if (!handle) return;
      // pause() reports whether the player actually suspended (see
      // audio-playback.ts); when it can't (e.g. no SIGSTOP support left, or
      // it failed), fall back to stop-and-replay like a non-pausable player
      // instead of assuming silence.
      if (typeof handle.pause === 'function' && handle.pause()) return;
      if (!stoppedForPause && handle.stop) {
        stoppedForPause = true;
        void handle.stop();
      }
    },
    resume: () => {
      gate.resume();
      (currentPlayback as Partial<PausablePlaybackHandle> | null)?.resume?.();
    },
    stop: async () => {
      cancelled = true;
      abortController.abort();
      resolveCancellation?.();
      gate.resume();
      if (currentPlayback) {
        await currentPlayback.stop();
      }
      return done;
    },
  };
}
