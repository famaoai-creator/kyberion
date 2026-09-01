import { withCatalogInputContract } from '../../../core/actuator-sdk.js';

// AR-02: self-described op catalog — mirrors this actuator's action
// dispatch (if/else style handleAction). None of these ops appear in the
// shared pools, so every entry is strictly additive: pipelines reached them
// via explicit step roles, and determineActuatorStepType threw unknown-op.

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

const MEETING_SCHEMA = {
  type: 'object',
  properties: {
    agenda: { type: 'array' },
    attendees: { type: 'array' },
    attendees_from: { type: 'string' },
    counterparty_ref: { type: 'string' },
    current_topic: { type: 'string' },
    days_overdue: { type: 'number' },
    default_assignee_label: { type: 'string' },
    enforce_restricted_actions: { type: 'boolean' },
    export_as: { type: 'string' },
    facilitator_persona_label: { type: 'string' },
    item: {
      type: 'object',
      properties: {
        item_id: { type: 'string' },
        mission_id: { type: 'string' },
        meeting_ref: {},
        title: { type: 'string' },
        summary: { type: 'string' },
        assignee: {},
        due_at: { type: 'string' },
        status: { type: 'string' },
        modality: { type: 'string' },
        review_state: { type: 'string' },
        provenance: {},
        max_reminders: { type: 'number' },
        policy: {},
        priority: { type: 'string' },
        created_at: { type: 'string' },
        updated_at: { type: 'string' },
        completed_at: { type: 'string' },
        blocked_reason: { type: 'string' },
        tenant_slug: { type: 'string' },
        reminders: { type: 'array' },
        execution: {},
      },
      additionalProperties: false,
    },
    item_from: { type: 'string' },
    language: { type: 'string' },
    max_items: { type: 'number' },
    meeting_id: { type: 'string' },
    mode: { type: 'string', enum: ['transcribe', 'realtime'] },
    mission_id: { type: 'string' },
    mission_ids: { type: 'array', items: { type: 'string' } },
    node: { type: 'string', enum: ['local', 'named-node'] },
    operator_label: { type: 'string' },
    output_path: { type: 'string' },
    passcode: { type: 'string' },
    partial_reason: { type: 'string' },
    partial_state: { type: 'boolean' },
    platform: { type: 'string' },
    proposal_draft_ref: { type: 'string' },
    provider: { type: 'string' },
    provider_profile_id: { type: 'string' },
    recent_transcript_chunk: { type: 'string' },
    remaining_minutes: { type: 'number' },
    structure: { type: 'array' },
    tenant_slug: { type: 'string' },
    text: { type: 'string' },
    tone: { type: 'string', enum: ['friendly', 'formal', 'urgent'] },
    transcript: { type: 'string' },
    transcript_path: { type: 'string' },
    url: { type: 'string' },
    url_policy: { type: 'string', enum: ['explicit_only', 'explicit_or_detected'] },
    work_item_id: { type: 'string' },
    audio_bridge: { type: 'string', enum: ['blackhole', 'pulseaudio', 'none'] },
    duration_sec: { type: 'number' },
    execution_profile_id: { type: 'string' },
  },
  additionalProperties: false,
} as const;

const MEETING_CONSENT_SCHEMA = {
  type: 'object',
  properties: { export_as: { type: 'string' } },
  additionalProperties: false,
} as const;

const MEETING_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  check_consent: [{}],
  listen: [{ mission_id: 'MSN-20260826-001' }],
  status: [{ mission_id: 'MSN-20260826-001' }],
  audit_speaker_fairness: [{ mission_id: 'MSN-20260826-001' }],
  chat: [{ text: 'Please summarize the decision.' }],
  conduct_1on_1: [{ counterparty_ref: 'operator' }],
  execute_self_action_items: [{ language: 'ja' }],
  extract_action_items: [{ transcript: 'Please confirm the decisions.' }],
  generate_facilitation_script: [{ agenda: ['Status', 'Next steps'] }],
  generate_reminder_message: [{ item: { title: 'Follow up' } }],
  run_action_item_reminder_sweep: [{ max_items: 20 }],
  join: [{ url: 'https://meet.example.invalid/session' }],
  leave: [{}],
  speak: [{ text: 'Thank you.' }],
  track_pending_action_items: [{ mission_id: 'MSN-20260826-001' }],
};

export const MEETING_ACTUATOR_CAPTURE_OPS = ['check_consent', 'listen', 'status'] as const;

export const MEETING_ACTUATOR_TRANSFORM_OPS = [] as const;

export const MEETING_ACTUATOR_APPLY_OPS = [
  'audit_speaker_fairness',
  'chat',
  'conduct_1on_1',
  'execute_self_action_items',
  'extract_action_items',
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
    input_schema: op === 'check_consent' ? MEETING_CONSENT_SCHEMA : MEETING_SCHEMA,
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
