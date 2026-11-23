import { describe, expect, it, vi } from 'vitest';
import {
  checkFiniteStateSafety,
  type ModelStep,
  type SafetyModel,
} from '../../core/testing/finite-state-checker.js';
import { streamVoicePlayback } from './streaming-voice-playback.js';
import { TwoStageBargeIn } from './two-stage-barge-in.js';
import { VoicePhraseChunker } from './voice-phrase-chunker.js';
import type { AudioChunk, AudioFormat } from '@agent/core/meeting/meeting-session-types';
import type { PlaybackHandle, PlaybackResult } from '@agent/core/voice/audio-playback';

// Safety properties under verification (executable safety model; see
// knowledge/product/architecture/executable-safety-models.md):
//   A. Streaming playback dispatch: a segment plays only after synthesis and
//      an open pause-gate; stop() drains all in-flight work; replay after a
//      stop-for-pause owes the same segment; success requires every admitted
//      segment spoken.
//   B. Two-stage barge-in: hard_stop requires a prior pause episode and a
//      confirming signal (words, or sustained speech without streaming STT);
//      a stopped episode emits no further actions until reset.
//   C. Phrase chunker: emitted phrases are bounded by the active cap, cover
//      the input modulo boundary whitespace, and every cut is justified by a
//      break char or the cap. Emission is evaluated per delta against the
//      buffered text — the '. ' fallback fires only when no hard sentence end
//      is visible yet, so phrase boundaries around '. ' are legitimately
//      partition-sensitive (pinned, not a defect).
//
// Abstraction: segments are counted, not bytes; chunk RMS collapses to
// loud/quiet; STT partials collapse to words/filler/echo; wall time to a
// fake clock. Real audio, TTS engines, process spawning, and event-loop
// timing are outside the model.

const flushTicks = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await new Promise<void>((r) => setImmediate(r));
};

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Spec A: streaming playback dispatch lifecycle
// ---------------------------------------------------------------------------

type PlaybackPhase = 'open' | 'ended' | 'stopped';
type Current = 'none' | 'synth' | 'gated' | 'play';
/** How a playing handle is held while the gate is closed. */
type HoldMode = 'none' | 'suspended' | 'unpausable';
const QUEUE_CAP = 2;
/** Finite segment supply; keeps push→dequeue→push… from being unbounded. */
const SEGMENT_BUDGET = 3;

interface PlaybackState {
  phase: PlaybackPhase;
  /** Segments pushed so far (bounded by SEGMENT_BUDGET). */
  pushed: number;
  queued: number;
  current: Current;
  paused: boolean;
  /**
   * 'suspended': pausable handle suspended in place (cannot finish).
   * 'unpausable': handle without pause() support — left running and may
   * still complete while the gate is closed.
   */
  hold: HoldMode;
  /** pause() failed on the handle: it was stopped and owes a replay. */
  replay: boolean;
  admitted: number;
  spoken: number;
  errored: boolean;
}

const playbackIdle: PlaybackState = {
  phase: 'open',
  pushed: 0,
  queued: 0,
  current: 'none',
  paused: false,
  hold: 'none',
  replay: false,
  admitted: 0,
  spoken: 0,
  errored: false,
};

function playbackNext(s: PlaybackState): readonly ModelStep<PlaybackState>[] {
  if (s.phase === 'stopped') return [];
  const out: ModelStep<PlaybackState>[] = [];
  // Driver actions.
  if (s.phase === 'open') {
    if (s.queued < QUEUE_CAP && s.pushed < SEGMENT_BUDGET) {
      out.push({
        action: 'push',
        state: { ...s, queued: s.queued + 1, pushed: s.pushed + 1 },
      });
    }
    out.push({ action: 'end', state: { ...s, phase: 'ended' } });
  }
  out.push({
    action: 'stop',
    state: {
      ...s,
      phase: 'stopped',
      current: 'none',
      paused: false,
      hold: 'none',
      replay: false,
    },
  });
  if (!s.paused) {
    if (s.current === 'play') {
      out.push({ action: 'pause:suspend', state: { ...s, paused: true, hold: 'suspended' } });
      out.push({
        action: 'pause:stop-replay',
        state: { ...s, paused: true, current: 'none', replay: true },
      });
      out.push({ action: 'pause:unpausable', state: { ...s, paused: true, hold: 'unpausable' } });
    } else {
      out.push({ action: 'pause', state: { ...s, paused: true } });
    }
  } else {
    const resumed: PlaybackState = { ...s, paused: false, hold: 'none', replay: false };
    if (!s.errored && (s.replay || s.current === 'gated')) resumed.current = 'play';
    out.push({ action: 'resume', state: resumed });
  }
  // Queue drains into synthesis — but never past an owed replay.
  if (s.current === 'none' && !s.errored && !s.replay && s.queued > 0) {
    out.push({
      action: 'dequeue',
      state: { ...s, queued: s.queued - 1, current: 'synth', admitted: s.admitted + 1 },
    });
  }
  // Engine outcomes.
  if (s.current === 'synth') {
    out.push({
      action: 'synth:ok',
      state: { ...s, current: s.paused ? 'gated' : 'play' },
    });
    out.push({ action: 'synth:fail', state: { ...s, current: 'none', errored: true } });
  }
  if (s.current === 'play' && s.hold !== 'suspended') {
    out.push({
      action: 'play:ok',
      state: { ...s, current: 'none', hold: 'none', spoken: s.spoken + 1 },
    });
    out.push({
      action: 'play:fail',
      state: { ...s, current: 'none', hold: 'none', errored: true },
    });
  }
  return out;
}

