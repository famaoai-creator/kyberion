/* global requestAnimationFrame, cancelAnimationFrame, performance */
/*
 * Kyberion UI — lip-sync engine (PA-09, PADS_A2UI_AND_AVATAR_PLAN_2026-09-23
 * §6). Pure, dependency-free and deterministic with an injected clock /
 * requestAnimationFrame; shared by the vanilla (`avatar.js`) and React
 * (`src/avatar/*`) renderers of `ui:talking-avatar`.
 *
 * One mouth-openness value (0..1) is produced per animation frame from the
 * strongest of these sources:
 *   - `setLevel(level)`            host-driven loudness (persists until changed)
 *   - `attachAnalyser(node)`       time-domain RMS of an `AnalyserNode` the
 *                                   caller owns (the audio graph is never
 *                                   created, connected or closed here)
 *   - `applyCue(cue)`              `AnimationCue`-shaped objects
 *                                   (libs/core/realtime-media-session.ts):
 *                                   `blendshape` `mouth_open`, `viseme` via
 *                                   the canonical-viseme openness table,
 *                                   `expression` passed to `onExpression`
 *   - `startSynthetic()` / `pulse()` plausible motion without audio samples
 *                                   (host playback, `speechSynthesis`)
 * The value goes through a noise gate and fast-attack / slow-release
 * smoothing. The frame loop runs only while a source is active or the mouth
 * is still closing — it never spins idle.
 */

/** Smoothing, gate and hold defaults. */
export const KB_LIPSYNC_DEFAULTS = Object.freeze({
  /** Fraction of the gap closed per 60 Hz frame while opening. */
  attack: 0.6,
  /** Fraction of the gap closed per 60 Hz frame while closing. */
  release: 0.2,
  /** Raw levels below this are silence. */
  gate: 0.05,
  /** RMS → level multiplier for analyser samples (speech RMS is ~0.05..0.3). */
  gain: 3.2,
  /** How long a cue without `duration_ms` holds its openness. */
  cueHoldMs: 180,
  /** `reducedMotion`: amplitude scale and a gentler attack. */
  reducedScale: 0.55,
  reducedAttack: 0.3,
  /** Synthetic speech rate. */
  wordsPerMinute: 150,
});

/**
 * Canonical viseme (the `canonical_viseme` of `normalizeProviderViseme`) →
 * mouth openness 0..1.
 */
export const KB_VISEME_OPENNESS = Object.freeze({
  sil: 0,
  AA: 0.95,
  AI: 0.85,
  AU: 0.75,
  E: 0.6,
  ER: 0.45,
  I: 0.4,
  U: 0.35,
  OW: 0.6,
  O: 0.7,
  A: 0.85,
  R: 0.4,
  L: 0.45,
  S: 0.25,
  SH: 0.35,
  TH: 0.3,
  T: 0.3,
  K: 0.4,
  P: 0,
  N: 0.3,
  H: 0.5,
  F: 0.15,
});

/**
 * Azure viseme id → canonical viseme (mirrors `AZURE_VISEME_TO_CANONICAL`
 * in realtime-media-session.ts; pinned by tests). Used when a viseme cue from
 * Azure arrives without `canonical_viseme`.
 */
export const KB_AZURE_VISEME_CANONICAL = Object.freeze([
  'sil',
  'AA',
  'AI',
  'AU',
  'E',
  'ER',
  'I',
  'U',
  'OW',
  'O',
  'A',
  'R',
  'L',
  'S',
  'SH',
  'TH',
  'T',
  'K',
  'P',
  'N',
  'H',
  'F',
]);

/** Openness for an unknown non-silent viseme id. */
const UNKNOWN_VISEME_OPENNESS = 0.5;
const FRAME_MS = 1000 / 60;
const MAX_DT_MS = 100;
const EPSILON = 0.005;
const EMIT_STEP = 0.001;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Clamp to 0..1 (non-finite → 0). */
export function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Mouth openness of a viseme cue payload
 * (`{ provider_viseme_id, canonical_viseme? }`), or null when it names no
 * viseme. Unknown non-silent ids open half-way.
 */
