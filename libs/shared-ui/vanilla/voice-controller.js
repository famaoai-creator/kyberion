/*
 * Kyberion UI — microphone controller for `ui:voice-input` (PA-02,
 * PADS_A2UI_AND_AVATAR_PLAN_2026-09-23 §3).
 *
 * Renderer-independent audio plumbing shared by the vanilla renderer
 * (`voice.js`) and the React component (`src/voice/*`, inside an effect):
 *
 *   - `dictation`: Web Speech `SpeechRecognition` (or the `webkit` prefix)
 *     with interim results; the mic stream is opened only for the level meter.
 *   - `record`: `MediaRecorder` audio capture, one file on stop — or, with
 *     `chunkMs`, one complete, independently decodable file per chunk: the
 *     recorder is stopped and a fresh one started on the same stream at
 *     every boundary (`offsetMs` = chunk start relative to the recording).
 *   - `continuous` dictation restarts a recognition that ended on its own
 *     (browser silence timeout) while the user has not stopped — bounded to
 *     `KB_VOICE_MAX_RESTARTS` restarts in a row without a result.
 *   - Level meter: Web Audio `AnalyserNode` RMS on the getUserMedia stream,
 *     sampled in a rAF loop and reported (throttled) through `onLevel(0..1)`.
 *
 * Nothing starts until `start()` (call it only from a user action). Every
 * browser API is injectable (`win`, `raf`, `caf`, `timers`, `now`) so the
 * state machine is testable with fakes. A generation token is bumped by every
 * start and every release: an async continuation (getUserMedia, recognition /
 * recorder events) from an older generation releases what it got and is
 * otherwise ignored, so start → stop → start never leaks a stream, an
 * AudioContext or a recognition. `stop()` / errors / `dispose()` stop every
 * track, close the AudioContext, cancel the rAF loop and abort recognition.
 * Recorded audio leaves this closure only through `onRecording`.
 */
/* global Blob */
import { toFile, stopStream } from './forms-camera.js';

/** Internal `ui:voice-input` states (reported via `voice.state`). */
export const KB_VOICE_INPUT_STATES = Object.freeze([
  'idle',
  'requesting',
  'listening',
  'recording',
  'processing',
  'error',
  'unsupported',
]);

/** `voice.error` codes. */
export const KB_VOICE_ERROR_CODES = Object.freeze([
  'permission_denied',
  'not_supported',
  'no_speech',
  'network',
  'aborted',
  'unknown',
]);

/** Audio container types tried for `MediaRecorder`, most preferred first. */
export const KB_VOICE_RECORDER_TYPES = Object.freeze([
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
]);

/** Continuous dictation: restarts in a row (without a result) before giving up. */
export const KB_VOICE_MAX_RESTARTS = 10;

const BCP47_BY_LOCALE = Object.freeze({ en: 'en-US', ja: 'ja-JP', 'qps-ploc': 'en-US' });
const LEVEL_INTERVAL_MS = 50;
const ELAPSED_INTERVAL_MS = 250;

/** Recognition language: explicit `lang`, else the render locale (en → en-US, ja → ja-JP). */
export function voiceLang(lang, locale) {
  if (typeof lang === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) return lang;
  const base = typeof locale === 'string' && locale ? locale : 'en';
  if (Object.prototype.hasOwnProperty.call(BCP47_BY_LOCALE, base)) return BCP47_BY_LOCALE[base];
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(base) ? base : 'en-US';
}