const playbackModel: SafetyModel<PlaybackState> = {
  initial: [playbackIdle],
  key: (s) => JSON.stringify(s),
  next: playbackNext,
  invariants: {
    'stopped drains all in-flight work': (s) =>
      s.phase !== 'stopped' ||
      (s.current === 'none' && s.hold === 'none' && !s.replay && !s.paused),
    'paused playback is held or gated': (s) =>
      !(s.paused && s.current === 'play') || s.hold !== 'none',
    'gated work implies a closed gate': (s) => s.current !== 'gated' || s.paused,
    'replay pending implies a closed gate': (s) => !s.replay || s.paused,
    'replay pending owes a spoken segment': (s) => !s.replay || s.admitted > s.spoken,
    'unpausable hold only while paused and playing': (s) =>
      s.hold !== 'unpausable' || (s.paused && s.current === 'play'),
    'spoken never exceeds admitted': (s) => s.spoken <= s.admitted,
    'admitted never exceeds pushed': (s) => s.admitted <= s.pushed,
    'queue stays within bounds': (s) => s.queued >= 0 && s.queued <= QUEUE_CAP,
    'quiescent success means every admitted segment spoke': (s) =>
      !(s.phase === 'ended' && s.queued === 0 && s.current === 'none' && !s.errored && !s.replay) ||
      s.admitted === s.spoken,
    'error drains in-flight work': (s) => !s.errored || s.current === 'none',
  },
};

describe('streaming playback finite-state specification', () => {
  it('exhausts the reachable graph without a safety violation', () => {
    const result = checkFiniteStateSafety(playbackModel);
    expect(result).toEqual({ status: 'verified', visited: 165, transitions: 537 });
  });

  it('detects a gate-bypass mutation with a counterexample', () => {
    const mutant: SafetyModel<PlaybackState> = {
      ...playbackModel,
      next: (s) =>
        playbackNext(s).map((step) =>
          step.action === 'synth:ok' ? { ...step, state: { ...step.state, current: 'play' } } : step
        ),
    };
    const result = checkFiniteStateSafety(mutant);
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('paused playback is held or gated');
  });

  it('detects a stop-drain mutation with a counterexample', () => {
    const mutant: SafetyModel<PlaybackState> = {
      ...playbackModel,
      next: (s) =>
        playbackNext(s).map((step) =>
          step.action === 'stop' ? { ...step, state: { ...step.state, current: s.current } } : step
        ),
    };
    const result = checkFiniteStateSafety(mutant);
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('stopped drains all in-flight work');
  });

  it('detects an unowed-replay mutation with a counterexample', () => {
    const mutant: SafetyModel<PlaybackState> = {
      ...playbackModel,
      next: (s) => {
        const steps = playbackNext(s);
        if (s.current === 'none' && !s.paused && !s.replay) {
          steps.push({
            action: 'pause:phantom-replay',
            state: { ...s, paused: true, replay: true },
          });
        }
        return steps;
      },
    };
    const result = checkFiniteStateSafety(mutant);
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('replay pending owes a spoken segment');
  });
});

// ---- Conformance A: the real controller over scripted driver sequences ----

interface FakeHandle extends PlaybackHandle {
  pauses: number;
  resumes: number;
  stops: number;
  resolveDone: (r: PlaybackResult) => void;
}

function playbackHarness(options: { pauseImpl?: () => boolean } = {}) {
  const synths: string[] = [];
  const plays: { path: string; index: number }[] = [];
  const synthDeferreds: Array<{ segment: string; d: ReturnType<typeof deferred<string>> }> = [];
  const handles: FakeHandle[] = [];
  const controller = streamVoicePlayback({
    synthesize: async (segment) => {
      synths.push(segment);
      const d = deferred<string>();
      synthDeferreds.push({ segment, d });
      return d.promise;
    },
    play: (path, index) => {
      plays.push({ path, index });
      const d = deferred<PlaybackResult>();
      const handle: FakeHandle = {
        pauses: 0,
        resumes: 0,
        stops: 0,
        resolveDone: d.resolve,
        done: d.promise,
        stop: async () => {
          handle.stops += 1;
          const result: PlaybackResult = { ok: true, interrupted: true };
          d.resolve(result);
          return result;
        },
      };
      if (options.pauseImpl) {
        const pausable = handle as FakeHandle &
          Partial<import('./streaming-voice-playback.js').PausablePlaybackHandle>;
        const pauseImpl = options.pauseImpl;
        pausable.pause = () => {
          handle.pauses += 1;
          return pauseImpl();
        };
        pausable.resume = () => {
          handle.resumes += 1;
        };
      }
      handles.push(handle);
      return handle;
    },
  });
  return { controller, synths, plays, synthDeferreds, handles };
}

