import { withCatalogInputContract } from '../../../core/actuator-sdk.js';

// AR-02: self-described op catalog — mirrors this actuator's action
// dispatch (if/else style handleAction). None of these ops appear in the
// shared pools, so every entry is strictly additive: pipelines reached them
// via explicit step roles, and determineActuatorStepType threw unknown-op.

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

type InputSchema = Record<string, unknown>;

const VOICE_CONTRACTS: Record<string, InputSchema> = {
  health: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  list_voices: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  list_audio_routes: {
    type: 'object',
    properties: {
      bus: { type: 'string', enum: ['blackhole', 'stub'] },
      export_as: { type: 'string' },
    },
    additionalProperties: false,
  },
  probe_audio_route: {
    type: 'object',
    properties: {
      bus: { type: 'string', enum: ['blackhole', 'stub'] },
      expected_device_label: { type: 'string' },
      input_device_uid: { type: 'string' },
      output_device_uid: { type: 'string' },
    },
    additionalProperties: false,
  },
  transcribe: {
    type: 'object',
    properties: {
      audio_path: { type: 'string' },
      language: { type: 'string' },
      output_path: { type: 'string' },
      request_id: { type: 'string' },
    },
    additionalProperties: false,
  },
  transcribe_voice_sample: {
    type: 'object',
    properties: {
      audio_path: { type: 'string' },
      language: { type: 'string' },
      output_path: { type: 'string' },
      request_id: { type: 'string' },
      sample_id: { type: 'string' },
    },
    additionalProperties: false,
  },
  collect_and_register_voice_profile: {
    type: 'object',
    properties: {
      language: { type: 'string' },
      profile_id: { type: 'string' },
      profile_path: { type: 'string' },
      samples: { type: 'array' },
    },
    additionalProperties: false,
  },
  collect_voice_samples: {
    type: 'object',
    properties: {
      language: { type: 'string' },
      output_dir: { type: 'string' },
      profile_id: { type: 'string' },
      samples: { type: 'array' },
    },
    additionalProperties: false,
  },
  generate_voice: {
    type: 'object',
    properties: {
      dry_run: { type: 'boolean' },
      request_id: { type: 'string' },
      text: { type: 'string' },
      profile_ref: { type: 'object', additionalProperties: true },
      engine: { type: 'object', additionalProperties: true },
      rendering: { type: 'object', additionalProperties: true },
      delivery: { type: 'object', additionalProperties: true },
      routing: { type: 'object', additionalProperties: true },
      language: { type: 'string' },
      output_path: { type: 'string' },
      profile_id: { type: 'string' },
      voice: { type: 'string' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  record_interaction: {
    type: 'object',
    required: ['channel', 'org', 'person_slug', 'summary'],
    properties: {
      channel: { type: 'string' },
      org: { type: 'string' },
      person_slug: { type: 'string' },
      summary: { type: 'string' },
      tone_shifts: { type: 'array' },
    },
    additionalProperties: false,
  },
  record_voice_sample: {
    type: 'object',
    required: ['request_id', 'sample_id'],
    properties: {
      dry_run: { type: 'boolean' },
      duration_sec: { type: 'number' },
      language: { type: 'string' },
      output_path: { type: 'string' },
      request_id: { type: 'string' },
      sample_id: { type: 'string' },
    },
    additionalProperties: false,
  },
  record_verify_repair_voice_sample: {
    type: 'object',
    required: ['request_id', 'sample_id', 'output_path'],
    properties: {
      dry_run: { type: 'boolean' },
      language: { type: 'string' },
      output_path: { type: 'string' },
      request_id: { type: 'string' },
      sample_id: { type: 'string' },
      text: { type: 'string' },
    },
    additionalProperties: false,
  },
  register_voice_profile: {
    type: 'object',
    properties: {
      language: { type: 'string' },
      profile_id: { type: 'string' },
      profile_path: { type: 'string' },
      samples: { type: 'array' },
    },
    additionalProperties: false,
  },
  speak_local: {
    type: 'object',
    required: ['text'],
    properties: {
      engine_id: { type: 'string' },
      language: { type: 'string' },
      rate: { type: 'number' },
      text: { type: 'string' },
      voice: { type: 'string' },
    },
    additionalProperties: false,
  },
  verify_tts_loopback: {
    type: 'object',
    properties: {
      audio_route: { type: 'object' },
      dry_run: { type: 'boolean' },
      language: { type: 'string' },
      request_id: { type: 'string' },
      text: { type: 'string' },
      voice_profile_id: { type: 'string' },
    },
    additionalProperties: false,
  },
};

const VOICE_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  health: [{}],
  list_voices: [{}],
  list_audio_routes: [{ bus: 'stub' }],
  probe_audio_route: [{ bus: 'stub' }],
  transcribe: [{ audio_path: 'active/shared/tmp/sample.wav', language: 'ja' }],
  transcribe_voice_sample: [{ sample_id: 'sample-1', audio_path: 'active/shared/tmp/sample.wav' }],
  collect_and_register_voice_profile: [{ profile_id: 'profile-1', samples: [] }],
  collect_voice_samples: [{ output_dir: 'active/shared/tmp/voice-samples' }],
  generate_voice: [
    {
      text: 'Hello.',
      request_id: 'voice-request-1',
      profile_ref: { profile_id: 'operator-ja-default' },
      delivery: { mode: 'artifact', artifact_path: 'active/shared/tmp/voice.wav' },
    },
  ],
  record_interaction: [
    { channel: 'voice', person_slug: 'operator', org: 'default', summary: 'Follow-up recorded.' },
  ],
  record_voice_sample: [{ request_id: 'request-1', sample_id: 'sample-1', dry_run: true }],
  record_verify_repair_voice_sample: [
    {
      request_id: 'request-1',
      sample_id: 'sample-1',
      output_path: 'active/shared/tmp/sample.wav',
      dry_run: true,
    },
  ],
  register_voice_profile: [{ profile_id: 'profile-1', samples: [] }],
  speak_local: [{ text: 'Hello.', language: 'en' }],
  verify_tts_loopback: [
    { request_id: 'loopback-1', text: 'Hello.', dry_run: true, audio_route: { bus: 'stub' } },
  ],
};

export const VOICE_ACTUATOR_CAPTURE_OPS = [
  'health',
  'list_voices',
  'list_audio_routes',
  'probe_audio_route',
  'transcribe',
  'transcribe_voice_sample',
] as const;

export const VOICE_ACTUATOR_TRANSFORM_OPS = [] as const;

export const VOICE_ACTUATOR_APPLY_OPS = [
  'collect_and_register_voice_profile',
  'collect_voice_samples',
  'generate_voice',
  'record_interaction',
  'record_voice_sample',
  'record_verify_repair_voice_sample',
  'register_voice_profile',
  'speak_local',
  'verify_tts_loopback',
] as const;

function toSpec(op: string, kind: PipelineStepType) {
  return withCatalogInputContract('voice', op, kind, {
    op,
    kind,
    input_schema: VOICE_CONTRACTS[op],
    examples: VOICE_EXAMPLES[op] || [{}],
  });
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...VOICE_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...VOICE_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...VOICE_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
