/**
 * Provider-neutral media session contracts.
 *
 * This is intentionally smaller than a provider SDK. It gives realtime
 * conversation, meeting intelligence, and avatar/presence projections one
 * event vocabulary while leaving transport, diarization, TTS, and rendering
 * to replaceable adapters.
 */

import type { AudioChunk, AudioFormat, TranscriptChunk } from './meeting-session-types.js';
import { isValidTenantSlug } from './entity-scope.js';

export const MEDIA_SESSION_MODES = [
  'assistant',
  'meeting_observer',
  'meeting_participant',
  'avatar_presence',
] as const;
export type MediaSessionMode = (typeof MEDIA_SESSION_MODES)[number];

export const MEDIA_PARTICIPANT_KINDS = ['human', 'agent', 'system'] as const;
export type MediaParticipantKind = (typeof MEDIA_PARTICIPANT_KINDS)[number];

export const SPEAKER_ATTRIBUTION_STATUSES = ['tentative', 'authoritative'] as const;
export type SpeakerAttributionStatus = (typeof SPEAKER_ATTRIBUTION_STATUSES)[number];

export const SPEAKER_ATTRIBUTION_SOURCES = ['caption', 'diarization', 'manual', 'unknown'] as const;
export type SpeakerAttributionSource = (typeof SPEAKER_ATTRIBUTION_SOURCES)[number];

export interface MediaParticipant {
  participant_id: string;
  kind: MediaParticipantKind;
  display_label?: string;
  /** Verified person reference only; never inferred from a speaker label. */
  person_ref?: string;
  voice_profile_id?: string;
  avatar_profile_id?: string;
}

export interface MediaSessionScope {
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
  mission_id?: string;
  task_id?: string;
  work_item_id?: string;
}

export interface MediaSessionDescriptor {
  session_id: string;
  mode: MediaSessionMode;
  participants: readonly MediaParticipant[];
  started_at?: string;
  scope?: MediaSessionScope;
}

export interface MediaEventBase {
  event_id: string;
  session_id: string;
  type: MediaEventType;
  /** Monotonic session clock. */
  at_ms: number;
  emitted_at: string;
  source: string;
  participant_id?: string;
  speaker_id?: string;
  confidence?: number;
}

export type MediaEventType =
  | 'session_started'
  | 'session_ended'
  | 'audio_frame'
  | 'speech_started'
  | 'speech_ended'
  | 'speaker_attribution'
  | 'transcript_delta'
  | 'transcript_final'
  | 'assistant_text_delta'
  | 'audio_output_delta'
  | 'animation_cue'
  | 'tool_request'
  | 'tool_result'
  | 'turn_completed'
  | 'error';

export interface MediaSessionLifecycleEvent extends MediaEventBase {
  type: 'session_started' | 'session_ended';
  reason?: string;
}

export interface MediaAudioFrameEvent extends MediaEventBase {
  type: 'audio_frame' | 'audio_output_delta';
  track_id: string;
  chunk: AudioChunk;
  direction: 'input' | 'output';
}

export interface MediaSpeechEvent extends MediaEventBase {
  type: 'speech_started' | 'speech_ended';
  segment_id: string;
  duration_ms?: number;
}

export interface SpeakerAttributionEvent extends MediaEventBase {
  type: 'speaker_attribution';
  segment_id: string;
  speaker_id: string;
  status: SpeakerAttributionStatus;
  attribution_source: SpeakerAttributionSource;
  speaker_label?: string;
  person_ref?: string;
}

export interface MediaTranscriptEvent extends MediaEventBase {
  type: 'transcript_delta' | 'transcript_final';
  segment_id: string;
  utterance_id: string;
  text: string;
  is_final: boolean;
  speaker_id?: string;
  speaker_label?: string;
  speaker_status?: SpeakerAttributionStatus;
  speaker_source?: SpeakerAttributionSource;
  start_ms?: number;
  end_ms?: number;
  partial_state?: boolean;
}

