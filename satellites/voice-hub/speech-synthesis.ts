/**
 * PA-09 return-audio mode for voice-hub (PADS_A2UI_AND_AVATAR_PLAN_2026-09-23 §6).
 *
 * `POST /api/speech/synthesize` synthesizes speech with the selected TTS
 * engine and returns the audio bytes (`audio/wav`) instead of playing them on
 * the host, so a browser can play the reply through Web Audio and drive the
 * talking avatar's mouth from an `AnalyserNode`. Host playback
 * (`speakReplyManaged` → `afplay` / `say`) stays the default path and is not
 * touched by this route.
 *
 * This module holds the side-effect-free contract (request validation, WAV
 * header parsing, the native "speak to file" command, the HTTP result shape)
 * and a handler whose engine work is injected, so the contract is testable
 * without spawning a TTS engine. `server.ts` wires the real engines.
 *
 * Contract:
 *   request  `{ text: string (1..SPEECH_SYNTHESIZE_MAX_TEXT_CHARS), language?: 'ja' | 'en' | BCP-47 }`
 *   200      body = WAV bytes; headers `Content-Type: audio/wav`,
 *            `Cache-Control: no-store`, `X-Kyberion-Speech-Engine`,
 *            `X-Kyberion-Speech-Duration-Ms` (from the WAV header),
 *            `X-Kyberion-Speech-Language`
 *   400      `{ ok: false, error: 'invalid_request', reason: 'invalid_body' }`
 *   413      `{ ok: false, error: 'text_too_long', max_chars }`
 *   429      `{ ok: false, error: 'synthesis_busy' }`
 *   501      `{ ok: false, error: 'synthesis_unsupported', reason }` — clients fall back
 *   502      `{ ok: false, error: 'synthesis_failed' | 'synthesis_artifact_invalid', reason }`
 */
import { isRecord } from '@agent/core/foundation';

/** Upper bound on the text one synthesize call accepts (characters). */
export const SPEECH_SYNTHESIZE_MAX_TEXT_CHARS = 2000;
/** Upper bound on the returned audio (bytes); larger artifacts are refused. */
export const SPEECH_SYNTHESIZE_MAX_AUDIO_BYTES = 24 * 1024 * 1024;
/** Concurrent synthesize calls; the next one gets 429 instead of queueing. */
export const SPEECH_SYNTHESIZE_MAX_IN_FLIGHT = 2;
/** Process timeout for a native "speak to file" run. */
export const NATIVE_TTS_FILE_TIMEOUT_MS = 60_000;

export const SPEECH_SYNTHESIS_HEADERS = Object.freeze({
  engine: 'X-Kyberion-Speech-Engine',
  durationMs: 'X-Kyberion-Speech-Duration-Ms',
  language: 'X-Kyberion-Speech-Language',
});

export type SpeechSynthesisLanguage = 'ja' | 'en';

export interface SpeechSynthesizeRequest {
  text: string;
  language?: SpeechSynthesisLanguage;
}

/** A request the route must reject before any engine work (400 / 413). */
export class SpeechSynthesisInputError extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly code: 'invalid_request' | 'text_too_long',
    message: string
  ) {
    super(message);
    this.name = 'SpeechSynthesisInputError';
  }
}

/** No engine on this host can produce audio bytes (→ 501, clients fall back). */
export class SpeechSynthesisUnsupportedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SpeechSynthesisUnsupportedError';
  }
}

const ALLOWED_REQUEST_KEYS = new Set(['text', 'language']);

