import { withCatalogInputContract } from '../../../core/actuator/actuator-sdk.js';

// AR-02: self-described op catalog — one entry per dispatch-table op in
// meeting-op-dispatch.ts. Session transport ops and intelligence ops share
// the catalog so `meeting:<op>` resolves identically from pipelines, ADF,
// and `actuator.dispatch()`.

import type { PipelineStepType } from '../../../core/actuator/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator/actuator-sdk.js';

const BASE_PROPERTIES = {
  export_as: { type: 'string' },
  mission_id: { type: 'string' },
  work_item_id: { type: 'string' },
  language: { type: 'string' },
} as const;

const SESSION_PROPERTIES = {
  platform: { type: 'string' },
  provider: { type: 'string' },
  provider_profile_id: { type: 'string' },
  execution_profile_id: { type: 'string' },
  mode: { type: 'string', enum: ['transcribe', 'realtime'] },
  node: { type: 'string', enum: ['local', 'named-node'] },
  audio_bridge: { type: 'string' },
  url_policy: { type: 'string', enum: ['explicit_only', 'explicit_or_detected'] },
  url: { type: 'string' },
  meeting_id: { type: 'string' },
  passcode: { type: 'string' },
  text: { type: 'string' },
  duration_sec: { type: 'number' },
  transcript_path: { type: 'string' },
  display_name: { type: 'string' },
  join_backend: { type: 'string' },
  ws_port: { type: 'number' },
  join_timeout_sec: { type: 'number' },
  raise_hand: { type: 'boolean' },
  headed: { type: 'boolean' },
  user_data_dir: { type: 'string' },
} as const;

const INTELLIGENCE_PROPERTIES = {
  agenda: { type: 'array' },
  attendees: { type: 'array' },
  attendees_from: { type: 'string' },
  answers: { type: 'array' },
  counterparty_label: { type: 'string' },
  counterparty_ref: { type: 'string' },
  current_topic: { type: 'string' },
  days_overdue: { type: 'number' },
  default_assignee_label: { type: 'string' },
  enforce_restricted_actions: { type: 'boolean' },
  events: { type: 'array' },
  events_from: { type: 'string' },
  facilitator_persona_label: { type: 'string' },
  goal: { type: 'string' },
  item: { type: 'object' },
  item_from: { type: 'string' },
  learner_label: { type: 'string' },
  material: { type: 'string' },
  material_path: { type: 'string' },
  max_duration_sec: { type: 'number' },
  max_items: { type: 'number' },
  mission_ids: { type: 'array', items: { type: 'string' } },
  now: {},
  operator_label: { type: 'string' },
  output_path: { type: 'string' },
  partial_reason: { type: 'string' },
  partial_state: { type: 'boolean' },
  proposal_draft_ref: { type: 'string' },
  recent_transcript_chunk: { type: 'string' },
  remaining_minutes: { type: 'number' },
  report_path: { type: 'string' },
  speaker_aliases: { type: 'object' },
  started_ago_min: { type: 'number' },
  starts_within_min: { type: 'number' },
  structure: { type: 'array' },
  tone: { type: 'string', enum: ['friendly', 'formal', 'urgent'] },
  topic: { type: 'string' },
  transcript: { type: 'string' },
  transcript_path: { type: 'string' },
} as const;

