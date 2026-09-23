/**
 * Type declarations for `voice-controller.js` (PA-02 `ui:voice-input` audio
 * plumbing; plain JS + JSDoc, no build step). Kept loose (no `@agent/core`
 * types) like `forms.d.ts`.
 */

export type KbVoiceInputState =
  'idle' | 'requesting' | 'listening' | 'recording' | 'processing' | 'error' | 'unsupported';

export type KbVoiceErrorCode =
  'permission_denied' | 'not_supported' | 'no_speech' | 'network' | 'aborted' | 'unknown';

export declare const KB_VOICE_INPUT_STATES: readonly KbVoiceInputState[];
export declare const KB_VOICE_ERROR_CODES: readonly KbVoiceErrorCode[];
export declare const KB_VOICE_RECORDER_TYPES: readonly string[];
/** Continuous dictation: self-ended recognitions restarted in a row before giving up. */
export declare const KB_VOICE_MAX_RESTARTS: number;

export declare function voiceLang(lang: unknown, locale: unknown): string;
export declare function formatElapsed(ms: number): string;
export declare function speechRecognitionCtor(win: unknown): (new () => unknown) | null;
export declare function voiceSupported(win: unknown, mode: unknown): boolean | null;
export declare function pickRecorderType(win: unknown): string;
export declare function voiceErrorCode(error: unknown): KbVoiceErrorCode;
export declare function rmsLevel(samples: ArrayLike<number> | null | undefined): number;

export interface KbVoiceTimers {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export interface KbVoiceControllerOptions {
  win?: unknown;
  mode?: 'dictation' | 'record';
  /** BCP-47 recognition language (dictation). */
  lang?: string;
  /** Dictation: keep listening; a recognition that ends on its own is restarted (bounded). */
  continuous?: boolean;
  /** Open an AnalyserNode level meter on the mic stream (default true). */
  meter?: boolean;
  /**
   * Record mode: deliver one complete, independently decodable file per
   * chunk of this many ms (the recorder restarts on the same stream).
   */
  chunkMs?: number;
  /** Stop automatically after this many seconds. */
  maxSeconds?: number;
  now?: () => number;
  raf?: (fn: (time: number) => void) => unknown;
  caf?: (handle: unknown) => void;
  timers?: KbVoiceTimers;
  onState?: (state: KbVoiceInputState, detail: { error: KbVoiceErrorCode | null }) => void;
  onLevel?: (level: number) => void;
  onElapsed?: (ms: number) => void;
  onTranscript?: (result: { text: string; final: boolean }) => void;
  onRecording?: (result: {
    file: Blob;
    /** Duration of this file (the chunk, or the whole recording). */
    durationMs: number;
    /** Start of this file relative to the start of the recording. */
    offsetMs: number;
    final: boolean;
  }) => void;
  onError?: (code: KbVoiceErrorCode) => void;
}

export interface KbVoiceController {
  readonly state: KbVoiceInputState;
  readonly error: KbVoiceErrorCode | null;
  readonly mode: 'dictation' | 'record';
  readonly supported: boolean | null;
  /** Live resources (tests / diagnostics). */
  readonly resources: {
    stream: unknown;
    audioContext: unknown;
    recognition: unknown;
    recorder: unknown;
    rafHandle: unknown;
    ticker: unknown;
  };
  /** Open the microphone; call only from a user action. */
  start(): Promise<void>;
  /** Finish gracefully (final transcript / final file), releasing the mic. */
  stop(): void;
  /** Release everything; no further callbacks. */
  dispose(): void;
}

export declare function createVoiceController(
  options?: KbVoiceControllerOptions
): KbVoiceController;