export interface AssistantTextDeltaEvent extends MediaEventBase {
  type: 'assistant_text_delta';
  text: string;
  is_final?: boolean;
  turn_id?: string;
}

export const ANIMATION_CUE_KINDS = [
  'viseme',
  'blendshape',
  'expression',
  'gaze',
  'gesture',
] as const;
export type AnimationCueKind = (typeof ANIMATION_CUE_KINDS)[number];

export const ANIMATION_CUE_SOURCES = ['provider', 'phoneme_alignment', 'rms_fallback'] as const;
export type AnimationCueSource = (typeof ANIMATION_CUE_SOURCES)[number];

export interface AnimationCue {
  target_avatar_id: string;
  audio_track_id?: string;
  at_ms: number;
  duration_ms?: number;
  kind: AnimationCueKind;
  /** Provider-neutral values or target-specific blendshape parameters. */
  payload: Record<string, number | string>;
  source: AnimationCueSource;
  confidence?: number;
  provider_id?: string;
}

export interface AnimationCueEvent extends MediaEventBase {
  type: 'animation_cue';
  target_avatar_id: string;
  cue: AnimationCue;
}

export interface MediaToolEvent extends MediaEventBase {
  type: 'tool_request' | 'tool_result';
  tool_call_id: string;
  tool_name: string;
  payload: Record<string, unknown>;
  status?: 'requested' | 'succeeded' | 'failed' | 'blocked';
}

export interface MediaTurnCompletedEvent extends MediaEventBase {
  type: 'turn_completed';
  turn_id: string;
  participant_id?: string;
  interrupted?: boolean;
}

export interface MediaErrorEvent extends MediaEventBase {
  type: 'error';
  code: string;
  message: string;
  recoverable?: boolean;
}

export type MediaEvent =
  | MediaSessionLifecycleEvent
  | MediaAudioFrameEvent
  | MediaSpeechEvent
  | SpeakerAttributionEvent
  | MediaTranscriptEvent
  | AssistantTextDeltaEvent
  | AnimationCueEvent
  | MediaToolEvent
  | MediaTurnCompletedEvent
  | MediaErrorEvent;

export interface RealtimeVoiceCapabilities {
  streaming_input: boolean;
  streaming_output: boolean;
  native_audio: boolean;
  server_vad: boolean;
  semantic_vad: boolean;
  speaker_diarization: boolean;
  viseme: boolean;
  blendshapes: boolean;
  avatar_video: boolean;
  tool_calls: boolean;
}

export interface RealtimeVoiceTransportConfig {
  session: MediaSessionDescriptor;
  input_format: AudioFormat;
  output_format?: AudioFormat;
  voice_profile_id?: string;
  avatar_profile_id?: string;
  /** Governance is evaluated before an adapter is constructed. */
  recording_consent_granted: boolean;
  /** Set by adapters that send captured audio to an external provider. */
  requires_external_provider_egress?: boolean;
  external_provider_egress_granted?: boolean;
}