const settleSynth = async (
  h: ReturnType<typeof playbackHarness>,
  result: string | Error
): Promise<void> => {
  const pending = h.synthDeferreds.at(-1);
  if (!pending) throw new Error('no pending synthesis');
  if (result instanceof Error) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- deferred reject path
    pending.d.resolve(Promise.reject(result));
  } else {
    pending.d.resolve(result);
  }
  await flushTicks();
};

describe('streamVoicePlayback conformance', () => {
  it('push + end drains the queue and completes in push order', async () => {
    const h = playbackHarness();
    h.controller.push('first');
    h.controller.push('second');
    h.controller.end();
    await flushTicks();
    expect(h.synths).toEqual(['first']);
    await settleSynth(h, 'p0.wav');
    expect(h.plays.map((p) => p.index)).toEqual([0]);
    h.handles[0]!.resolveDone({ ok: true, interrupted: false });
    await flushTicks();
    expect(h.synths).toEqual(['first', 'second']);
    await settleSynth(h, 'p1.wav');
    h.handles[1]!.resolveDone({ ok: true, interrupted: false });
    const result = await h.controller.done;
    expect(result.completed).toBe(true);
    expect(result.interrupted).toBe(false);
    expect(result.metrics).toMatchObject({ segments_total: 2, segments_spoken: 2 });
  });

  it('stop() during synthesis prevents any playback and reports interrupted', async () => {
    const h = playbackHarness();
    h.controller.push('first');
    await flushTicks();
    expect(h.synths).toEqual(['first']);
    const stopResult = await h.controller.stop();
    expect(h.plays).toEqual([]);
    const result = await stopResult;
    expect(result.interrupted).toBe(true);
    expect(result.completed).toBe(false);
    await settleSynth(h, 'late.wav');
    expect(h.plays).toEqual([]);
  });

  it('stop() during playback halts the current handle and ends the turn', async () => {
    const h = playbackHarness();
    h.controller.push('first');
    h.controller.end();
    await flushTicks();
    await settleSynth(h, 'p0.wav');
    expect(h.plays).toEqual([{ path: 'p0.wav', index: 0 }]);
    const result = await h.controller.stop();
    expect(h.handles[0]!.stops).toBe(1);
    const settled = await result;
    expect(settled.interrupted).toBe(true);
    // An interrupted play cycle still counts as spoken: the play attempt ran.
    expect(settled.metrics.segments_spoken).toBe(1);
  });

  it('push() after end() is dropped and an empty run completes', async () => {
    const h = playbackHarness();
    h.controller.end();
    h.controller.push('dropped');
    h.controller.push('   ');
    const result = await h.controller.done;
    expect(h.synths).toEqual([]);
    expect(result.completed).toBe(true);
    expect(result.metrics).toMatchObject({ segments_total: 0, segments_spoken: 0 });
  });

  it('a closed gate holds synthesized work until resume()', async () => {
    const h = playbackHarness();
    h.controller.push('first');
    h.controller.end();
    h.controller.pause?.();
    await flushTicks();
    await settleSynth(h, 'p0.wav');
    await flushTicks();
    expect(h.plays).toEqual([]);
    h.controller.resume?.();
    await flushTicks();
    expect(h.plays).toEqual([{ path: 'p0.wav', index: 0 }]);
    h.handles[0]!.resolveDone({ ok: true, interrupted: false });
    const result = await h.controller.done;
    expect(result.completed).toBe(true);
  });

  it('pause() suspends a pausable handle in place and resume() continues it', async () => {
    const h = playbackHarness({ pauseImpl: () => true });
    h.controller.push('first');
    h.controller.end();
    await flushTicks();
    await settleSynth(h, 'p0.wav');
    h.controller.pause?.();
    expect(h.handles[0]!.pauses).toBe(1);
    h.controller.resume?.();
    expect(h.handles[0]!.resumes).toBe(1);
    h.handles[0]!.resolveDone({ ok: true, interrupted: false });
    const result = await h.controller.done;
    expect(result.completed).toBe(true);
    expect(h.plays).toEqual([{ path: 'p0.wav', index: 0 }]);
  });

  it('pause() that fails on the handle replays the same index after resume()', async () => {
    const h = playbackHarness({ pauseImpl: () => false });
    h.controller.push('first');
    h.controller.end();
    await flushTicks();
    await settleSynth(h, 'p0.wav');
    h.controller.pause?.();
    await flushTicks();
    // pause() reported failure: the handle was stopped; replay waits on the gate.
    expect(h.handles[0]!.stops).toBe(1);
    expect(h.plays).toHaveLength(1);
    h.controller.resume?.();
    await flushTicks();
    expect(h.plays).toEqual([
      { path: 'p0.wav', index: 0 },
      { path: 'p0.wav', index: 0 },
    ]);
    h.handles[1]!.resolveDone({ ok: true, interrupted: false });
    const result = await h.controller.done;
    expect(result.completed).toBe(true);
    expect(result.metrics.segments_spoken).toBe(1);
  });

  it('pause() leaves a handle without pause() running — the gate holds only the next segment', async () => {
    const h = playbackHarness();
    h.controller.push('first');
    h.controller.push('second');
    h.controller.end();
    await flushTicks();
    await settleSynth(h, 'p0.wav');
    h.controller.pause?.();
    // No pause() method on the handle: it is left alone, not stopped.
    expect(h.handles[0]!.stops).toBe(0);
    h.handles[0]!.resolveDone({ ok: true, interrupted: false });
    await flushTicks();
    // The next segment synthesized but waits behind the closed gate.
    await settleSynth(h, 'p1.wav');
    await flushTicks();
    expect(h.plays).toEqual([{ path: 'p0.wav', index: 0 }]);
    h.controller.resume?.();
    await flushTicks();
    expect(h.plays).toEqual([
      { path: 'p0.wav', index: 0 },
      { path: 'p1.wav', index: 1 },
    ]);
    h.handles[1]!.resolveDone({ ok: true, interrupted: false });
    const result = await h.controller.done;
    expect(result.completed).toBe(true);
    expect(result.metrics.segments_spoken).toBe(2);
  });

  it('a synthesis failure fails the run without playing', async () => {
    const h = playbackHarness();
    const synthesizeError = new Error('tts backend down');
    const controller = streamVoicePlayback({
      synthesize: async () => {
        throw synthesizeError;
      },
      play: () => {
        throw new Error('play must not run');
      },
    });
    controller.push('first');
    controller.end();
    const result = await controller.done;
    expect(result.completed).toBe(false);
    expect(result.error).toBe('tts backend down');
  });

  it('a playback failure fails the run and skips later segments', async () => {
    const h = playbackHarness();
    h.controller.push('first');
    h.controller.push('second');
    h.controller.end();
    await flushTicks();
    await settleSynth(h, 'p0.wav');
    h.handles[0]!.resolveDone({ ok: false, interrupted: false, error: 'player crashed' });
    const result = await h.controller.done;
    expect(result.completed).toBe(false);
    expect(result.error).toBe('player crashed');
    expect(h.plays).toEqual([{ path: 'p0.wav', index: 0 }]);
    expect(result.metrics).toMatchObject({ segments_total: 1, segments_spoken: 0 });
  });
});

