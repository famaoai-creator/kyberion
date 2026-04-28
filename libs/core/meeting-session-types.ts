/**
 * Shared types for meeting participation.
 *
 * These are the small structural types that the four participation
 * layers (`MeetingJoinDriver`, `AudioBus`, `StreamingSpeechBridge`,
 * `MeetingParticipationCoordinator`) all speak. Keeping them in one
 * file makes the pluggable nature of each layer obvious — a new
 * driver implementation only has to satisfy these shapes.
 */

export type MeetingPlatform = 'zoom' | 'teams' | 'meet' | 'auto';

export interface MeetingTarget {
  /** Public meeting URL (must match the platform's allow-listed host). */
  url: string;
  /** Platform of the URL; `auto` lets the driver infer. */
  platform: MeetingPlatform;
  /** Display name the AI should show in the participant list. */
  display_name?: string;
  /** Optional opaque auth handle (cookies / SDK token / OAuth). */
  auth?: { kind: string; ref: string } | undefined;
  /** Tenant slug for audit-chain emission. */
  tenant_slug?: string;
}

export type AudioFormat = {
  /** PCM by default; vendor SDKs may negotiate something else. */
  encoding: 'pcm_s16le' | 'pcm_f32le' | 'opus';
  sample_rate_hz: 16000 | 24000 | 48000;
  channels: 1 | 2;
};

export interface AudioChunk {
  format: AudioFormat;
  /** Raw frame bytes for `encoding`. */
  payload: Uint8Array;
  /** Monotonic millisecond timestamp from session start. */
  ts_ms: number;
}

export interface TranscriptChunk {
  /** Stable id per utterance — partial updates share an id. */
  utterance_id: string;
  /** True when this is the final transcription for the utterance. */
  is_final: boolean;
  text: string;
  /** Best-effort speaker attribution (driver-dependent). */
  speaker_label?: string;
  /** STT confidence ∈ [0, 1]; absent when the backend doesn't expose one. */
  confidence?: number;
  /** Wall-clock ISO at the time of emission (audit-anchor). */
  emitted_at: string;
}

export type MeetingSessionStatus =
  | 'connecting'
  | 'connected'
  | 'in_meeting'
  | 'leaving'
  | 'ended'
  | 'error';

export interface MeetingSessionState {
  session_id: string;
  platform: MeetingPlatform;
  status: MeetingSessionStatus;
  joined_at?: string;
  left_at?: string;
  /** Last error message when status === 'error'. */
  error?: string;
  /** Bridge-emitted partial-state flag (Ops-3). */
  partial_state?: boolean;
}

/**
 * One open participation, returned from `MeetingJoinDriver.join`.
 *
 * The session is the single object the coordinator uses for
 * everything after join: getting at audio streams, asking for status,
 * leaving cleanly. Drivers and audio bus implementations don't
 * communicate directly — they meet through this shape.
 */
export interface MeetingSession {
  state: MeetingSessionState;
  /**
   * Audio chunks arriving from the meeting (other participants).
   * Yields a steady stream until the session leaves.
   */
  audioInput(): AsyncIterable<AudioChunk>;
  /**
   * Send the AI's audio into the meeting (its "microphone").
   * Caller pushes chunks; resolves when stream is fully drained.
   */
  audioOutput(stream: AsyncIterable<AudioChunk>): Promise<void>;
  /**
   * Optional text-channel send (chat). Drivers may no-op when the
   * platform / config doesn't allow it.
   */
  chat(text: string): Promise<void>;
  /** Initiate a graceful leave. */
  leave(): Promise<void>;
}
