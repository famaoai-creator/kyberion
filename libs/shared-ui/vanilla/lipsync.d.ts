/**
 * Type declarations for `lipsync.js` (PA-09 lip-sync engine; plain JS +
 * JSDoc, no build step). Shared by `avatar.js` and the React renderer
 * (`src/avatar/*`). Cues follow the `AnimationCue` shape of
 * `libs/core/realtime-media-session.ts`; kept loose (no `@agent/core` types).
 */

export interface KbLipsyncCue {
  kind: string;
  payload: Record<string, number | string>;
  target_avatar_id?: string;
  audio_track_id?: string;
  at_ms?: number;
  duration_ms?: number;
  source?: string;
  provider_id?: string;
  confidence?: number;
}

export interface KbRmsFallbackCue {
  target_avatar_id: string;
  audio_track_id?: string;
  at_ms: number;
  duration_ms?: number;
  kind: 'blendshape';
  payload: { mouth_open: number };
  source: 'rms_fallback';
}

export interface KbAnalyserLike {
  fftSize?: number;
  getFloatTimeDomainData?(array: Float32Array): void;
  getByteTimeDomainData?(array: Uint8Array): void;
}

export interface KbLipsyncOptions {
  onMouth?: (openness: number) => void;
  onExpression?: (expression: string, cue: KbLipsyncCue) => void;
  now?: () => number;
  raf?: (callback: (time: number) => void) => unknown;
  caf?: (handle: unknown) => void;
  reducedMotion?: boolean;
  /** Cues for another `target_avatar_id` are ignored when set. */
  avatarId?: string;
  attack?: number;
  release?: number;
  gate?: number;
  gain?: number;
  cueHoldMs?: number;
}

export interface KbSyntheticOptions {
  wordsPerMinute?: number;
  seed?: number;
}

export interface KbLipsync {
  setLevel(level: number): void;
  attachAnalyser(node: KbAnalyserLike): () => void;
  detachAnalyser(): void;
  applyCue(cue: KbLipsyncCue): boolean;
  startSynthetic(options?: KbSyntheticOptions): void;
  stopSynthetic(): void;
  pulse(): void;
  cueFromLevel(level: number, atMs?: number): KbRmsFallbackCue;
  value(): number;
  running(): boolean;
  dispose(): void;
}

export interface KbSyntheticEnvelope {
  level(timeMs: number): number;
  pulse(timeMs: number): void;
}

export declare const KB_LIPSYNC_DEFAULTS: Readonly<{
  attack: number;
  release: number;
  gate: number;
  gain: number;
  cueHoldMs: number;
  reducedScale: number;
  reducedAttack: number;
  wordsPerMinute: number;
}>;
export declare const KB_VISEME_OPENNESS: Readonly<Record<string, number>>;
export declare const KB_AZURE_VISEME_CANONICAL: readonly string[];

export declare function clamp01(value: unknown): number;
export declare function visemeOpenness(payload: unknown, providerId?: string): number | null;
export declare function timeDomainRms(samples: ArrayLike<number>, float: boolean): number;
export declare function smoothToward(
  current: number,
  target: number,
  dtMs: number,
  attack: number,
  release: number
): number;
export declare function seededRandom(seed: number): () => number;
export declare function createSyntheticEnvelope(
  options?: KbSyntheticOptions & { startMs?: number }
): KbSyntheticEnvelope;
export declare function cueFromLevel(
  level: number,
  atMs: number,
  options?: { targetAvatarId?: string; audioTrackId?: string; durationMs?: number }
): KbRmsFallbackCue;
export declare function createLipsync(options?: KbLipsyncOptions): KbLipsync;