// ---------------------------------------------------------------------------
// Spec B: two-stage barge-in phase machine
// ---------------------------------------------------------------------------

type BargePhase = 'listening' | 'paused' | 'stopped';
type StopReason = 'none' | 'words' | 'fallback';
const SPEECH_CAP = 2; // 0: none, 1: provisional reached, 2: fallback level

interface BargeState {
  phase: BargePhase;
  /** A pause_tts was emitted earlier in this episode's history. */
  pauseSeen: boolean;
  hardStopped: boolean;
  stopReason: StopReason;
  resumed: boolean;
  speech: number;
  graceElapsed: boolean;
  audioSpeaking: boolean;
  vadActive: boolean;
}

const bargeIdle: BargeState = {
  phase: 'listening',
  pauseSeen: false,
  hardStopped: false,
  stopReason: 'none',
  resumed: false,
  speech: 0,
  graceElapsed: false,
  audioSpeaking: false,
  vadActive: false,
};

function bargeNext(stt: boolean) {
  return (s: BargeState): readonly ModelStep<BargeState>[] => {
    const out: ModelStep<BargeState>[] = [{ action: 'reset', state: { ...bargeIdle } }];
    if (s.phase === 'listening') {
      out.push({
        action: 'trigger',
        state: { ...bargeIdle, phase: 'paused', pauseSeen: true, speech: 1, audioSpeaking: true },
      });
      out.push({
        action: 'vad_start',
        state: { ...bargeIdle, phase: 'paused', pauseSeen: true, vadActive: true },
      });
      return out;
    }
    if (s.phase === 'stopped') return out;
    // paused
    out.push({
      action: 'partial:words',
      state: { ...s, phase: 'stopped', hardStopped: true, stopReason: 'words', vadActive: false },
    });
    out.push({ action: 'partial:filler', state: s });
    out.push({
      action: 'partial:echo',
      state: { ...bargeIdle, pauseSeen: true, resumed: true },
    });
    const grown: BargeState = {
      ...s,
      audioSpeaking: true,
      speech: Math.min(SPEECH_CAP, s.speech + 1),
    };
    if (!stt && grown.speech >= SPEECH_CAP) {
      out.push({
        action: 'chunk:speech-fallback',
        state: {
          ...grown,
          phase: 'stopped',
          hardStopped: true,
          stopReason: 'fallback',
          vadActive: false,
        },
      });
    } else {
      out.push({ action: 'chunk:speech', state: grown });
    }
    out.push({ action: 'chunk:quiet', state: { ...s, audioSpeaking: false } });
    if (!s.vadActive) {
      out.push({ action: 'vad_start', state: { ...s, vadActive: true } });
    } else {
      out.push({
        action: 'vad_end',
        state: { ...s, vadActive: false, speech: Math.min(SPEECH_CAP, s.speech + 1) },
      });
    }
    if (!s.graceElapsed) {
      out.push({ action: 'grace:pass', state: { ...s, graceElapsed: true } });
    }
    // Capture tick: fallback is checked before grace expiry (fallback wins).
    if (!stt && s.speech >= SPEECH_CAP) {
      out.push({
        action: 'tick:fallback',
        state: {
          ...s,
          phase: 'stopped',
          hardStopped: true,
          stopReason: 'fallback',
          vadActive: false,
        },
      });
    } else if (s.graceElapsed && (stt || (!s.audioSpeaking && !s.vadActive))) {
      out.push({
        action: 'tick:resume',
        state: { ...bargeIdle, pauseSeen: true, resumed: true },
      });
    }
    return out;
  };
}

