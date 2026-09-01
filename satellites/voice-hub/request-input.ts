import { parseEventScopeInput, type EventScopeInput } from '@agent/core/event-scope';

export type VoiceHubRequestBody = Record<string, unknown>;

export type VoiceBridgeResponse = {
  status: 'success' | 'error';
  text?: string;
  error?: string;
};

export type VoiceTranscriptionResponse = { text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reject JSON values that cannot represent a voice-hub request object. */
export function readVoiceHubRequestObject(value: unknown): VoiceHubRequestBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('request body must be a JSON object');
  }
  return value as VoiceHubRequestBody;
}

/** Parse an optional event scope before voice-hub performs any side effect. */
export function readVoiceHubEventScope(value: unknown): EventScopeInput | undefined {
  if (value === undefined) return undefined;
  return parseEventScopeInput(value);
}

/** Validate the small response contract emitted by managed voice bridges. */
export function parseVoiceBridgeResponse(value: unknown): VoiceBridgeResponse | undefined {
  if (!isRecord(value) || (value.status !== 'success' && value.status !== 'error')) {
    return undefined;
  }
  if (value.text !== undefined && typeof value.text !== 'string') return undefined;
  if (value.error !== undefined && typeof value.error !== 'string') return undefined;
  return {
    status: value.status,
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

/** Validate the response shape of an OpenAI-compatible transcription endpoint. */
export function parseVoiceTranscriptionResponse(
  value: unknown
): VoiceTranscriptionResponse | undefined {
  if (!isRecord(value) || typeof value.text !== 'string') return undefined;
  return { text: value.text };
}