/** `m:ss` for an elapsed time in ms (negative / invalid → `0:00`). */
export function formatElapsed(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

/** The SpeechRecognition constructor of `win`, or null. */
export function speechRecognitionCtor(win) {
  if (!win) return null;
  const ctor = win.SpeechRecognition || win.webkitSpeechRecognition;
  return typeof ctor === 'function' ? ctor : null;
}

function audioContextCtor(win) {
  if (!win) return null;
  const ctor = win.AudioContext || win.webkitAudioContext;
  return typeof ctor === 'function' ? ctor : null;
}

function hasGetUserMedia(win) {
  return Boolean(
    win &&
    win.navigator &&
    win.navigator.mediaDevices &&
    typeof win.navigator.mediaDevices.getUserMedia === 'function'
  );
}

/**
 * Whether `mode` can work in `win`: `true` / `false`, or `null` when there is
 * no window at all (server render — the UI then shows the idle state and
 * decides on the client).
 */
export function voiceSupported(win, mode) {
  if (!win) return null;
  if (mode === 'record') return hasGetUserMedia(win) && typeof win.MediaRecorder === 'function';
  return speechRecognitionCtor(win) !== null;
}

/** First `KB_VOICE_RECORDER_TYPES` entry `MediaRecorder` supports ('' = browser default). */
export function pickRecorderType(win) {
  const Recorder = win && win.MediaRecorder;
  if (!Recorder || typeof Recorder.isTypeSupported !== 'function') return '';
  for (const type of KB_VOICE_RECORDER_TYPES) {
    try {
      if (Recorder.isTypeSupported(type)) return type;
    } catch {
      // keep looking
    }
  }
  return '';
}

/** Map a getUserMedia / MediaRecorder / SpeechRecognition error to a `voice.error` code. */
export function voiceErrorCode(error) {
  const name =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object'
        ? String(error.error || error.name || '')
        : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
    case 'not-allowed':
    case 'service-not-allowed':
      return 'permission_denied';
    case 'NotFoundError':
    case 'NotSupportedError':
    case 'OverconstrainedError':
    case 'NotReadableError':
    case 'audio-capture':
    case 'language-not-supported':
    case 'not_supported':
      return 'not_supported';
    case 'no-speech':
      return 'no_speech';
    case 'network':
      return 'network';
    case 'AbortError':
    case 'aborted':
      return 'aborted';
    default:
      return 'unknown';
  }
}

/** RMS of 8-bit time-domain samples (centered on 128), scaled to 0..1 for speech. */
export function rmsLevel(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 3);
}

function fileExtension(type) {
  if (/ogg/.test(type)) return 'ogg';
  if (/mp4|aac|m4a/.test(type)) return 'm4a';
  return 'webm';
}

/**
 * @param {{
 *   win?: any,
 *   mode?: 'dictation' | 'record',
 *   lang?: string,
 *   continuous?: boolean,
 *   meter?: boolean,
 *   chunkMs?: number,
 *   maxSeconds?: number,
 *   now?: () => number,
 *   raf?: (fn: (t: number) => void) => any,
 *   caf?: (handle: any) => void,
 *   timers?: { setInterval: (fn: () => void, ms: number) => any, clearInterval: (handle: any) => void },
 *   onState?: (state: string, detail: { error: string | null }) => void,
 *   onLevel?: (level: number) => void,
 *   onElapsed?: (ms: number) => void,
 *   onTranscript?: (result: { text: string, final: boolean }) => void,
 *   onRecording?: (result: { file: Blob, durationMs: number, offsetMs: number, final: boolean }) => void,
 *   onError?: (code: string) => void,
 * }} options
 */
