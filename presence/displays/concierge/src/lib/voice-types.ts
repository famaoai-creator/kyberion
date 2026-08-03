/**
 * Shared request/response contract for the CS-02 voice tiers. Used by the
 * /api/voice/* proxy routes (server) and the use-voice hook (client) so the
 * two sides cannot drift apart.
 *
 * The Tier-1 shapes mirror the voice-hub daemon
 * (satellites/voice-hub/server.ts): /health, /api/speech/state,
 * /api/stt/backends, /api/input-devices, /api/listen-once, /api/stop-speaking.
 */

/** One capture device as reported by voice-hub GET /api/input-devices. */
export interface VoiceInputDevice {
  id: number;
  uid: string;
  name: string;
  isDefault: boolean;
}

/** Server-side TTS playback state (voice-hub GET /api/speech/state). */
export interface VoiceSpeechState {
  status: 'idle' | 'speaking';
  text?: string;
  startedAt?: number;
  engine_id?: string;
}

/** Aggregated probe result returned by GET /api/voice/status. */
export interface VoiceStatusResponse {
  /** True only when the voice-hub /health probe answered ok within the timeout. */
  available: boolean;
  /** Available STT backend ids (e.g. 'mlx_whisper', 'native_speech'). */
  sttBackends?: string[];
  inputDevices?: VoiceInputDevice[];
  speech?: VoiceSpeechState;
}

/** Browser-side request body for POST /api/voice/listen-once. */
export interface VoiceListenOnceRequest {
  /** STT backend id; omitted = voice-hub 'auto' order. */
  backend?: string;
  /** Input device uid/name; omitted = server default device. */
  device?: string;
  /** BCP-47 speech locale, e.g. 'ja-JP' / 'en-US'. */
  locale?: string;
}

/**
 * Response of POST /api/voice/listen-once — the voice-hub JSON passed
 * through verbatim (satellites/voice-hub/server.ts processIngest body +
 * the stt block). `spoken: true` means the reply was ALREADY spoken by the
 * server-side TTS; the browser must not speak it again.
 */
export interface VoiceListenOnceResponse {
  ok: boolean;
  request_id?: string;
  /** Echo suppression: the capture heard our own TTS and was discarded. */
  ignored?: boolean;
  reason?: string;
  reflected?: boolean;
  replied?: boolean;
  /** The secretary reply text (already spoken server-side when spoken=true). */
  replyText?: string;
  replyError?: string;
  spoken?: boolean;
  speechError?: string;
  stt?: {
    ok: boolean;
    /** The transcript — shown as the user bubble (captions requirement). */
    text: string;
    locale: string;
    backend: string;
    is_final: boolean;
    device_id?: string;
    elapsed_ms: number;
  };
  error?: string;
}