/** Validate a synthesize request body; throws `SpeechSynthesisInputError`. */
export function readSpeechSynthesizeRequest(value: unknown): SpeechSynthesizeRequest {
  if (!isRecord(value)) {
    throw new SpeechSynthesisInputError(400, 'invalid_request', 'body must be a JSON object');
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      throw new SpeechSynthesisInputError(400, 'invalid_request', `unknown field: ${key}`);
    }
  }
  if (typeof value.text !== 'string' || !value.text.trim()) {
    throw new SpeechSynthesisInputError(400, 'invalid_request', 'text is required');
  }
  const text = value.text.trim();
  if (text.length > SPEECH_SYNTHESIZE_MAX_TEXT_CHARS) {
    throw new SpeechSynthesisInputError(
      413,
      'text_too_long',
      `text exceeds ${SPEECH_SYNTHESIZE_MAX_TEXT_CHARS} characters`
    );
  }
  if (value.language === undefined) return { text };
  const language = normalizeSpeechSynthesisLanguage(value.language);
  if (!language) {
    throw new SpeechSynthesisInputError(400, 'invalid_request', 'language must be ja or en');
  }
  return { text, language };
}

/** `ja`, `ja-JP`, `en`, `en-US`, … → `ja` | `en`; anything else → undefined. */
export function normalizeSpeechSynthesisLanguage(
  value: unknown
): SpeechSynthesisLanguage | undefined {
  if (typeof value !== 'string') return undefined;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  return primary === 'ja' || primary === 'en' ? primary : undefined;
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  durationMs: number;
}

/**
 * Parse a RIFF/WAVE header by walking its chunks (macOS `say` inserts an
 * `FLLR` padding chunk before `data`, so a fixed 44-byte header is wrong).
 * Returns undefined for anything that is not a PCM-describable WAVE file.
 */
export function parseWavInfo(bytes: Uint8Array): WavInfo | undefined {
  if (bytes.length < 12) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined;
  let offset = 12;
  let fmt: { channels: number; sampleRate: number; byteRate: number; bits: number } | undefined;
  let dataBytes: number | undefined;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      fmt = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        byteRate: view.getUint32(body + 8, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      // Streaming writers may leave 0 / 0xFFFFFFFF; trust the bytes present.
      const available = bytes.length - body;
      dataBytes = size === 0 || size === 0xffffffff || size > available ? available : size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || dataBytes === undefined || fmt.byteRate <= 0 || fmt.channels <= 0) return undefined;
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bits,
    dataBytes,
    durationMs: Math.round((dataBytes / fmt.byteRate) * 1000),
  };
}

/**
 * Bound on how long host speech of `text` lasts, for synthetic mouth motion
 * when no audio reaches the browser. `baseEstimateMs` is the word-based
 * `estimateSpeechDurationMs`, which undercounts unspaced Japanese; CJK
 * characters are counted at ~150 ms each.
 */
export function estimateSpokenDurationMs(text: string, baseEstimateMs: number): number {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/g) || []).length;
  return Math.max(baseEstimateMs, cjk * 150);
}

export interface NativeTtsFileOptions {
  voice?: string;
  rate?: number;
}

/**
 * The OS-native TTS command that writes WAV to `outputPath` instead of
 * playing it. macOS `say` and Linux `espeak` only; other platforms → null
 * (the route answers 501 so the browser falls back to speechSynthesis).
 */
export function buildNativeTtsFileCommand(
  platform: string,
  text: string,
  options: NativeTtsFileOptions,
  outputPath: string
): { cmd: string; args: string[] } | null {
  const safe = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  if (platform === 'darwin') {
    const args = ['-o', outputPath, '--file-format=WAVE', '--data-format=LEI16@22050'];
    if (options.voice) args.push('-v', options.voice);
    if (options.rate) args.push('-r', String(options.rate));
    // `--` keeps a reply that starts with "-" from being read as a flag.
    args.push('--', safe);
    return { cmd: 'say', args };
  }
  if (platform === 'linux') {
    const args = ['-w', outputPath];
    if (options.voice) args.push('-v', options.voice);
    if (options.rate) args.push('-s', String(options.rate));
    args.push('--', safe);
    return { cmd: 'espeak', args };
  }
  return null;
}

export interface SynthesizedArtifact {
  artifactPath: string;
  engineId: string;
}