const bargeInvariants = (stt: boolean): Record<string, (s: BargeState) => boolean> => ({
  'hard stop requires a prior pause': (s) => !s.hardStopped || s.pauseSeen,
  'stopped only via hard stop': (s) => s.phase !== 'stopped' || s.hardStopped,
  'hard stop is terminal for the episode': (s) => !s.hardStopped || s.phase === 'stopped',
  'resume requires a pause episode': (s) => !s.resumed || s.pauseSeen,
  'paused implies a pause was emitted': (s) => s.phase !== 'paused' || s.pauseSeen,
  'fallback stop needs sustained speech and no streaming STT': (s) =>
    s.stopReason !== 'fallback' || (s.speech >= SPEECH_CAP && !stt),
  'stop reason is words or fallback only': (s) =>
    s.stopReason === 'none' || s.stopReason === 'words' || s.stopReason === 'fallback',
  'listening carries no residual episode state': (s) =>
    s.phase !== 'listening' ||
    (s.speech === 0 && !s.audioSpeaking && !s.vadActive && !s.graceElapsed),
});

function bargeModel(stt: boolean): SafetyModel<BargeState> {
  return {
    initial: [{ ...bargeIdle }],
    key: (s) => JSON.stringify(s),
    next: bargeNext(stt),
    invariants: bargeInvariants(stt),
  };
}