function schemaFor(op: string): Record<string, unknown> {
  const pick = (...keys: readonly string[]): Record<string, unknown> => {
    const all = { ...BASE_PROPERTIES, ...SESSION_PROPERTIES, ...INTELLIGENCE_PROPERTIES } as Record<
      string,
      unknown
    >;
    return Object.fromEntries(keys.filter((k) => k in all).map((k) => [k, all[k]]));
  };
  switch (op) {
    case 'check_consent':
      return {
        type: 'object',
        properties: { export_as: { type: 'string' } },
        additionalProperties: false,
      };
    case 'join':
      return {
        type: 'object',
        properties: pick(
          'platform',
          'provider',
          'url',
          'meeting_id',
          'passcode',
          'display_name',
          'join_backend',
          'ws_port',
          'join_timeout_sec',
          'raise_hand',
          'headed',
          'user_data_dir',
          'duration_sec',
          'transcript_path',
          'audio_bridge',
          'mode',
          'node',
          'export_as'
        ),
        additionalProperties: false,
      };
    case 'listen':
      return {
        type: 'object',
        properties: pick(
          'platform',
          'provider',
          'url',
          'duration_sec',
          'transcript_path',
          'join_backend',
          'mission_id',
          'export_as'
        ),
        additionalProperties: false,
      };
    case 'status':
      return {
        type: 'object',
        properties: pick('platform', 'meeting_id', 'mission_id', 'export_as'),
        additionalProperties: false,
      };
    case 'speak':
      return {
        type: 'object',
        properties: pick('platform', 'provider', 'text', 'mission_id', 'export_as'),
        required: ['text'],
        additionalProperties: false,
      };
    case 'chat':
      return {
        type: 'object',
        properties: pick('platform', 'text', 'mission_id', 'export_as'),
        required: ['text'],
        additionalProperties: false,
      };
    case 'leave':
      return {
        type: 'object',
        properties: pick('platform', 'meeting_id', 'export_as'),
        additionalProperties: false,
      };
    case 'resolve_next_target':
      return {
        type: 'object',
        properties: pick(
          'events',
          'events_from',
          'now',
          'started_ago_min',
          'starts_within_min',
          'max_duration_sec',
          'export_as'
        ),
        additionalProperties: false,
      };
    case 'normalize_transcript':
      return {
        type: 'object',
        properties: pick(
          'transcript',
          'transcript_path',
          'attendees',
          'attendees_from',
          'speaker_aliases',
          'language',
          'export_as'
        ),
        additionalProperties: false,
      };
    case 'extract_action_items':
      return {
        type: 'object',
        properties: pick(
          'mission_id',
          'work_item_id',
          'transcript',
          'transcript_path',
          'attendees',
          'attendees_from',
          'operator_label',
          'default_assignee_label',
          'language',
          'partial_state',
          'partial_reason',
          'enforce_restricted_actions',
          'output_path',
          'export_as'
        ),
        additionalProperties: false,
      };
    default:
      return {
        type: 'object',
        properties: {
          ...BASE_PROPERTIES,
          ...SESSION_PROPERTIES,
          ...INTELLIGENCE_PROPERTIES,
        },
        additionalProperties: false,
      };
  }
}

const MEETING_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  check_consent: [{}],
  listen: [{ platform: 'auto', duration_sec: 30 }],
  status: [{ platform: 'auto' }],
  audit_speaker_fairness: [{ mission_id: 'MSN-20260826-001' }],
  chat: [{ text: 'Please summarize the decision.' }],
  conduct_1on_1: [{ counterparty_ref: 'operator' }],
  execute_self_action_items: [{ language: 'ja' }],
  extract_action_items: [{ transcript: 'Please confirm the decisions.' }],
  hearing_session: [{ topic: 'Renewal requirements' }],
  tutor_session: [{ material: 'Photosynthesis converts light into chemical energy.' }],
  normalize_transcript: [{ transcript_path: 'active/shared/tmp/meeting.vtt' }],
  resolve_next_target: [{ events: [] }],
  generate_facilitation_script: [{ agenda: ['Status', 'Next steps'] }],
  generate_reminder_message: [{ item: { title: 'Follow up' } }],
  run_action_item_reminder_sweep: [{ max_items: 20 }],
  join: [{ url: 'https://meet.example.invalid/session' }],
  leave: [{}],
  speak: [{ text: 'Thank you.' }],
  track_pending_action_items: [{ mission_id: 'MSN-20260826-001' }],
};

export const MEETING_ACTUATOR_CAPTURE_OPS = [
  'check_consent',
  'listen',
  'status',
  'resolve_next_target',
  'normalize_transcript',
] as const;

export const MEETING_ACTUATOR_TRANSFORM_OPS = [] as const;

export const MEETING_ACTUATOR_APPLY_OPS = [
  'audit_speaker_fairness',
  'chat',
  'conduct_1on_1',
  'execute_self_action_items',
  'extract_action_items',
  'hearing_session',
  'tutor_session',
  'generate_facilitation_script',
  'generate_reminder_message',
  'run_action_item_reminder_sweep',
  'join',
  'leave',
  'speak',
  'track_pending_action_items',
] as const;

function toSpec(op: string, kind: PipelineStepType) {
  return withCatalogInputContract('meeting', op, kind, {
    op,
    kind,
    input_schema: schemaFor(op),
    examples: MEETING_EXAMPLES[op as keyof typeof MEETING_EXAMPLES] || [{}],
  });
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...MEETING_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...MEETING_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...MEETING_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
