/*
 * Kyberion UI — browser speech player for the talking avatar (PA-09,
 * PADS_A2UI_AND_AVATAR_PLAN_2026-09-23 §6).
 *
 * Plays an assistant reply and tells the lip-sync controller (`lipsync.js`)
 * what drives the mouth. Three modes, tried in this order by `speak()`:
 *
 *   'browser-audio'     POST `synthesizeUrl` (the surface proxy of voice-hub
 *                       `/api/speech/synthesize`) → `decodeAudioData` →
 *                       AudioBufferSourceNode → AnalyserNode → destination.
 *                       `lipsync.attachAnalyser(analyser)` during playback,
 *                       `detachAnalyser()` after.
 *   'speech-synthesis'  fallback when synthesis is unavailable (501, network,
 *                       decode failure, suspended AudioContext, …):
 *                       `speechSynthesis` with `onstart` → `startSynthetic()`,
 *                       `onboundary` → `pulse()`, `onend` → `stopSynthetic()`.
 *   'host'              `followHostSpeech({ speaking, estimatedMs })` for
 *                       pages where voice-hub plays on the host speakers:
 *                       synthetic motion while the host reports speaking,
 *                       bounded by the estimate in case the idle update is lost.
 *
 * No `<audio>` element and no object URLs: the bytes go straight from the
 * response into Web Audio. Every browser API is injectable (`win`,
 * `fetchImpl`, `raf`, `caf`, `timers`) so the state machine is testable with
 * fakes. A generation token is bumped by every `speak()` / `stop()` /
 * `dispose()`: a continuation (fetch, decode, resume) from an older
 * generation resolves `{ cancelled: true }` and never starts audio, so
 * overlapping `speak()` calls cancel cleanly. Per-utterance nodes are
 * stopped and disconnected after playback; the single AudioContext is closed
 * by `dispose()`.
 */

/** `speak()` result modes; 'none' = no speech output was possible. */
export const KB_SPEECH_MODES = Object.freeze(['browser-audio', 'speech-synthesis', 'host', 'none']);

/** Player states reported through `onState`. */
export const KB_SPEECH_PLAYER_STATES = Object.freeze(['idle', 'loading', 'speaking']);

/** Extra time after the decoded duration before a missing `onended` is forced. */
const AUDIO_END_GRACE_MS = 2000;
/** Host mode: slack over the estimate, and the bound when there is none. */
const HOST_GRACE_MS = 1500;
const HOST_MAX_MS = 120000;

function noop() {}

function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return undefined;
  try {
    return fn(...args);
  } catch {
    // Observer / lip-sync failures must never break playback.
    return undefined;
  }
}

/**
 * Rough spoken length of `text` in ms: ~150 wpm for spaced words, ~150 ms per
 * CJK character (unspaced Japanese has no words to count). Used only as a
 * bound (host mode, a stuck `speechSynthesis`), never for timing the mouth.
 */