export function createVoiceController(options = {}) {
  const win = options.win;
  const mode = options.mode === 'record' ? 'record' : 'dictation';
  const meter = options.meter !== false;
  const chunkMs =
    mode === 'record' && Number.isFinite(options.chunkMs) && options.chunkMs >= 100
      ? Math.floor(options.chunkMs)
      : 0;
  const maxMs =
    Number.isFinite(options.maxSeconds) && options.maxSeconds > 0 ? options.maxSeconds * 1000 : 0;
  const now =
    typeof options.now === 'function'
      ? options.now
      : () => (win && win.performance ? win.performance.now() : Date.now());
  const raf =
    typeof options.raf === 'function'
      ? options.raf
      : win && typeof win.requestAnimationFrame === 'function'
        ? (fn) => win.requestAnimationFrame(fn)
        : null;
  const caf =
    typeof options.caf === 'function'
      ? options.caf
      : win && typeof win.cancelAnimationFrame === 'function'
        ? (handle) => win.cancelAnimationFrame(handle)
        : () => {};
  const timers =
    options.timers ||
    (win && typeof win.setInterval === 'function'
      ? {
          setInterval: (fn, ms) => win.setInterval(fn, ms),
          clearInterval: (h) => win.clearInterval(h),
        }
      : { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h) });

  let state = 'idle';
  let error = null;
  let disposed = false;
  let generation = 0;
  // Live resources of the current generation.
  let stream = null;
  let audioContext = null;
  let rafHandle = null;
  let ticker = null;
  let rotator = null;
  let recognition = null;
  let recorder = null;
  let startedAt = 0;
  let lastSecond = -1;
  let level = 0;
  let lastLevelAt = -Infinity;

  const call = (fn, ...args) => {
    if (!disposed && typeof fn === 'function') fn(...args);
  };
  const setState = (next, code = null) => {
    if (state === next && error === code) return;
    state = next;
    error = code;
    call(options.onState, state, { error });
  };
  const emitLevel = (value, force) => {
    const t = now();
    if (!force && t - lastLevelAt < LEVEL_INTERVAL_MS) return;
    if (!force && Math.abs(value - level) < 0.01) return;
    lastLevelAt = t;
    level = value;
    call(options.onLevel, value);
  };

  /** Release every live resource (idempotent). Bumps the generation. */
  const release = () => {
    generation += 1;
    if (rafHandle !== null) {
      try {
        caf(rafHandle);
      } catch {
        // gone
      }
      rafHandle = null;
    }
    if (ticker !== null) {
      timers.clearInterval(ticker);
      ticker = null;
    }
    if (rotator !== null) {
      timers.clearInterval(rotator);
      rotator = null;
    }
    if (recognition) {
      const rec = recognition;
      recognition = null;
      try {
        rec.abort();
      } catch {
        // already ended
      }
    }
    if (recorder) {
      const rec = recorder;
      recorder = null;
      try {
        if (rec.state !== 'inactive') rec.stop();
      } catch {
        // already stopped
      }
    }
    stopStream(stream);
    stream = null;
    if (audioContext) {
      const ctx = audioContext;
      audioContext = null;
      try {
        const closed = ctx.close();
        if (closed && typeof closed.catch === 'function') closed.catch(() => {});
      } catch {
        // already closed
      }
    }
    if (level !== 0) emitLevel(0, true);
  };

  const fail = (code) => {
    release();
    setState('error', code);
    call(options.onError, code);
  };

  const startMeter = (token) => {
    const Ctx = audioContextCtor(win);
    if (!Ctx || !stream || !raf) return;
    try {
      audioContext = new Ctx();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buffer = new Uint8Array(analyser.fftSize);
      let smooth = 0;
      const loop = () => {
        if (token !== generation || disposed) return;
        analyser.getByteTimeDomainData(buffer);
        const raw = rmsLevel(buffer);
        // Fast attack, slow decay: readable without flicker.
        smooth = raw > smooth ? raw : smooth * 0.85 + raw * 0.15;
        emitLevel(Math.round(smooth * 100) / 100, false);
        rafHandle = raf(loop);
      };
      rafHandle = raf(loop);
    } catch {
      // The meter is best effort; capture still works without it.
    }
  };

  const startTicker = (token) => {
    startedAt = now();
    lastSecond = 0;
    call(options.onElapsed, 0);
    ticker = timers.setInterval(() => {
      if (token !== generation) return;
      const elapsed = now() - startedAt;
      const second = Math.floor(elapsed / 1000);
      if (second !== lastSecond) {
        lastSecond = second;
        call(options.onElapsed, elapsed);
      }
      if (maxMs && elapsed >= maxMs) controller.stop();
    }, ELAPSED_INTERVAL_MS);
  };

  const openStream = async (token) => {
    const next = await win.navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (disposed || token !== generation) {
      stopStream(next);
      return false;
    }
    stream = next;
    return true;
  };

  const startRecord = async (token) => {
    if (!(await openStream(token))) return;
    const type = pickRecorderType(win);
    const fileType = (rec) => (rec && rec.mimeType) || type || 'audio/webm';
    // One MediaRecorder per segment. Without `chunkMs` there is a single
    // segment; with it the recorder is stopped and a fresh one started on
    // the same stream every `chunkMs`, so every chunk is a complete,
    // independently decodable file (a timeslice would only produce
    // header-less fragments after the first). Segments are delivered in
    // order; a rotated-out segment still delivers after a graceful stop.
    const segments = [];
    let nextEmit = 0;
    const segmentLive = (seg) => !disposed && (token === generation || seg.draining);
    const flush = () => {
      while (nextEmit < segments.length && segments[nextEmit].done) {
        const seg = segments[nextEmit];
        nextEmit += 1;
        if (seg.parts.length || seg.final) {
          const blob = new Blob(seg.parts.splice(0), { type: fileType(seg.rec) });
          const file = toFile(blob, `recording.${fileExtension(fileType(seg.rec))}`, win);
          const endMs = seg.endMs === null ? now() : seg.endMs;
          call(options.onRecording, {
            file,
            durationMs: Math.max(0, endMs - seg.startMs),
            offsetMs: Math.max(0, seg.startMs - startedAt),
            final: seg.final,
          });
        }
        if (seg.final) {
          if (finishing === seg.rec) finishing = null;
          setState('idle');
        }
      }
    };
    const openSegment = () => {
      let rec;
      try {
        rec = type
          ? new win.MediaRecorder(stream, { mimeType: type })
          : new win.MediaRecorder(stream);
      } catch (err) {
        fail(voiceErrorCode(err && err.name ? err : 'not_supported'));
        return null;
      }
      const seg = {
        rec,
        parts: [],
        startMs: segments.length ? now() : startedAt,
        endMs: null,
        draining: false,
        final: false,
        done: false,
      };
      segments.push(seg);
      rec.ondataavailable = (event) => {
        if (!segmentLive(seg) && rec !== finishing) return;
        const data = event && event.data;
        if (data && data.size) seg.parts.push(data);
      };
      rec.onstop = () => {
        if (disposed || seg.done) return;
        if (rec === finishing) seg.final = true;
        else if (!seg.draining) return;
        seg.done = true;
        if (seg.endMs === null) seg.endMs = now();
        flush();
      };
      rec.onerror = (event) => {
        if (disposed || (!segmentLive(seg) && rec !== finishing)) return;
        if (rec === finishing) finishing = null;
        fail(voiceErrorCode(event && event.error ? event.error : event));
      };
      try {
        rec.start();
      } catch (err) {
        fail(voiceErrorCode(err));
        return null;
      }
      recorder = rec;
      return seg;
    };
    startedAt = now();
    if (!openSegment()) return;
    if (meter) startMeter(token);
    startTicker(token);
    if (chunkMs) {
      rotator = timers.setInterval(() => {
        if (token !== generation || disposed || !recorder) return;
        const current = segments[segments.length - 1];
        current.draining = true;
        current.endMs = now();
        try {
          if (current.rec.state !== 'inactive') current.rec.stop();
        } catch {
          // already stopped
        }
        openSegment();
      }, chunkMs);
    }
    setState('recording');
  };

  const startDictation = async (token) => {
    const Recognition = speechRecognitionCtor(win);
    if (meter && hasGetUserMedia(win)) {
      if (!(await openStream(token))) return;
    }
    let rec;
    try {
      rec = new Recognition();
      rec.lang = voiceLang(options.lang, 'en');
      rec.interimResults = true;
      rec.continuous = options.continuous === true;
      rec.maxAlternatives = 1;
    } catch (err) {
      fail(voiceErrorCode(err && err.name ? err : 'not_supported'));
      return;
    }
    recognition = rec;
    const continuous = options.continuous === true;
    const live = () => !disposed && (token === generation || rec === finishing);
    let begun = false;
    let restarts = 0;
    rec.onstart = () => {
      if (disposed || token !== generation) return;
      // A continuous restart keeps the meter, the ticker and the state.
      if (begun) return;
      begun = true;
      if (stream) startMeter(token);
      startTicker(token);
      setState('listening');
    };
    rec.onresult = (event) => {
      if (!live()) return;
      restarts = 0;
      const results = (event && event.results) || [];
      let interim = '';
      for (let i = event && event.resultIndex ? event.resultIndex : 0; i < results.length; i += 1) {
        const result = results[i];
        const text = result && result[0] ? String(result[0].transcript || '') : '';
        if (result && result.isFinal) {
          if (text.trim()) call(options.onTranscript, { text: text.trim(), final: true });
        } else {
          interim += text;
        }
      }
      if (interim.trim()) call(options.onTranscript, { text: interim.trim(), final: false });
    };
    rec.onerror = (event) => {
      if (!live()) return;
      // Continuous dictation: silence is not a failure — `onend` restarts.
      if (continuous && rec !== finishing && voiceErrorCode(event) === 'no_speech') return;
      if (rec === finishing) finishing = null;
      fail(voiceErrorCode(event));
    };
    rec.onend = () => {
      if (disposed) return;
      if (rec === finishing) {
        finishing = null;
        setState('idle');
        return;
      }
      if (token !== generation || recognition !== rec) return;
      // Ended on its own (browser silence timeout) while the user has not
      // stopped: continuous dictation starts it again (bounded).
      if (continuous && begun && restarts < KB_VOICE_MAX_RESTARTS) {
        restarts += 1;
        try {
          rec.start();
          return;
        } catch {
          // fall through to idle
        }
      }
      release();
      setState('idle');
    };
    try {
      rec.start();
    } catch (err) {
      fail(voiceErrorCode(err));
    }
  };

  // The recognition / recorder asked to stop gracefully: its final result /
  // file still arrives after release() bumped the generation.
  let finishing = null;

  const controller = {
    get state() {
      return state;
    },
    get error() {
      return error;
    },
    get mode() {
      return mode;
    },
    /** Live resources (tests / diagnostics). */
    get resources() {
      return { stream, audioContext, recognition, recorder, rafHandle, ticker };
    },
    /** Whether the needed browser APIs exist (`null` without a window). */
    get supported() {
      return voiceSupported(win, mode);
    },
    /** Open the microphone. Call only from a user action. */
    async start() {
      if (disposed) return;
      if (state === 'requesting' || state === 'listening' || state === 'recording') return;
      if (state === 'processing') return;
      if (voiceSupported(win, mode) !== true) {
        release();
        setState('unsupported', 'not_supported');
        call(options.onError, 'not_supported');
        return;
      }
      release();
      const token = generation;
      setState('requesting');
      try {
        if (mode === 'record') await startRecord(token);
        else await startDictation(token);
      } catch (err) {
        if (disposed || token !== generation) return;
        fail(voiceErrorCode(err));
      }
    },
    /** Finish: dictation delivers its last result, record mode its file. */
    stop() {
      if (disposed) return;
      const active = state === 'recording' ? recorder : state === 'listening' ? recognition : null;
      if (active) {
        // Detach it so release() (stream, meter, ticker) leaves it running
        // until its final `onstop` / `onend`.
        if (active === recorder) recorder = null;
        else recognition = null;
        finishing = active;
        setState('processing');
        try {
          if (active.state !== 'inactive') active.stop();
        } catch {
          finishing = null;
        }
        release();
        if (!finishing && state === 'processing') setState('idle');
        return;
      }
      if (state === 'error' || state === 'unsupported' || state === 'processing') return;
      release();
      if (state !== 'idle') setState('idle');
    },
    dispose() {
      if (disposed) return;
      release();
      if (finishing) {
        const pending = finishing;
        finishing = null;
        try {
          if (typeof pending.abort === 'function') pending.abort();
          else if (pending.state !== 'inactive') pending.stop();
        } catch {
          // ended
        }
      }
      disposed = true;
    },
  };
  return controller;
}