describe('two-stage barge-in finite-state specification', () => {
  for (const stt of [true, false] as const) {
    it(`exhausts the reachable graph without a safety violation (streaming_stt=${stt})`, () => {
      const result = checkFiniteStateSafety(bargeModel(stt));
      expect(result).toEqual({
        status: 'verified',
        visited: stt ? 30 : 34,
        transitions: stt ? 160 : 164,
      });
    });
  }

  it('detects a listening-phase hard-stop mutation with a counterexample', () => {
    const model = bargeModel(true);
    const result = checkFiniteStateSafety({
      ...model,
      next: (s) =>
        s.phase === 'listening'
          ? [
              ...bargeNext(true)(s),
              {
                action: 'partial:words-early',
                state: {
                  ...s,
                  phase: 'stopped' as const,
                  hardStopped: true,
                  stopReason: 'words' as const,
                },
              },
            ]
          : bargeNext(true)(s),
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('hard stop requires a prior pause');
  });

  it('detects a streaming-STT fallback mutation with a counterexample', () => {
    const model = bargeModel(true);
    const result = checkFiniteStateSafety({
      ...model,
      next: (s) => {
        const steps = bargeNext(true)(s);
        if (s.phase === 'paused' && s.speech >= SPEECH_CAP) {
          steps.push({
            action: 'tick:fallback-with-stt',
            state: {
              ...s,
              phase: 'stopped' as const,
              hardStopped: true,
              stopReason: 'fallback' as const,
            },
          });
        }
        return steps;
      },
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('fallback stop needs sustained speech and no streaming STT');
  });
});

// ---- Conformance B: the real controller with fake audio, STT, and clock ----

const chunkFormat: AudioFormat = { encoding: 'pcm_s16le', sample_rate_hz: 16_000, channels: 1 };

function audioChunk(amplitude: number, durationMs = 50): AudioChunk {
  const payload = new Uint8Array((chunkFormat.sample_rate_hz * durationMs * 2) / 1000);
  const view = new DataView(payload.buffer);
  for (let offset = 0; offset + 1 < payload.byteLength; offset += 2) {
    view.setInt16(offset, amplitude, true);
  }
  return { format: chunkFormat, payload, ts_ms: 0 };
}

const LOUD = 16_000;
const QUIET = 0;

function bargeHarness(options: { stt?: boolean; echo?: (text: string) => boolean } = {}) {
  let now = 0;
  const bargeIn = new TwoStageBargeIn({
    base_rms_threshold: 800,
    provisional_speech_ms: 150,
    words_grace_ms: 600,
    fallback_hard_stop_speech_ms: 700,
    streaming_stt: options.stt ?? true,
    isEcho: options.echo,
    now: () => now,
  });
  return {
    bargeIn,
    advance: (ms: number) => {
      now += ms;
    },
    trigger: () => {
      let actions: ReturnType<TwoStageBargeIn['observeAudio']> = [];
      for (let i = 0; i < 4 && bargeIn.state === 'listening'; i += 1) {
        actions = actions.concat(bargeIn.observeAudio(audioChunk(LOUD)));
      }
      return actions;
    },
  };
}

describe('TwoStageBargeIn conformance', () => {
  it('emits pause_tts exactly once per listening episode', () => {
    const { bargeIn, trigger } = bargeHarness();
    expect(bargeIn.observeAudio(audioChunk(LOUD))).toEqual([]);
    expect(bargeIn.observeAudio(audioChunk(LOUD))).toEqual([]);
    expect(bargeIn.observeAudio(audioChunk(LOUD))).toEqual([{ type: 'pause_tts' }]);
    expect(bargeIn.state).toBe('paused');
    expect(bargeIn.observeAudio(audioChunk(LOUD))).toEqual([]);
    expect(trigger()).toEqual([]);
  });

  it('confirms a real-words partial as hard_stop and freezes further input', () => {
    const { bargeIn, trigger } = bargeHarness();
    trigger();
    expect(bargeIn.observePartial('yes please go ahead')).toEqual([
      { type: 'hard_stop', words: 'yes please go ahead' },
    ]);
    expect(bargeIn.state).toBe('stopped');
    expect(bargeIn.observeAudio(audioChunk(LOUD))).toEqual([]);
    expect(bargeIn.observePartial('more words')).toEqual([]);
    expect(bargeIn.bufferedChunks().length).toBeGreaterThan(0);
  });

  it('resumes with no_words when grace expires without confirming partials', () => {
    const { bargeIn, trigger, advance } = bargeHarness();
    trigger();
    expect(bargeIn.observePartial('uh')).toEqual([]);
    advance(650);
    expect(bargeIn.tick()).toEqual([{ type: 'resume_tts', reason: 'no_words' }]);
    expect(bargeIn.state).toBe('listening');
    // A second episode can pause again.
    expect(trigger()).toEqual([{ type: 'pause_tts' }]);
    expect(bargeIn.state).toBe('paused');
  });

  it('resumes with echo and never hard-stops on an echoed partial', () => {
    const { bargeIn, trigger } = bargeHarness({ echo: (text) => text.includes('assistant') });
    trigger();
    expect(bargeIn.observePartial('assistant playback echo')).toEqual([
      { type: 'resume_tts', reason: 'echo' },
    ]);
    expect(bargeIn.state).toBe('listening');
  });

  it('hard-stops via fallback only without streaming STT after sustained speech', () => {
    const { bargeIn, trigger } = bargeHarness({ stt: false });
    trigger(); // pauseSeen, speech = 150ms
    // 10 more loud chunks: speech 200..650 — still under the 700ms fallback.
    for (let i = 0; i < 10; i += 1) {
      expect(bargeIn.observeAudio(audioChunk(LOUD)), `chunk ${i}`).toEqual([]);
    }
    expect(bargeIn.state).toBe('paused');
    expect(bargeIn.observeAudio(audioChunk(LOUD))).toEqual([{ type: 'hard_stop', words: '' }]);
    expect(bargeIn.state).toBe('stopped');
  });

  it('keeps waiting through grace while speech continues without streaming STT', () => {
    const { bargeIn, trigger, advance } = bargeHarness({ stt: false });
    trigger();
    advance(650);
    expect(bargeIn.observeAudio(audioChunk(LOUD))).toEqual([]); // speaking: grace cannot fire
    expect(bargeIn.state).toBe('paused');
    expect(bargeIn.observeAudio(audioChunk(QUIET))).toEqual([
      { type: 'resume_tts', reason: 'no_words' },
    ]);
  });

  it('resumes on grace with streaming STT even while speech continues', () => {
    const { bargeIn, trigger, advance } = bargeHarness({ stt: true });
    trigger();
    advance(650);
    expect(bargeIn.observeAudio(audioChunk(LOUD))).toEqual([
      { type: 'resume_tts', reason: 'no_words' },
    ]);
    expect(bargeIn.state).toBe('listening');
  });

  it('applies queued partials before the tick chunk, so words beat grace expiry', () => {
    const { bargeIn, trigger, advance } = bargeHarness();
    trigger();
    advance(650);
    const quiet = audioChunk(QUIET);
    expect(bargeIn.observeTick(quiet, ['wait I have a question'])).toEqual([
      { type: 'hard_stop', words: 'wait I have a question' },
    ]);
    expect(bargeIn.state).toBe('stopped');
    expect(bargeIn.bufferedChunks()).toContain(quiet);
  });

  it('accepts an external VAD start as stage 1 and accumulates speech via vad_end', () => {
    const { bargeIn, advance } = bargeHarness({ stt: false });
    expect(bargeIn.observeVadStart(2_000)).toEqual([{ type: 'pause_tts' }]);
    expect(bargeIn.state).toBe('paused');
    // vad_end only accumulates while a vad interval is open; 4 × 200ms = 800.
    for (let i = 0; i < 4; i += 1) {
      advance(200);
      expect(bargeIn.observeVadEnd()).toEqual([]);
      if (i < 3) expect(bargeIn.observeVadStart()).toEqual([]); // re-arm while paused
    }
    // speechMs = 800 ≥ 700: the quiet chunk evaluates fallback before grace.
    expect(bargeIn.observeAudio(audioChunk(QUIET))).toEqual([{ type: 'hard_stop', words: '' }]);
  });

  it('resumes an episode after reset() even from stopped', () => {
    const { bargeIn, trigger } = bargeHarness();
    trigger();
    bargeIn.observePartial('stop now');
    expect(bargeIn.state).toBe('stopped');
    bargeIn.reset();
    expect(bargeIn.state).toBe('listening');
    expect(trigger()).toEqual([{ type: 'pause_tts' }]);
  });
});

// ---------------------------------------------------------------------------
// Spec C: phrase chunker — differential spec + boundary legality
// ---------------------------------------------------------------------------

const SENTENCE_END = new Set(['。', '！', '？', '!', '?']);

/**
 * Independent reference implementation of the phrase-cutting contract.
 * Emission is evaluated against the buffer present at each push — the '. '
 * fallback fires only when no hard sentence end is visible yet, so different
 * delta partitions may cut different (both legal) phrases around '. '.
 */
function specDrain(
  buffer: string,
  first: boolean,
  firstMaxChars: number,
  maxChars: number,
  firstBreak: ReadonlySet<string>
): { phrases: string[]; buffer: string; first: boolean } {
  const phrases: string[] = [];
  let buf = buffer;
  let isFirst = first;
  for (;;) {
    if (buf.length === 0) break;
    const cap = isFirst ? firstMaxChars : maxChars;
    const limit = Math.min(buf.length, cap);
    let index = -1;
    if (isFirst) {
      for (let i = 0; i < limit; i += 1) {
        if (firstBreak.has(buf[i]!)) {
          index = i;
          break;
        }
      }
    } else {
      // Two passes: hard sentence ends across the whole cap window first;
      // '. ' is only a fallback when none exist in the current buffer.
      for (let i = 0; i < limit; i += 1) {
        if (SENTENCE_END.has(buf[i]!)) {
          index = i;
          break;
        }
      }
      if (index === -1) {
        for (let i = 0; i < limit - 1; i += 1) {
          if (buf[i] === '.' && buf[i + 1] === ' ') {
            index = i;
            break;
          }
        }
      }
    }
    if (index !== -1) {
      phrases.push(buf.slice(0, index + 1));
      buf = buf.slice(index + 1);
      isFirst = false;
      continue;
    }
    if (buf.length >= cap) {
      phrases.push(buf.slice(0, cap));
      buf = buf.slice(cap);
      isFirst = false;
      continue;
    }
    break;
  }
  return { phrases, buffer: buf, first: isFirst };
}

function specChunk(
  parts: readonly string[],
  firstMaxChars: number,
  maxChars: number,
  firstBreak: ReadonlySet<string>
): string[] {
  const out: string[] = [];
  let buffer = '';
  let first = true;
  for (const part of parts) {
    if (!part) continue;
    buffer += part;
    const drained = specDrain(buffer, first, firstMaxChars, maxChars, firstBreak);
    out.push(...drained.phrases);
    buffer = drained.buffer;
    first = drained.first;
  }
  const tail = specDrain(buffer, first, firstMaxChars, maxChars, firstBreak);
  out.push(...tail.phrases);
  const remainder = tail.buffer.trim();
  if (remainder) out.push(remainder);
  return out.map((phrase) => phrase.trim()).filter((phrase) => phrase.length > 0);
}

/** All compositions of `text` into at most `maxParts` non-empty deltas. */
function* compositions(text: string, maxParts: number): Generator<string[]> {
  yield [text];
  if (maxParts < 2) return;
  for (let i = 1; i < text.length; i += 1) {
    yield [text.slice(0, i), text.slice(i)];
    if (maxParts < 3) continue;
    for (let j = i + 1; j < text.length; j += 1) {
      yield [text.slice(0, i), text.slice(i, j), text.slice(j)];
    }
  }
}

const CHUNKER_CASES: Array<{ text: string; firstMaxChars: number; maxChars: number }> = [
  { text: 'こんにちは、世界。今日はいい天気ですね！また明日。', firstMaxChars: 24, maxChars: 80 },
  {
    text: 'Hello, world. This is a streaming reply! And more? Yes.',
    firstMaxChars: 24,
    maxChars: 80,
  },
  { text: '短文。', firstMaxChars: 24, maxChars: 80 },
  { text: 'あ'.repeat(60), firstMaxChars: 24, maxChars: 80 },
  { text: 'a'.repeat(200), firstMaxChars: 24, maxChars: 80 },
  { text: '一。二。三。四。五。六。七。八。九。十。', firstMaxChars: 6, maxChars: 10 },
  {
    text: 'No breaks anywhere at all just plain words flowing on',
    firstMaxChars: 24,
    maxChars: 30,
  },
  { text: 'First. Second. Third. Fourth sentence here.', firstMaxChars: 10, maxChars: 15 },
  { text: '、、、、', firstMaxChars: 24, maxChars: 80 },
  { text: 'tail without punctuation', firstMaxChars: 24, maxChars: 80 },
];

describe('VoicePhraseChunker conformance', () => {
  it('emits exactly the spec phrases for every ≤3-part composition', () => {
    const firstBreak = new Set('、。！？!?,'.split(''));
    let checked = 0;
    for (const { text, firstMaxChars, maxChars } of CHUNKER_CASES) {
      for (const parts of compositions(text, 3)) {
        const expected = specChunk(parts, firstMaxChars, maxChars, firstBreak);
        const chunker = new VoicePhraseChunker({ firstMaxChars, maxChars });
        const emitted: string[] = [];
        for (const part of parts) emitted.push(...chunker.push(part));
        emitted.push(...chunker.flush());
        expect(emitted, `${JSON.stringify(text)} as ${JSON.stringify(parts)}`).toEqual(expected);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it('pins the documented partition sensitivity of the ". " fallback', () => {
    const text = 'Hello, world. This is a streaming reply! And more? Yes.';
    const oneShot = new VoicePhraseChunker();
    // '!' visible when '. ' is evaluated: the hard end wins, phrases merge.
    expect([...oneShot.push(text), ...oneShot.flush()]).toEqual([
      'Hello,',
      'world. This is a streaming reply!',
      'And more?',
      'Yes.',
    ]);
    const split = new VoicePhraseChunker();
    // Buffer ends right after '. ': no hard end visible yet, fallback cuts.
    expect([
      ...split.push('Hello, world. '),
      ...split.push('This is a streaming reply! And more? Yes.'),
      ...split.flush(),
    ]).toEqual(['Hello,', 'world.', 'This is a streaming reply!', 'And more?', 'Yes.']);
  });

  it('every phrase boundary is justified by a break char or a cap cut', () => {
    const firstBreak = new Set('、。！？!?,'.split(''));
    const isBreakChar = (ch: string, first: boolean): boolean =>
      first ? firstBreak.has(ch) : SENTENCE_END.has(ch) || ch === '.';
    for (const { text, firstMaxChars, maxChars } of CHUNKER_CASES) {
      const chunker = new VoicePhraseChunker({ firstMaxChars, maxChars });
      const emitted = [...chunker.push(text), ...chunker.flush()];
      // Walk the original text: emitted[i] is the trimmed slice taken at
      // buffer position `cursor`; a non-final phrase must end either on a
      // break char or exactly `cap` consumed chars later.
      let cursor = 0;
      emitted.forEach((phrase, index) => {
        let start = cursor;
        while (start < text.length && /\s/u.test(text[start]!)) start += 1;
        expect(text.startsWith(phrase, start), `phrase ${index} alignment`).toBe(true);
        const end = start + phrase.length;
        if (index === emitted.length - 1) return;
        if (isBreakChar(phrase.at(-1) ?? '', index === 0)) {
          cursor = end;
        } else {
          const cap = index === 0 ? firstMaxChars : maxChars;
          const consumedEnd = cursor + cap;
          expect(consumedEnd).toBeGreaterThanOrEqual(end);
          expect(text.slice(end, consumedEnd), `cap-cut tail of ${JSON.stringify(phrase)}`).toMatch(
            /^\s*$/u
          );
          cursor = consumedEnd;
        }
      });
    }
  });

  it('bounds every emitted phrase by the active cap and keeps them non-empty', () => {
    for (const { text, firstMaxChars, maxChars } of CHUNKER_CASES) {
      const chunker = new VoicePhraseChunker({ firstMaxChars, maxChars });
      const emitted = [...chunker.push(text), ...chunker.flush()];
      expect(emitted.length).toBeGreaterThan(0);
      emitted.forEach((phrase, index) => {
        expect(phrase.length).toBeGreaterThan(0);
        expect(phrase.length).toBeLessThanOrEqual(index === 0 ? firstMaxChars : maxChars);
      });
    }
  });

  it('covers the input modulo boundary whitespace', () => {
    const squash = (value: string) => value.replace(/\s+/gu, '');
    for (const { text, firstMaxChars, maxChars } of CHUNKER_CASES) {
      const chunker = new VoicePhraseChunker({ firstMaxChars, maxChars });
      const emitted = [...chunker.push(text), ...chunker.flush()];
      expect(squash(emitted.join(''))).toBe(squash(text));
    }
  });
});
