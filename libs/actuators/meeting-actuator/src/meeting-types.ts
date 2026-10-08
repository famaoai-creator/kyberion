/**
 * Meeting actuator shared types — transport envelope only.
 * Intelligence / dialogue option shapes live next to their handlers.
 */

export type MeetingSessionActionVerb =
  'check_consent' | 'join' | 'leave' | 'speak' | 'listen' | 'chat' | 'status';

export interface MeetingAction {
  action: MeetingSessionActionVerb;
  params: {
    platform: string;
    provider?: string;
    provider_profile_id?: string;
    execution_profile_id?: string;
    mode?: 'transcribe' | 'realtime';
    node?: 'local' | 'named-node';
    audio_bridge?: string;
    url_policy?: 'explicit_only' | 'explicit_or_detected';
    url?: string;
    meeting_id?: string;
    passcode?: string;
    text?: string;
    duration_sec?: number;
    transcript_path?: string;
    display_name?: string;
    join_backend?: string;
    ws_port?: number;
    join_timeout_sec?: number;
    raise_hand?: boolean;
    headed?: boolean;
    user_data_dir?: string;
  };
}

/** Catalog-style single-op envelope (`{ op, params }`), accepted alongside legacy `{ action, params }`. */
export interface MeetingOpAction {
  op: string;
  params?: Record<string, unknown>;
}

export interface MeetingPipelineAction {
  action: 'pipeline';
  steps: Array<{
    type: 'capture' | 'transform' | 'apply' | 'control';
    op: string;
    params: Record<string, unknown>;
  }>;
  context?: Record<string, unknown>;
  options?: { max_steps?: number; timeout_ms?: number };
}

export type MeetingInput = MeetingAction | MeetingOpAction | MeetingPipelineAction;

export function isPipelineInput(input: MeetingInput): input is MeetingPipelineAction {
  return (input as { action?: string }).action === 'pipeline';
}

export function isOpInput(input: MeetingInput): input is MeetingOpAction {
  return typeof (input as { op?: string }).op === 'string';
}

export interface MeetingActionResult {
  status: 'success' | 'error' | 'denied';
  action?: string;
  platform?: string;
  method?: string;
  join_backend?: string;
  provider?: string;
  provider_profile_id?: string;
  execution_profile_id?: string;
  mode?: string;
  node?: string;
  audio_bridge?: string;
  url_policy?: string;
  chars?: number;
  duration?: number;
  elapsed?: number;
  playwright_driver?: string;
  voice_bridge?: string;
  blackhole_router?: string;
  message?: string;
  audit_event_id?: string;
  trace?: unknown;
  trace_summary?: unknown;
  trace_persisted_path?: string;
  partial_state?: boolean;
  partial_reason?: string;
  transcript_path?: string;
  caption_cues?: number;
  captions_available?: boolean;
}