export function visemeOpenness(payload, providerId) {
  if (!isRecord(payload)) return null;
  let canonical = typeof payload.canonical_viseme === 'string' ? payload.canonical_viseme : '';
  const id = Number(payload.provider_viseme_id);
  if (
    !canonical &&
    Number.isInteger(id) &&
    String(providerId || '')
      .trim()
      .toLowerCase() === 'azure'
  ) {
    canonical = KB_AZURE_VISEME_CANONICAL[id] || '';
  }
  if (canonical && Object.prototype.hasOwnProperty.call(KB_VISEME_OPENNESS, canonical)) {
    return KB_VISEME_OPENNESS[canonical];
  }
  if (Number.isInteger(id) && id >= 0) return id === 0 ? 0 : UNKNOWN_VISEME_OPENNESS;
  return null;
}

/**
 * RMS (0..1) of time-domain samples: a Float32Array (-1..1, from
 * `getFloatTimeDomainData`) or bytes (0..255 centred on 128).
 */
export function timeDomainRms(samples, float) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = float ? samples[i] : (samples[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * One smoothing step: move `current` toward `target`, closing `attack`
 * (opening) or `release` (closing) of the gap per 60 Hz frame, scaled to
 * `dtMs` so the curve does not depend on the frame rate.
 */
export function smoothToward(current, target, dtMs, attack, release) {
  const rate = target > current ? attack : release;
  const frames = Math.max(0, dtMs) / FRAME_MS;
  const k = 1 - Math.pow(1 - clamp01(rate), frames);
  return current + (target - current) * k;
}

/** Deterministic PRNG (mulberry32) → () => 0..1. */
export function seededRandom(seed) {
  let a = Number.isFinite(Number(seed)) ? Number(seed) >>> 0 : 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthetic speech envelope: syllables (≈1.4 per word) with random length
 * and loudness and short gaps between words. `level(tMs)` must be called
 * with non-decreasing times; `pulse(tMs)` (a word boundary) starts a new
 * loud syllable at `tMs`.
 * @param {{ wordsPerMinute?: number, seed?: number, startMs?: number }} [options]
 */
export function createSyntheticEnvelope(options = {}) {
  const wpm = Number(options.wordsPerMinute);
  const rate =
    Number.isFinite(wpm) && wpm >= 40 && wpm <= 400 ? wpm : KB_LIPSYNC_DEFAULTS.wordsPerMinute;
  const syllableMs = 60000 / (rate * 1.4);
  const random = seededRandom(options.seed ?? 1);
  let start = Number(options.startMs) || 0;
  let duration = 0;
  let amp = 0;
  let gap = false;
  const next = (at, loud) => {
    start = at;
    if (!loud && !gap && random() < 0.28) {
      // Between words: a short closed pause.
      gap = true;
      duration = syllableMs * (0.3 + 0.4 * random());
      amp = 0;
      return;
    }
    gap = false;
    duration = syllableMs * (0.7 + 0.6 * random());
    amp = loud ? 0.75 + 0.2 * random() : 0.4 + 0.5 * random();
  };
  next(start, false);
  return {
    level(tMs) {
      let guard = 0;
      while (tMs >= start + duration && guard < 1000) {
        next(start + duration, false);
        guard += 1;
      }
      if (amp === 0 || tMs < start) return 0;
      const phase = (tMs - start) / duration;
      return amp * Math.pow(Math.sin(Math.PI * phase), 0.8);
    },
    pulse(tMs) {
      next(tMs, true);
    },
  };
}

/**
 * An rms_fallback `AnimationCue` (the shape `createRmsFallbackAnimationCue`
 * returns) for a level.
 * @param {number} level
 * @param {number} atMs
 * @param {{ targetAvatarId?: string, audioTrackId?: string, durationMs?: number }} [options]
 */
export function cueFromLevel(level, atMs, options = {}) {
  const at = Number(atMs);
  const duration = Number(options.durationMs);
  return {
    target_avatar_id:
      typeof options.targetAvatarId === 'string' && options.targetAvatarId.trim()
        ? options.targetAvatarId
        : 'avatar',
    ...(options.audioTrackId ? { audio_track_id: options.audioTrackId } : {}),
    at_ms: Number.isFinite(at) ? Math.max(0, at) : 0,
    ...(Number.isFinite(duration) ? { duration_ms: Math.max(0, duration) } : {}),
    kind: 'blendshape',
    payload: { mouth_open: clamp01(level) },
    source: 'rms_fallback',
  };
}

function defaultNow() {
  const perf = typeof performance !== 'undefined' ? performance : undefined;
  return perf && typeof perf.now === 'function' ? perf.now() : Date.now();
}

function defaultRaf() {
  if (typeof requestAnimationFrame === 'function') return (cb) => requestAnimationFrame(cb);
  return (cb) => setTimeout(() => cb(defaultNow()), FRAME_MS);
}

function defaultCaf() {
  if (typeof cancelAnimationFrame === 'function') return (h) => cancelAnimationFrame(h);
  return (h) => clearTimeout(h);
}

/**
 * @param {{
 *   onMouth?: (openness: number) => void,
 *   onExpression?: (expression: string, cue: object) => void,
 *   now?: () => number,
 *   raf?: (cb: (t: number) => void) => unknown,
 *   caf?: (handle: unknown) => void,
 *   reducedMotion?: boolean,
 *   avatarId?: string,
 *   attack?: number, release?: number, gate?: number, gain?: number, cueHoldMs?: number,
 * }} [options]
 */
export function createLipsync(options = {}) {
  const D = KB_LIPSYNC_DEFAULTS;
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const now = typeof options.now === 'function' ? options.now : defaultNow;
  const raf = typeof options.raf === 'function' ? options.raf : defaultRaf();
  const caf = typeof options.caf === 'function' ? options.caf : defaultCaf();
  const reduced = options.reducedMotion === true;
  const attack = reduced
    ? Math.min(num(options.attack, D.attack), D.reducedAttack)
    : num(options.attack, D.attack);
  const release = num(options.release, D.release);
  const gate = clamp01(num(options.gate, D.gate));
  const gain = num(options.gain, D.gain);
  const hold = Math.max(0, num(options.cueHoldMs, D.cueHoldMs));
  const scale = reduced ? D.reducedScale : 1;
  const avatarId = typeof options.avatarId === 'string' ? options.avatarId : '';

  let value = 0;
  let emitted = 0;
  let host = 0;
  let cueLevel = 0;
  let cueUntil = -Infinity;
  let analyser = null;
  let samples = null;
  let floatSamples = false;
  let synthetic = null;
  let handle = null;
  let last = null;
  let disposed = false;

  const emit = (next) => {
    if (typeof options.onMouth === 'function') options.onMouth(next);
  };

  const analyserLevel = () => {
    if (!analyser || !samples) return 0;
    try {
      if (floatSamples) analyser.getFloatTimeDomainData(samples);
      else analyser.getByteTimeDomainData(samples);
    } catch {
      return 0;
    }
    return clamp01(timeDomainRms(samples, floatSamples) * gain);
  };

  const active = (t) =>
    (host >= gate && host > 0) || analyser !== null || synthetic !== null || t < cueUntil;

  const target = (t) => {
    let raw = host;
    const fromAnalyser = analyserLevel();
    if (fromAnalyser > raw) raw = fromAnalyser;
    if (t < cueUntil && cueLevel > raw) raw = cueLevel;
    if (synthetic) {
      const s = synthetic.level(t);
      if (s > raw) raw = s;
    }
    return raw < gate ? 0 : raw * scale;
  };

  const frame = () => {
    handle = null;
    if (disposed) return;
    const t = now();
    const dt = last === null ? FRAME_MS : Math.min(MAX_DT_MS, Math.max(0, t - last));
    last = t;
    const goal = target(t);
    let next = smoothToward(value, goal, dt, attack, release);
    if (goal === 0 && next < EPSILON) next = 0;
    value = next;
    // Emit visible changes only (the closed mouth always lands on exactly 0).
    if (Math.abs(value - emitted) >= EMIT_STEP || (value === 0 && emitted !== 0)) {
      emitted = value;
      emit(value);
    }
    if (active(t) || value > 0) {
      handle = raf(frame);
    } else {
      last = null;
    }
  };

  const ensure = () => {
    if (disposed || handle !== null) return;
    handle = raf(frame);
  };

  const detachAnalyser = () => {
    analyser = null;
    samples = null;
  };

  return {
    /** Host-driven loudness 0..1 (persists until changed; 0 releases). */
    setLevel(level) {
      if (disposed) return;
      host = clamp01(level);
      ensure();
    },
    /**
     * Read time-domain RMS from `node` every frame. The caller owns the audio
     * graph; `detachAnalyser` (or the returned function) only stops reading.
     */
    attachAnalyser(node) {
      if (disposed || !node) return () => {};
      const hasFloat = typeof node.getFloatTimeDomainData === 'function';
      const hasByte = typeof node.getByteTimeDomainData === 'function';
      if (!hasFloat && !hasByte) return () => {};
      const size = Number(node.fftSize) > 0 ? Number(node.fftSize) : 2048;
      analyser = node;
      floatSamples = hasFloat;
      samples = hasFloat ? new Float32Array(size) : new Uint8Array(size);
      ensure();
      return () => {
        if (analyser === node) detachAnalyser();
      };
    },
    detachAnalyser,
    /**
     * Apply an `AnimationCue`-shaped object; true when it moved the mouth or
     * the expression. Cues for another `target_avatar_id` (when `avatarId`
     * is set) are ignored.
     */
    applyCue(cue) {
      if (disposed || !isRecord(cue) || !isRecord(cue.payload)) return false;
      if (avatarId && typeof cue.target_avatar_id === 'string' && cue.target_avatar_id !== avatarId)
        return false;
      if (cue.kind === 'expression') {
        const name =
          typeof cue.payload.expression === 'string' ? cue.payload.expression : cue.payload.name;
        if (typeof name !== 'string' || !name) return false;
        if (typeof options.onExpression === 'function') options.onExpression(name, cue);
        return true;
      }
      let openness = null;
      if (cue.kind === 'blendshape') {
        const raw = cue.payload.mouth_open ?? cue.payload.jaw_open;
        if (raw !== undefined && Number.isFinite(Number(raw))) openness = clamp01(raw);
      } else if (cue.kind === 'viseme') {
        openness = visemeOpenness(cue.payload, cue.provider_id);
      }
      if (openness === null) return false;
      const duration = Number(cue.duration_ms);
      cueLevel = openness;
      cueUntil = now() + (Number.isFinite(duration) && duration > 0 ? duration : hold);
      ensure();
      return true;
    },
    /** Plausible mouth motion while speech plays without audio samples. */
    startSynthetic(opts = {}) {
      if (disposed) return;
      synthetic = createSyntheticEnvelope({
        wordsPerMinute: opts.wordsPerMinute,
        seed: opts.seed,
        startMs: now(),
      });
      ensure();
    },
    stopSynthetic() {
      synthetic = null;
      if (!disposed && value > 0) ensure();
    },
    /** A word boundary (e.g. `SpeechSynthesisUtterance.onboundary`). */
    pulse() {
      if (disposed) return;
      const t = now();
      if (synthetic) synthetic.pulse(t);
      else {
        cueLevel = 0.8;
        cueUntil = t + hold;
      }
      ensure();
    },
    /** The rms_fallback cue shape for a level (for relaying to other avatars). */
    cueFromLevel(level, atMs) {
      return cueFromLevel(level, atMs ?? now(), { targetAvatarId: avatarId || undefined });
    },
    /** Current smoothed openness. */
    value() {
      return value;
    },
    /** True while a frame is scheduled. */
    running() {
      return handle !== null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (handle !== null) caf(handle);
      handle = null;
      synthetic = null;
      host = 0;
      cueUntil = -Infinity;
      detachAnalyser();
    },
  };
}
