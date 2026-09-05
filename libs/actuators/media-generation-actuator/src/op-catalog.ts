// AR-02: self-described op catalog — mirrors this actuator's action
// dispatch (if/else style handleAction). None of these ops appear in the
// shared pools, so every entry is strictly additive: pipelines reached them
// via explicit step roles, and determineActuatorStepType threw unknown-op.

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

type InputSchema = Record<string, unknown>;
const MEDIA_CAPTURE_SCHEMA: InputSchema = {
  type: 'object',
  properties: { duration: { type: 'number' }, fps: { type: 'number' }, output: { type: 'string' } },
  additionalProperties: false,
};
const MEDIA_GENERATION_CONTRACTS: Record<string, InputSchema> = {
  capture_focused_window: MEDIA_CAPTURE_SCHEMA,
  capture_screen: MEDIA_CAPTURE_SCHEMA,
  record_screen: MEDIA_CAPTURE_SCHEMA,
  collect_generation_artifact: {
    type: 'object',
    properties: { job_id: { type: 'string' }, target_path: { type: 'string' } },
    required: ['job_id'],
    additionalProperties: false,
  },
  get_generation_job: {
    type: 'object',
    properties: { job_id: { type: 'string' } },
    required: ['job_id'],
    additionalProperties: false,
  },
  wait_generation_job: {
    type: 'object',
    properties: {
      job_id: { type: 'string' },
      poll_interval_ms: { type: 'number' },
      timeout_ms: { type: 'number' },
    },
    required: ['job_id'],
    additionalProperties: false,
  },
  submit_generation: {
    type: 'object',
    properties: {
      action: { type: 'string' },
      existing_job_id: { type: 'string' },
      job_id: { type: 'string' },
      params: { type: 'object' },
      retry_policy: { type: 'object' },
      scope: { type: 'object' },
      target_path: { type: 'string' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  pipeline: {
    type: 'object',
    properties: { output: { type: 'string' } },
    additionalProperties: false,
  },
  generate_image: {
    type: 'object',
    properties: {
      aspectRatio: { type: 'string' },
      aspect_ratio: { type: 'string' },
      await_completion: { type: 'boolean' },
      backend_id: { type: 'string' },
      format: { type: 'string' },
      image_adf: { type: 'object' },
      mode: { type: 'string' },
      no_style_pack: { type: 'boolean' },
      output_path: { type: 'string' },
      params: { type: 'object' },
      prompt: { type: 'string' },
      provider: { type: 'string' },
      provider_preference: { type: 'array' },
      providerPreference: { type: 'array' },
      reference_images: { type: 'array' },
      request_id: { type: 'string' },
      resolution: { type: 'string' },
      style: { type: 'string' },
      target_path: { type: 'string' },
      targetPath: { type: 'string' },
      tenant_slug: { type: 'string' },
      timeout_ms: { type: 'number' },
      workflow: {},
      workflow_path: { type: 'string' },
    },
    additionalProperties: false,
  },
  generate_video: {
    type: 'object',
    properties: {
      await_completion: { type: 'boolean' },
      backend_id: { type: 'string' },
      first_frame_image: { type: 'string' },
      format: { type: 'string' },
      input_video: { type: 'string' },
      last_frame_image: { type: 'string' },
      mode: { type: 'string' },
      no_style_pack: { type: 'boolean' },
      output_path: { type: 'string' },
      params: { type: 'object' },
      prompt: { type: 'string' },
      provider: { type: 'string' },
      provider_preference: { type: 'array' },
      providerPreference: { type: 'array' },
      reference_images: { type: 'array' },
      request_id: { type: 'string' },
      resolution: { type: 'string' },
      style: { type: 'string' },
      target_path: { type: 'string' },
      targetPath: { type: 'string' },
      tenant_slug: { type: 'string' },
      timeout_ms: { type: 'number' },
      video_adf: { type: 'object' },
      video_model: { type: 'string' },
      workflow: {},
      workflow_path: { type: 'string' },
    },
    additionalProperties: false,
  },
  generate_music: {
    type: 'object',
    properties: {
      await_completion: { type: 'boolean' },
      backend_id: { type: 'string' },
      format: { type: 'string' },
      generate_audio: { type: 'boolean' },
      music_adf: { type: 'object' },
      no_style_pack: { type: 'boolean' },
      output_path: { type: 'string' },
      params: { type: 'object' },
      prompt: { type: 'string' },
      provider: { type: 'string' },
      provider_preference: { type: 'array' },
      providerPreference: { type: 'array' },
      request_id: { type: 'string' },
      style: { type: 'string' },
      target_path: { type: 'string' },
      targetPath: { type: 'string' },
      tenant_slug: { type: 'string' },
      timeout_ms: { type: 'number' },
      workflow: {},
      workflow_path: { type: 'string' },
    },
    additionalProperties: false,
  },
  run_workflow: {
    type: 'object',
    properties: {
      await_completion: { type: 'boolean' },
      backend_id: { type: 'string' },
      format: { type: 'string' },
      no_style_pack: { type: 'boolean' },
      output_path: { type: 'string' },
      params: { type: 'object' },
      provider: { type: 'string' },
      request_id: { type: 'string' },
      target_path: { type: 'string' },
      targetPath: { type: 'string' },
      tenant_slug: { type: 'string' },
      timeout_ms: { type: 'number' },
      workflow: {},
      workflow_path: { type: 'string' },
    },
    additionalProperties: false,
  },
};

const MEDIA_GENERATION_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  capture_focused_window: [{ output: 'active/shared/tmp/focused.jpg' }],
  capture_screen: [{ output: 'active/shared/tmp/screen.jpg' }],
  record_screen: [{ output: 'active/shared/tmp/recording.mp4', duration: 2, fps: 10 }],
  collect_generation_artifact: [
    { job_id: 'generation-1', target_path: 'active/shared/tmp/result.png' },
  ],
  get_generation_job: [{ job_id: 'generation-1' }],
  wait_generation_job: [{ job_id: 'generation-1', timeout_ms: 900000 }],
  submit_generation: [{ action: 'generate_image', params: { prompt: 'A calm landscape' } }],
  pipeline: [{ output: 'last_result' }],
  generate_image: [{ prompt: 'A calm landscape', output_path: 'active/shared/tmp/image.png' }],
  generate_video: [{ prompt: 'A calm landscape', output_path: 'active/shared/tmp/video.mp4' }],
  generate_music: [{ prompt: 'A calm ambient theme', output_path: 'active/shared/tmp/music.wav' }],
  run_workflow: [{ workflow: 'creative-default' }],
};

export const MEDIA_GENERATION_ACTIONS = [
  'generate_image',
  'generate_video',
  'generate_music',
  'run_workflow',
  'submit_generation',
  'get_generation_job',
  'wait_generation_job',
  'collect_generation_artifact',
  'capture_screen',
  'capture_focused_window',
  'record_screen',
  'pipeline',
] as const;

export const MEDIA_GENERATION_ACTUATOR_CAPTURE_OPS = [
  'capture_focused_window',
  'capture_screen',
  'record_screen',
] as const;

export const MEDIA_GENERATION_ACTUATOR_TRANSFORM_OPS = [] as const;

export const MEDIA_GENERATION_ACTUATOR_APPLY_OPS = [
  'collect_generation_artifact',
  'generate_image',
  'generate_music',
  'generate_video',
  'get_generation_job',
  'run_workflow',
  'submit_generation',
  'wait_generation_job',
] as const;

export const MEDIA_GENERATION_ACTUATOR_CONTROL_OPS = ['pipeline'] as const;

function toSpec(op: string, kind: PipelineStepType) {
  const schema = MEDIA_GENERATION_CONTRACTS[op];
  return schema
    ? { op, kind, input_schema: schema, examples: MEDIA_GENERATION_EXAMPLES[op] || [{}] }
    : { op, kind };
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...MEDIA_GENERATION_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...MEDIA_GENERATION_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...MEDIA_GENERATION_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
    ...MEDIA_GENERATION_ACTUATOR_CONTROL_OPS.map((op) => toSpec(op, 'control')),
  ];
}