export interface RealtimeVoiceConnection {
  readonly capabilities: RealtimeVoiceCapabilities;
  sendAudio(chunk: AudioChunk): Promise<void>;
  sendText(text: string): Promise<void>;
  events(): AsyncIterable<MediaEvent>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface RealtimeVoiceTransport {
  readonly transport_id: string;
  connect(config: RealtimeVoiceTransportConfig): Promise<RealtimeVoiceConnection>;
}

export function validateMediaSessionDescriptor(input: MediaSessionDescriptor): void {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.session_id !== 'string' ||
    !input.session_id.trim()
  ) {
    throw new Error('[media-session] session_id is required');
  }
  if (!MEDIA_SESSION_MODES.includes(input.mode)) {
    throw new Error(`[media-session] unsupported mode '${String(input.mode)}'`);
  }
  if (!Array.isArray(input.participants)) {
    throw new Error('[media-session] participants must be an array');
  }
  if (
    (input.mode === 'meeting_observer' || input.mode === 'meeting_participant') &&
    (!input.scope ||
      typeof input.scope.tenant_slug !== 'string' ||
      !isValidTenantSlug(input.scope.tenant_slug))
  ) {
    throw new Error('[media-session] valid tenant scope is required for meeting sessions');
  }
  const ids = new Set<string>();
  for (const participant of input.participants) {
    if (
      !participant ||
      typeof participant !== 'object' ||
      typeof participant.participant_id !== 'string' ||
      !participant.participant_id.trim()
    ) {
      throw new Error('[media-session] participant_id is required');
    }
    if (!MEDIA_PARTICIPANT_KINDS.includes(participant.kind)) {
      throw new Error(`[media-session] unsupported participant kind '${String(participant.kind)}'`);
    }
    if (ids.has(participant.participant_id)) {
      throw new Error(`[media-session] duplicate participant_id '${participant.participant_id}'`);
    }
    ids.add(participant.participant_id);
  }
}

export function assertRealtimeVoiceTransportConsent(config: RealtimeVoiceTransportConfig): void {
  validateMediaSessionDescriptor(config.session);
  if (!config.recording_consent_granted) {
    throw new Error('[media-session] recording consent is required before opening audio transport');
  }
  const requiresExternalEgress =
    config.requires_external_provider_egress || config.session.mode === 'meeting_participant';
  if (requiresExternalEgress && !config.external_provider_egress_granted) {
    throw new Error(
      '[media-session] external provider egress consent is required for meeting participation'
    );
  }
}

