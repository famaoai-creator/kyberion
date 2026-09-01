import {
  parseIntentResolutionContract,
  type IntentResolutionContract,
} from '@agent/core/intent-resolution-contract-parser';
import { isRecord } from '@agent/core/foundation/primitives';

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
  /** Persisted voice-hub backend, when it is currently available. */
  selectedSttBackend?: string;
  inputDevices?: VoiceInputDevice[];
  speech?: VoiceSpeechState;
}

/** Response of voice-hub POST /api/stop-speaking. */
export interface VoiceStopResponse {
  ok: boolean;
  stopped: boolean;
  reason: string;
}

/** Browser-side request body for POST /api/voice/listen-once. */
export interface VoiceListenOnceRequest {
  /** STT backend id; omitted = persisted profile choice, 'auto' = policy order. */
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
  /** Shared intent/approval contract returned by the voice conversation path. */
  intentResolution?: IntentResolutionContract;
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

function optionalString(value: unknown): string | undefined {
  return value === undefined || typeof value === 'string' ? value : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function parseVoiceInputDevice(value: unknown): VoiceInputDevice | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== 'number' ||
    !Number.isInteger(value.id) ||
    value.id < 0 ||
    typeof value.uid !== 'string' ||
    !value.uid.trim() ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    typeof value.isDefault !== 'boolean'
  ) {
    return undefined;
  }
  return {
    id: value.id,
    uid: value.uid,
    name: value.name,
    isDefault: value.isDefault,
  };
}

export function parseVoiceInputDevices(value: unknown): VoiceInputDevice[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const devices = value.map(parseVoiceInputDevice);
  return devices.every((device): device is VoiceInputDevice => device !== undefined)
    ? devices
    : undefined;
}

export function parseVoiceSpeechState(value: unknown): VoiceSpeechState | undefined {
  if (!isRecord(value) || (value.status !== 'idle' && value.status !== 'speaking')) {
    return undefined;
  }
  const text = optionalString(value.text);
  const engineId = optionalString(value.engine_id);
  if (
    (text === undefined && value.text !== undefined) ||
    (engineId === undefined && value.engine_id !== undefined) ||
    (value.startedAt !== undefined && !isFiniteNumber(value.startedAt))
  ) {
    return undefined;
  }
  return {
    status: value.status,
    ...(text !== undefined ? { text } : {}),
    ...(value.startedAt !== undefined ? { startedAt: value.startedAt } : {}),
    ...(engineId !== undefined ? { engine_id: engineId } : {}),
  };
}

export function parseVoiceStatusResponse(value: unknown): VoiceStatusResponse | undefined {
  if (!isRecord(value) || typeof value.available !== 'boolean') return undefined;
  const sttBackends = value.sttBackends;
  if (
    sttBackends !== undefined &&
    (!Array.isArray(sttBackends) || sttBackends.some((backend) => typeof backend !== 'string'))
  ) {
    return undefined;
  }
  const selectedSttBackend = optionalString(value.selectedSttBackend);
  if (selectedSttBackend === undefined && value.selectedSttBackend !== undefined) return undefined;
  const inputDevices =
    value.inputDevices === undefined ? undefined : parseVoiceInputDevices(value.inputDevices);
  if (value.inputDevices !== undefined && inputDevices === undefined) return undefined;
  const speech = value.speech === undefined ? undefined : parseVoiceSpeechState(value.speech);
  if (value.speech !== undefined && speech === undefined) return undefined;
  return {
    available: value.available,
    ...(sttBackends !== undefined ? { sttBackends: [...sttBackends] as string[] } : {}),
    ...(selectedSttBackend !== undefined ? { selectedSttBackend } : {}),
    ...(inputDevices !== undefined ? { inputDevices } : {}),
    ...(speech !== undefined ? { speech } : {}),
  };
}

export function parseVoiceStopResponse(value: unknown): VoiceStopResponse | undefined {
  if (
    !isRecord(value) ||
    typeof value.ok !== 'boolean' ||
    typeof value.stopped !== 'boolean' ||
    typeof value.reason !== 'string' ||
    !value.reason.trim()
  ) {
    return undefined;
  }
  return { ok: value.ok, stopped: value.stopped, reason: value.reason };
}

export function parseVoiceListenOnceResponse(value: unknown): VoiceListenOnceResponse | undefined {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return undefined;
  const requestId = optionalString(value.request_id);
  const reason = optionalString(value.reason);
  const replyText = optionalString(value.replyText);
  const replyError = optionalString(value.replyError);
  const speechError = optionalString(value.speechError);
  const error = optionalString(value.error);
  if (
    (requestId === undefined && value.request_id !== undefined) ||
    (reason === undefined && value.reason !== undefined) ||
    (replyText === undefined && value.replyText !== undefined) ||
    (replyError === undefined && value.replyError !== undefined) ||
    (speechError === undefined && value.speechError !== undefined) ||
    (error === undefined && value.error !== undefined)
  ) {
    return undefined;
  }
  const ignored = value.ignored;
  const reflected = value.reflected;
  const replied = value.replied;
  const spoken = value.spoken;
  if (
    (ignored !== undefined && typeof ignored !== 'boolean') ||
    (reflected !== undefined && typeof reflected !== 'boolean') ||
    (replied !== undefined && typeof replied !== 'boolean') ||
    (spoken !== undefined && typeof spoken !== 'boolean')
  ) {
    return undefined;
  }
  let intentResolution: IntentResolutionContract | undefined;
  if (value.intentResolution !== undefined) {
    intentResolution = parseIntentResolutionContract(value.intentResolution);
    if (!intentResolution) return undefined;
  }
  let stt: VoiceListenOnceResponse['stt'];
  if (value.stt !== undefined) {
    if (!isRecord(value.stt)) return undefined;
    if (
      typeof value.stt.ok !== 'boolean' ||
      typeof value.stt.text !== 'string' ||
      typeof value.stt.locale !== 'string' ||
      typeof value.stt.backend !== 'string' ||
      typeof value.stt.is_final !== 'boolean' ||
      !isFiniteNumber(value.stt.elapsed_ms) ||
      (value.stt.device_id !== undefined && typeof value.stt.device_id !== 'string')
    ) {
      return undefined;
    }
    stt = {
      ok: value.stt.ok,
      text: value.stt.text,
      locale: value.stt.locale,
      backend: value.stt.backend,
      is_final: value.stt.is_final,
      ...(value.stt.device_id !== undefined ? { device_id: value.stt.device_id } : {}),
      elapsed_ms: value.stt.elapsed_ms,
    };
  }
  return {
    ok: value.ok,
    ...(requestId !== undefined ? { request_id: requestId } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(replyText !== undefined ? { replyText } : {}),
    ...(replyError !== undefined ? { replyError } : {}),
    ...(speechError !== undefined ? { speechError } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(ignored !== undefined ? { ignored } : {}),
    ...(reflected !== undefined ? { reflected } : {}),
    ...(replied !== undefined ? { replied } : {}),
    ...(spoken !== undefined ? { spoken } : {}),
    ...(intentResolution ? { intentResolution } : {}),
    ...(stt ? { stt } : {}),
  };
}