export function estimateSpeechMs(text) {
  const value = String(text || '').trim();
  if (!value) return 0;
  const cjk = (value.match(/[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/g) || []).length;
  const words = value
    .replace(/[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/g, ' ')
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  return Math.max(1200, Math.round(words * 400 + cjk * 150));
}

/** True when `win` can speak through `speechSynthesis`. */
export function speechSynthesisSupported(win) {
  return Boolean(win && win.speechSynthesis && typeof win.SpeechSynthesisUtterance === 'function');
}

/** The AudioContext constructor (or the webkit prefix), or null. */
export function audioContextCtor(win) {
  if (!win) return null;
  return win.AudioContext || win.webkitAudioContext || null;
}

/** RMS of byte time-domain samples (0..255 centred on 128) → 0..1. */
function byteRms(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 3);
}

/** decodeAudioData in both its promise and (older Safari) callback forms. */
function decodeAudio(ctx, bytes) {
  return new Promise((resolve, reject) => {
    try {
      const pending = ctx.decodeAudioData(bytes, resolve, reject);
      if (pending && typeof pending.then === 'function') pending.then(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

class FallbackSignal {
  constructor(reason) {
    this.reason = reason;
  }
}

/**
 * @param {import('./speech-player.d.ts').KbSpeechPlayerOptions} [options]
 * @returns {import('./speech-player.d.ts').KbSpeechPlayer}
 */
export function createSpeechPlayer(options = {}) {
  const win =
    options.win || (typeof globalThis.window !== 'undefined' ? globalThis.window : undefined);
  const fetchImpl =
    options.fetchImpl || (win && typeof win.fetch === 'function' ? win.fetch.bind(win) : null);
  const synthesizeUrl = typeof options.synthesizeUrl === 'string' ? options.synthesizeUrl : '';
  const onState = typeof options.onState === 'function' ? options.onState : noop;
  const onLevel = typeof options.onLevel === 'function' ? options.onLevel : null;
  const raf =
    options.raf ||
    (win && typeof win.requestAnimationFrame === 'function'
      ? win.requestAnimationFrame.bind(win)
      : null);
  const caf =
    options.caf ||
    (win && typeof win.cancelAnimationFrame === 'function'
      ? win.cancelAnimationFrame.bind(win)
      : noop);
  const timers = options.timers || {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  let lipsync = options.lipsync || null;
  let defaultLang = typeof options.lang === 'string' ? options.lang : '';

  let generation = 0;
  let disposed = false;
  let ctx = null;
  /** The active utterance: `{ gen, mode, started, cancel() }`. */
  let current = null;
  let host = null;
  let lastState = 'idle';
  let lastMode = null;

  const setState = (state, mode, detail = {}) => {
    if (state === lastState && mode === lastMode) return;
    lastState = state;
    lastMode = mode;
    safeCall(onState, state, { mode, ...detail });
  };

  const isCurrent = (gen) => !disposed && gen === generation;

  const ensureContext = () => {
    if (ctx) return ctx;
    const Ctor = audioContextCtor(win);
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      ctx = null;
    }
    return ctx;
  };

  const levelLoop = (analyser) => {
    if (!onLevel || !raf || typeof analyser.getByteTimeDomainData !== 'function') return noop;
    const buffer = new Uint8Array(analyser.fftSize || 1024);
    let handle = null;
    let running = true;
    const frame = () => {
      if (!running) return;
      analyser.getByteTimeDomainData(buffer);
      safeCall(onLevel, byteRms(buffer));
      handle = raf(frame);
    };
    handle = raf(frame);
    return () => {
      running = false;
      if (handle !== null) caf(handle);
      safeCall(onLevel, 0);
    };
  };

  async function playBrowserAudio(text, lang, gen) {
    if (!synthesizeUrl || !fetchImpl) throw new FallbackSignal('synthesis_unconfigured');
    if (!audioContextCtor(win)) throw new FallbackSignal('no_audio_context');
    const Abort = win && win.AbortController;
    const abort = typeof Abort === 'function' ? new Abort() : null;
    let resolveCancelled = noop;
    const cancelled = new Promise((resolve) => {
      resolveCancelled = resolve;
    });
    const cancelledResult = { mode: 'browser-audio', ok: false, cancelled: true };
    current = {
      gen,
      mode: 'browser-audio',
      started: false,
      cancel: () => {
        if (abort) abort.abort();
        resolveCancelled(cancelledResult);
      },
    };
    const race = (promise) => Promise.race([promise, cancelled]);
    setState('loading', 'browser-audio');

    let response;
    try {
      response = await race(
        fetchImpl(synthesizeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(lang ? { text, language: lang } : { text }),
          cache: 'no-store',
          credentials: 'same-origin',
          ...(abort ? { signal: abort.signal } : {}),
        })
      );
    } catch {
      if (!isCurrent(gen)) return cancelledResult;
      throw new FallbackSignal('synthesis_network');
    }
    if (!isCurrent(gen) || response === cancelledResult) return cancelledResult;
    if (!response.ok) throw new FallbackSignal(`synthesis_http_${response.status}`);
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (!contentType.startsWith('audio/')) throw new FallbackSignal('synthesis_not_audio');
    const engineId = response.headers.get('x-kyberion-speech-engine') || undefined;

    let bytes;
    try {
      bytes = await race(response.arrayBuffer());
    } catch {
      if (!isCurrent(gen)) return cancelledResult;
      throw new FallbackSignal('synthesis_network');
    }
    if (!isCurrent(gen) || bytes === cancelledResult) return cancelledResult;

    const audioCtx = ensureContext();
    if (!audioCtx) throw new FallbackSignal('no_audio_context');
    if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
      await race(Promise.resolve(audioCtx.resume()).catch(noop));
      if (!isCurrent(gen)) return cancelledResult;
      // Autoplay policy: without a user gesture the context stays suspended
      // and a started source would never end — fall back instead.
      if (audioCtx.state === 'suspended') throw new FallbackSignal('audio_context_suspended');
    }

    let buffer;
    try {
      buffer = await race(decodeAudio(audioCtx, bytes));
    } catch {
      if (!isCurrent(gen)) return cancelledResult;
      throw new FallbackSignal('decode_failed');
    }
    if (!isCurrent(gen) || buffer === cancelledResult) return cancelledResult;

    const source = audioCtx.createBufferSource();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.buffer = buffer;
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
    const durationMs = Math.round((Number(buffer.duration) || 0) * 1000);

    return new Promise((resolve) => {
      let done = false;
      let guard = null;
      let stopLevels = noop;
      const finish = (wasCancelled) => {
        if (done) return;
        done = true;
        if (guard !== null) timers.clearTimeout(guard);
        stopLevels();
        safeCall(lipsync && lipsync.detachAnalyser && lipsync.detachAnalyser.bind(lipsync));
        source.onended = null;
        try {
          source.stop();
        } catch {
          // Already stopped (ended naturally).
        }
        try {
          source.disconnect();
          analyser.disconnect();
        } catch {
          // Nodes already disconnected.
        }
        if (current && current.gen === gen) current = null;
        if (!wasCancelled) setState('idle', 'browser-audio');
        resolve({
          mode: 'browser-audio',
          ok: !wasCancelled,
          ...(wasCancelled ? { cancelled: true } : {}),
          durationMs,
          ...(engineId ? { engineId } : {}),
        });
      };
      current = { gen, mode: 'browser-audio', started: true, cancel: () => finish(true) };
      source.onended = () => finish(false);
      guard = timers.setTimeout(() => finish(false), durationMs + AUDIO_END_GRACE_MS);
      safeCall(lipsync && lipsync.attachAnalyser && lipsync.attachAnalyser.bind(lipsync), analyser);
      stopLevels = levelLoop(analyser);
      setState('speaking', 'browser-audio');
      try {
        source.start(0);
      } catch {
        finish(false);
      }
    });
  }

  function playSpeechSynthesis(text, lang, rate, gen, fallbackReason) {
    const extra = fallbackReason ? { fallbackReason } : {};
    if (!speechSynthesisSupported(win)) {
      return Promise.resolve({
        mode: 'none',
        ok: false,
        reason: 'no_speech_output',
        ...extra,
      });
    }
    const synth = win.speechSynthesis;
    return new Promise((resolve) => {
      let utterance;
      try {
        utterance = new win.SpeechSynthesisUtterance(text);
      } catch {
        resolve({ mode: 'none', ok: false, reason: 'no_speech_output', ...extra });
        return;
      }
      if (lang) utterance.lang = lang;
      if (Number.isFinite(rate) && rate > 0) utterance.rate = rate;
      let done = false;
      let guard = null;
      const entry = { gen, mode: 'speech-synthesis', started: false, cancel: () => finish(true) };
      const finish = (wasCancelled, error) => {
        if (done) return;
        done = true;
        if (guard !== null) timers.clearTimeout(guard);
        utterance.onstart = null;
        utterance.onend = null;
        utterance.onerror = null;
        utterance.onboundary = null;
        if (entry.started && !host) {
          safeCall(lipsync && lipsync.stopSynthetic && lipsync.stopSynthetic.bind(lipsync));
        }
        if (onLevel) safeCall(onLevel, 0);
        if (wasCancelled) {
          try {
            synth.cancel();
          } catch {
            // Nothing queued.
          }
        }
        if (current === entry) current = null;
        if (!wasCancelled) setState('idle', 'speech-synthesis');
        resolve({
          mode: 'speech-synthesis',
          ok: !wasCancelled && !error,
          ...(wasCancelled ? { cancelled: true } : {}),
          ...(error ? { reason: error } : {}),
          ...extra,
        });
      };
      current = entry;
      utterance.onstart = () => {
        if (done || current !== entry) return;
        entry.started = true;
        safeCall(lipsync && lipsync.startSynthetic && lipsync.startSynthetic.bind(lipsync));
        setState('speaking', 'speech-synthesis');
      };
      utterance.onboundary = () => {
        if (done || current !== entry) return;
        safeCall(lipsync && lipsync.pulse && lipsync.pulse.bind(lipsync));
      };
      utterance.onend = () => finish(false);
      utterance.onerror = (event) => {
        const code = event && typeof event.error === 'string' ? event.error : 'error';
        finish(false, `speech_synthesis_${code}`);
      };
      // Some engines never fire onend for long utterances; bound it.
      guard = timers.setTimeout(
        () => finish(false, 'speech_synthesis_timeout'),
        estimateSpeechMs(text) * 2 + 10000
      );
      try {
        synth.cancel();
        synth.speak(utterance);
      } catch {
        finish(false, 'speech_synthesis_error');
      }
    });
  }

  const cancelCurrent = () => {
    const active = current;
    current = null;
    if (active) active.cancel();
  };

  const endHost = (emit) => {
    if (!host) return;
    if (host.guard !== null) timers.clearTimeout(host.guard);
    host = null;
    // A browser utterance still animating keeps its synthetic motion.
    if (!(current && current.mode === 'speech-synthesis' && current.started)) {
      safeCall(lipsync && lipsync.stopSynthetic && lipsync.stopSynthetic.bind(lipsync));
    }
    if (emit && !current) setState('idle', 'host');
  };

  return {
    async speak(text, opts = {}) {
      const value = String(text || '').trim();
      if (disposed) return { mode: 'none', ok: false, reason: 'disposed' };
      generation += 1;
      const gen = generation;
      cancelCurrent();
      if (!value) {
        setState('idle', null);
        return { mode: 'none', ok: false, reason: 'empty_text' };
      }
      const lang = typeof opts.lang === 'string' && opts.lang ? opts.lang : defaultLang;
      const rate = Number(opts.rate);
      let fallbackReason;
      if (opts.via !== 'speech-synthesis') {
        try {
          return await playBrowserAudio(value, lang, gen);
        } catch (error) {
          if (!(error instanceof FallbackSignal)) throw error;
          if (!isCurrent(gen)) return { mode: 'browser-audio', ok: false, cancelled: true };
          fallbackReason = error.reason;
          if (current && current.gen === gen) current = null;
        }
      }
      if (!isCurrent(gen)) return { mode: 'speech-synthesis', ok: false, cancelled: true };
      const result = await playSpeechSynthesis(value, lang, rate, gen, fallbackReason);
      if (result.mode === 'none') setState('idle', null);
      return result;
    },

    followHostSpeech(input = {}) {
      if (disposed) return { mode: 'host', active: false };
      if (!input.speaking) {
        endHost(true);
        return { mode: 'host', active: false };
      }
      const estimated = Number(input.estimatedMs);
      const bound =
        Number.isFinite(estimated) && estimated > 0
          ? Math.min(HOST_MAX_MS, Math.round(estimated * 1.25) + HOST_GRACE_MS)
          : HOST_MAX_MS;
      if (host) {
        if (host.guard !== null) timers.clearTimeout(host.guard);
      } else {
        host = { guard: null };
        safeCall(lipsync && lipsync.startSynthetic && lipsync.startSynthetic.bind(lipsync));
      }
      host.guard = timers.setTimeout(() => endHost(true), bound);
      setState('speaking', 'host');
      return { mode: 'host', active: true, boundMs: bound };
    },

    /** Create / resume the AudioContext — call from a user gesture (autoplay policy). */
    async unlock() {
      if (disposed) return false;
      const audioCtx = ensureContext();
      if (!audioCtx) return false;
      if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
        await Promise.resolve(audioCtx.resume()).catch(noop);
      }
      return audioCtx.state !== 'suspended';
    },

    stop() {
      generation += 1;
      cancelCurrent();
      endHost(false);
      setState('idle', null);
    },

    setLipsync(next) {
      if (lipsync && lipsync !== next) {
        safeCall(lipsync.detachAnalyser && lipsync.detachAnalyser.bind(lipsync));
        safeCall(lipsync.stopSynthetic && lipsync.stopSynthetic.bind(lipsync));
      }
      lipsync = next || null;
    },

    setLang(next) {
      defaultLang = typeof next === 'string' ? next : '';
    },

    get state() {
      return lastState;
    },

    get mode() {
      return lastState === 'idle' ? null : lastMode;
    },

    dispose() {
      if (disposed) return;
      generation += 1;
      cancelCurrent();
      endHost(false);
      disposed = true;
      const audioCtx = ctx;
      ctx = null;
      if (audioCtx && typeof audioCtx.close === 'function') {
        Promise.resolve()
          .then(() => audioCtx.close())
          .catch(noop);
      }
      if (lastState !== 'idle') {
        lastState = 'idle';
        lastMode = null;
        safeCall(onState, 'idle', { mode: null });
      }
    },
  };
}