export interface SpeechSynthesizeDeps {
  /** Run the selected engine (with its fallback) and return a WAV artifact path. */
  synthesize(text: string, language: SpeechSynthesisLanguage): Promise<SynthesizedArtifact>;
  readArtifact(artifactPath: string): Uint8Array;
  removeArtifact(artifactPath: string): void;
  detectLanguage(text: string): SpeechSynthesisLanguage;
  normalizeText(text: string, language: SpeechSynthesisLanguage): string;
  /** Called after a successful synthesis (echo-suppression bookkeeping). */
  onSynthesized?(result: { text: string; durationMs: number; engineId: string }): void;
  onError?(error: unknown): void;
}

export type SpeechSynthesizeResult =
  | { kind: 'audio'; status: 200; audio: Uint8Array; headers: Record<string, string> }
  | { kind: 'json'; status: number; body: Record<string, unknown> };

/** Reason codes are short snake_case identifiers (never free text). */
export const SPEECH_SYNTHESIS_REASON_PATTERN = /^[a-z0-9_]{1,80}$/u;

function jsonResult(status: number, body: Record<string, unknown>): SpeechSynthesizeResult {
  return { kind: 'json', status, body: { ok: false, ...body } };
}

/** Build the `POST /api/speech/synthesize` handler with a bounded in-flight count. */
export function createSpeechSynthesizeHandler(
  deps: SpeechSynthesizeDeps,
  options: { maxInFlight?: number } = {}
): (body: unknown) => Promise<SpeechSynthesizeResult> {
  const maxInFlight = options.maxInFlight ?? SPEECH_SYNTHESIZE_MAX_IN_FLIGHT;
  let inFlight = 0;
  return async (body) => {
    let request: SpeechSynthesizeRequest;
    try {
      request = readSpeechSynthesizeRequest(body);
    } catch (error) {
      if (error instanceof SpeechSynthesisInputError) {
        return error.code === 'text_too_long'
          ? jsonResult(413, {
              error: 'text_too_long',
              max_chars: SPEECH_SYNTHESIZE_MAX_TEXT_CHARS,
            })
          : jsonResult(400, { error: 'invalid_request', reason: 'invalid_body' });
      }
      throw error;
    }
    if (inFlight >= maxInFlight) return jsonResult(429, { error: 'synthesis_busy' });
    inFlight += 1;
    let artifactPath: string | undefined;
    try {
      const language = request.language ?? deps.detectLanguage(request.text);
      const normalized = deps.normalizeText(request.text, language);
      const artifact = await deps.synthesize(normalized, language);
      artifactPath = artifact.artifactPath;
      const audio = deps.readArtifact(artifactPath);
      if (audio.byteLength > SPEECH_SYNTHESIZE_MAX_AUDIO_BYTES) {
        return jsonResult(502, { error: 'synthesis_artifact_invalid', reason: 'audio_too_large' });
      }
      const wav = parseWavInfo(audio);
      if (!wav) {
        return jsonResult(502, { error: 'synthesis_artifact_invalid', reason: 'not_wav' });
      }
      deps.onSynthesized?.({
        text: normalized,
        durationMs: wav.durationMs,
        engineId: artifact.engineId,
      });
      return {
        kind: 'audio',
        status: 200,
        audio,
        headers: {
          'Content-Type': 'audio/wav',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          [SPEECH_SYNTHESIS_HEADERS.engine]: artifact.engineId,
          [SPEECH_SYNTHESIS_HEADERS.durationMs]: String(wav.durationMs),
          [SPEECH_SYNTHESIS_HEADERS.language]: language,
        },
      };
    } catch (error) {
      deps.onError?.(error);
      if (error instanceof SpeechSynthesisUnsupportedError) {
        return jsonResult(501, {
          error: 'synthesis_unsupported',
          reason: SPEECH_SYNTHESIS_REASON_PATTERN.test(error.reason) ? error.reason : 'unsupported',
        });
      }
      // Fixed reason code only: engine stderr / temp paths stay in the
      // server log (`onError`) and never reach a client.
      return jsonResult(502, { error: 'synthesis_failed', reason: 'engine_error' });
    } finally {
      inFlight -= 1;
      if (artifactPath) {
        try {
          deps.removeArtifact(artifactPath);
        } catch (removeError) {
          deps.onError?.(removeError);
        }
      }
    }
  };
}