export function transcriptChunkToMediaEvent(input: {
  session_id: string;
  chunk: TranscriptChunk;
  event_id: string;
  segment_id?: string;
  speaker_id?: string;
  source?: string;
  at_ms?: number;
}): MediaTranscriptEvent {
  const { chunk } = input;
  const speakerId = input.speaker_id || chunk.speaker_id;
  const speakerStatus = input.speaker_id
    ? chunk.speaker_status || 'tentative'
    : chunk.speaker_status;
  const atMs = input.at_ms ?? chunk.start_ms ?? 0;
  return {
    event_id: input.event_id,
    session_id: input.session_id,
    type: chunk.is_final ? 'transcript_final' : 'transcript_delta',
    at_ms: atMs,
    emitted_at: chunk.emitted_at,
    source: input.source || chunk.speaker_source || 'stt',
    ...(speakerId ? { speaker_id: speakerId } : {}),
    ...(chunk.confidence === undefined ? {} : { confidence: chunk.confidence }),
    segment_id: input.segment_id || chunk.utterance_id,
    utterance_id: chunk.utterance_id,
    text: chunk.text,
    is_final: chunk.is_final,
    ...(chunk.speaker_label ? { speaker_label: chunk.speaker_label } : {}),
    ...(speakerStatus ? { speaker_status: speakerStatus } : {}),
    ...(chunk.speaker_source ? { speaker_source: chunk.speaker_source } : {}),
    ...(chunk.start_ms === undefined ? {} : { start_ms: chunk.start_ms }),
    ...(chunk.end_ms === undefined ? {} : { end_ms: chunk.end_ms }),
  };
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function firstNumber(record: UnknownRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function firstText(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function normalizeSpeakerId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '_');
  const numbered = cleaned.match(/(?:speaker|spk)[_-]?(\d+)/u);
  return numbered ? `spk_${numbered[1]}` : cleaned.startsWith('spk_') ? cleaned : `spk_${cleaned}`;
}

/**
 * Normalize VibeVoice-ASR-like `segments` output into canonical events.
 * The official output has evolved between demos, so both speaker/start/end
 * naming variants are accepted. Speaker ids remain session-local and are not
 * promoted to person identity.
 */
export function normalizeVibeVoiceAsrSegments(
  input: unknown,
  options: {
    session_id: string;
    source?: string;
    attribution_status?: SpeakerAttributionStatus;
    event_id_prefix?: string;
  }
): MediaEvent[] {
  const segments = isRecord(input) && Array.isArray(input.segments) ? input.segments : input;
  if (!Array.isArray(segments)) {
    throw new Error('[vibevoice-asr] response must contain a segments array');
  }
  const source = options.source || 'vibevoice-asr';
  const status = options.attribution_status || 'authoritative';
  const prefix = options.event_id_prefix || 'vibevoice';
  const events: MediaEvent[] = [];
  segments.forEach((value, index) => {
    if (!isRecord(value)) return;
    const text = firstText(value, ['text', 'transcript', 'content']);
    if (!text) return;
    const rawSpeaker = firstText(value, ['speaker_id', 'speaker', 'speaker_label']);
    const speakerLabel =
      firstText(value, ['speaker_label']) ||
      (typeof value.speaker === 'string' ? firstText(value, ['speaker']) : undefined);
    const speakerId = rawSpeaker ? normalizeSpeakerId(rawSpeaker) : undefined;
    const startSec = firstNumber(value, ['start_time', 'start']);
    const endSec = firstNumber(value, ['end_time', 'end']);
    const startMs =
      startSec === undefined ? index * 1000 : Math.max(0, Math.round(startSec * 1000));
    const endMs = endSec === undefined ? undefined : Math.max(startMs, Math.round(endSec * 1000));
    const segmentId = firstText(value, ['segment_id', 'id']) || `${prefix}-segment-${index + 1}`;
    const eventId = `${prefix}-${options.session_id}-${index + 1}`;
    if (speakerId) {
      events.push({
        event_id: `${eventId}-speaker`,
        session_id: options.session_id,
        type: 'speaker_attribution',
        at_ms: startMs,
        emitted_at: new Date().toISOString(),
        source,
        speaker_id: speakerId,
        segment_id: segmentId,
        status,
        attribution_source: 'diarization',
        ...(speakerLabel ? { speaker_label: speakerLabel } : {}),
      });
    }
    events.push({
      event_id: eventId,
      session_id: options.session_id,
      type: 'transcript_final',
      at_ms: startMs,
      emitted_at: new Date().toISOString(),
      source,
      ...(speakerId ? { speaker_id: speakerId } : {}),
      ...(speakerLabel ? { speaker_label: speakerLabel } : {}),
      segment_id: segmentId,
      utterance_id: segmentId,
      text,
      is_final: true,
      ...(status ? { speaker_status: status } : {}),
      speaker_source: 'diarization',
      start_ms: startMs,
      ...(endMs === undefined ? {} : { end_ms: endMs }),
    });
  });
  return events;
}

const AZURE_VISEME_TO_CANONICAL: Readonly<Record<number, string>> = {
  0: 'sil',
  1: 'AA',
  2: 'AI',
  3: 'AU',
  4: 'E',
  5: 'ER',
  6: 'I',
  7: 'U',
  8: 'OW',
  9: 'O',
  10: 'A',
  11: 'R',
  12: 'L',
  13: 'S',
  14: 'SH',
  15: 'TH',
  16: 'T',
  17: 'K',
  18: 'P',
  19: 'N',
  20: 'H',
  21: 'F',
};

export function normalizeProviderViseme(input: {
  provider_id: string;
  viseme_id: number;
  target_avatar_id: string;
  audio_track_id?: string;
  at_ms: number;
  duration_ms?: number;
  confidence?: number;
}): AnimationCue {
  if (!Number.isInteger(input.viseme_id) || input.viseme_id < 0) {
    throw new Error('[viseme] viseme_id must be a non-negative integer');
  }
  const provider = input.provider_id.trim().toLowerCase();
  if (!provider || !input.target_avatar_id.trim()) {
    throw new Error('[viseme] provider_id and target_avatar_id are required');
  }
  if (
    !Number.isFinite(input.at_ms) ||
    (input.duration_ms !== undefined && !Number.isFinite(input.duration_ms))
  ) {
    throw new Error('[viseme] at_ms and duration_ms must be finite numbers');
  }
  if (
    input.confidence !== undefined &&
    (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
  ) {
    throw new Error('[viseme] confidence must be between 0 and 1');
  }
  const canonical = provider === 'azure' ? AZURE_VISEME_TO_CANONICAL[input.viseme_id] : undefined;
  return {
    target_avatar_id: input.target_avatar_id,
    ...(input.audio_track_id ? { audio_track_id: input.audio_track_id } : {}),
    at_ms: Math.max(0, input.at_ms),
    ...(input.duration_ms === undefined ? {} : { duration_ms: Math.max(0, input.duration_ms) }),
    kind: 'viseme',
    payload: {
      provider_viseme_id: input.viseme_id,
      ...(canonical ? { canonical_viseme: canonical } : {}),
    },
    source: 'provider',
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    provider_id: input.provider_id,
  };
}

export function createRmsFallbackAnimationCue(input: {
  target_avatar_id: string;
  audio_track_id?: string;
  at_ms: number;
  duration_ms?: number;
  mouth_open: number;
}): AnimationCue {
  if (!input.target_avatar_id.trim()) {
    throw new Error('[animation-cue] target_avatar_id is required');
  }
  if (
    !Number.isFinite(input.at_ms) ||
    (input.duration_ms !== undefined && !Number.isFinite(input.duration_ms)) ||
    !Number.isFinite(input.mouth_open)
  ) {
    throw new Error('[animation-cue] timing and mouth_open must be finite numbers');
  }
  return {
    target_avatar_id: input.target_avatar_id,
    ...(input.audio_track_id ? { audio_track_id: input.audio_track_id } : {}),
    at_ms: Math.max(0, input.at_ms),
    ...(input.duration_ms === undefined ? {} : { duration_ms: Math.max(0, input.duration_ms) }),
    kind: 'blendshape',
    payload: { mouth_open: Math.min(1, Math.max(0, input.mouth_open)) },
    source: 'rms_fallback',
  };
}

export type MediaEventListener = (event: MediaEvent) => void;
export type MediaEventListenerErrorHandler = (error: unknown, event: MediaEvent) => void;

/** Bounded fan-out buffer for live projections; not a durable event store. */
export class MediaEventBuffer {
  private readonly events: MediaEvent[] = [];
  private readonly listeners = new Set<MediaEventListener>();
  private readonly eventIds = new Set<string>();

  constructor(
    private readonly session_id: string,
    private readonly max_events = 512,
    private readonly on_listener_error?: MediaEventListenerErrorHandler
  ) {
    if (!session_id.trim()) throw new Error('[media-event-buffer] session_id is required');
    if (!Number.isInteger(max_events) || max_events < 1) {
      throw new Error('[media-event-buffer] max_events must be a positive integer');
    }
  }

  append(event: MediaEvent): void {
    if (event.session_id !== this.session_id) {
      throw new Error('[media-event-buffer] event session_id does not match buffer');
    }
    if (this.eventIds.has(event.event_id)) {
      throw new Error(`[media-event-buffer] duplicate event_id '${event.event_id}'`);
    }
    this.eventIds.add(event.event_id);
    this.events.push(event);
    while (this.events.length > this.max_events) {
      const evicted = this.events.shift();
      if (evicted) this.eventIds.delete(evicted.event_id);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error: unknown) {
        try {
          this.on_listener_error?.(error, event);
        } catch {
          // A projection and its error reporter must not break the media source.
        }
      }
    }
  }

  snapshot(): readonly MediaEvent[] {
    return [...this.events];
  }

  subscribe(listener: MediaEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.events.length = 0;
    this.eventIds.clear();
  }
}
