/**
 * Type declarations for `speech-player.js` (PA-09 talking-avatar audio path;
 * plain JS + JSDoc, no build step). Kept loose (no `@agent/core` types) like
 * `voice-controller.d.ts`.
 */

export type KbSpeechMode = 'browser-audio' | 'speech-synthesis' | 'host' | 'none';
export type KbSpeechPlayerState = 'idle' | 'loading' | 'speaking';

export declare const KB_SPEECH_MODES: readonly KbSpeechMode[];
export declare const KB_SPEECH_PLAYER_STATES: readonly KbSpeechPlayerState[];

export declare function estimateSpeechMs(text: unknown): number;
export declare function speechSynthesisSupported(win: unknown): boolean;
export declare function audioContextCtor(win: unknown): (new () => unknown) | null;

/**
 * The subset of the `lipsync.js` controller the player drives (all optional).
 * Method syntax on purpose: a `ui:talking-avatar` controller
 * (`attachAnalyser(node: KbAnalyserLike)`) must be assignable as is.
 */
export interface KbSpeechLipsyncLike {
  attachAnalyser?(analyser: unknown): unknown;
  detachAnalyser?(): void;
  startSynthetic?(opts?: { wordsPerMinute?: number; seed?: number }): void;
  stopSynthetic?(): void;
  pulse?(): void;
}

export interface KbSpeechTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface KbSpeechPlayerOptions {
  win?: unknown;
  /** Same-origin surface proxy of voice-hub `/api/speech/synthesize`; empty = speechSynthesis only. */
  synthesizeUrl?: string;
  fetchImpl?: (input: string, init?: Record<string, unknown>) => Promise<Response>;
  onState?: (
    state: KbSpeechPlayerState,
    detail: { mode: KbSpeechMode | null; [key: string]: unknown }
  ) => void;
  /** Output loudness 0..1 per animation frame while browser audio plays. */
  onLevel?: (level: number) => void;
  lipsync?: KbSpeechLipsyncLike | null;
  /** BCP-47 language for speechSynthesis and the synthesis language hint. */
  lang?: string;
  raf?: (fn: (time: number) => void) => unknown;
  caf?: (handle: unknown) => void;
  timers?: KbSpeechTimers;
}

export interface KbSpeakOptions {
  lang?: string;
  /** speechSynthesis rate. */
  rate?: number;
  /** 'speech-synthesis' skips the server audio path. Default: try browser audio first. */
  via?: 'auto' | 'speech-synthesis';
}

export interface KbSpeakResult {
  mode: KbSpeechMode;
  ok: boolean;
  cancelled?: boolean;
  /** Why the utterance failed ('no_speech_output', 'speech_synthesis_<code>', …). */
  reason?: string;
  /** Why browser audio was skipped before falling back ('synthesis_http_501', …). */
  fallbackReason?: string;
  /** Decoded audio length (browser-audio). */
  durationMs?: number;
  /** voice-hub TTS engine (browser-audio, from `X-Kyberion-Speech-Engine`). */
  engineId?: string;
}

export interface KbFollowHostSpeechInput {
  speaking: boolean;
  /** voice-hub `speech_state.estimated_ms`; bounds the synthetic motion. */
  estimatedMs?: number;
}

export interface KbSpeechPlayer {
  speak(text: string, opts?: KbSpeakOptions): Promise<KbSpeakResult>;
  followHostSpeech(input: KbFollowHostSpeechInput): {
    mode: 'host';
    active: boolean;
    boundMs?: number;
  };
  /** Create / resume the AudioContext from a user gesture (autoplay policy). */
  unlock(): Promise<boolean>;
  stop(): void;
  setLipsync(lipsync: KbSpeechLipsyncLike | null): void;
  setLang(lang: string): void;
  readonly state: KbSpeechPlayerState;
  readonly mode: KbSpeechMode | null;
  dispose(): void;
}

export declare function createSpeechPlayer(options?: KbSpeechPlayerOptions): KbSpeechPlayer;
