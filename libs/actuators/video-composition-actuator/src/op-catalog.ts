import { withCatalogInputContract } from '../../../core/actuator-sdk.js';

// AR-02: self-described op catalog — mirrors this actuator's action
// dispatch (if/else style handleAction). None of these ops appear in the
// shared pools, so every entry is strictly additive: pipelines reached them
// via explicit step roles, and determineActuatorStepType threw unknown-op.

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

type InputSchema = Record<string, unknown>;
const VIDEO_COMPOSITION_CONTRACTS: Record<string, InputSchema> = {
  get_video_composition_job_status: {
    type: 'object',
    properties: { job_id: { type: 'string' } },
    required: ['job_id'],
    additionalProperties: false,
  },
  get_video_composition_queue: { type: 'object', properties: {}, additionalProperties: false },
  list_video_composition_templates: { type: 'object', properties: {}, additionalProperties: false },
  compile_narrated_video_brief: {
    type: 'object',
    properties: { narrated_video_brief: { type: 'object' } },
    required: ['narrated_video_brief'],
    additionalProperties: false,
  },
  compile_video_content_brief: {
    type: 'object',
    properties: { video_content_brief: { type: 'object' } },
    required: ['video_content_brief'],
    additionalProperties: false,
  },
  lint_video_composition: {
    type: 'object',
    properties: {
      bundle_dir: { type: 'string' },
      fail_on_error: { type: 'boolean' },
      tenant_slug: { type: 'string' },
      video_composition_adf: { type: 'object' },
    },
    required: ['video_composition_adf'],
    additionalProperties: false,
  },
  await_video_composition_job: {
    type: 'object',
    properties: { job_id: { type: 'string' }, timeout_ms: { type: 'number' } },
    required: ['job_id'],
    additionalProperties: false,
  },
  cancel_video_composition_job: {
    type: 'object',
    properties: { job_id: { type: 'string' }, reason: { type: 'string' } },
    required: ['job_id'],
    additionalProperties: false,
  },
  create_narrated_intro_movie: {
    type: 'object',
    properties: {
      bundle_dir: { type: 'string' },
      job_id: { type: 'string' },
      narrated_video_brief: { type: 'object' },
    },
    required: ['narrated_video_brief'],
    additionalProperties: false,
  },
  create_narrated_video_from_content_brief: {
    type: 'object',
    properties: {
      bundle_dir: { type: 'string' },
      job_id: { type: 'string' },
      narration_artifact_ref: { type: 'string' },
      output: { type: 'object' },
      video_content_brief: { type: 'object' },
    },
    required: ['video_content_brief', 'narration_artifact_ref'],
    additionalProperties: false,
  },
  prepare_video_composition: {
    type: 'object',
    properties: {
      bundle_dir: { type: 'string' },
      job_id: { type: 'string' },
      video_composition_adf: { type: 'object' },
    },
    required: ['video_composition_adf'],
    additionalProperties: false,
  },
  verify_rendered_video_artifact: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      path: { type: 'string' },
      require_audio: { type: 'boolean' },
      require_video: { type: 'boolean' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  validate_narrated_video_artifact: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      mission_evidence_dir: { type: 'string' },
      narration_path: { type: 'string' },
      tolerance_sec: { type: 'number' },
      video_bundle_dir: { type: 'string' },
      video_output_path: { type: 'string' },
      video_slug: { type: 'string' },
    },
    required: [
      'narration_path',
      'video_output_path',
      'video_bundle_dir',
      'mission_evidence_dir',
      'video_slug',
    ],
    additionalProperties: false,
  },
};

const VIDEO_COMPOSITION_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  get_video_composition_job_status: [{ job_id: 'video-job-1' }],
  get_video_composition_queue: [{}],
  list_video_composition_templates: [{}],
  compile_narrated_video_brief: [
    { narrated_video_brief: { title: 'Demo', story: 'A short demo' } },
  ],
  compile_video_content_brief: [{ video_content_brief: { title: 'Demo', scenes: [] } }],
  lint_video_composition: [
    { video_composition_adf: { kind: 'video-composition-adf', version: '1.0.0' } },
  ],
  await_video_composition_job: [{ job_id: 'video-job-1', timeout_ms: 300000 }],
  cancel_video_composition_job: [{ job_id: 'video-job-1', reason: 'operator requested' }],
  create_narrated_intro_movie: [{ narrated_video_brief: { title: 'Intro', story: 'Welcome' } }],
  create_narrated_video_from_content_brief: [
    { video_content_brief: { title: 'Demo' }, narration_artifact_ref: 'artifact-1' },
  ],
  prepare_video_composition: [
    { video_composition_adf: { kind: 'video-composition-adf', version: '1.0.0' } },
  ],
  verify_rendered_video_artifact: [
    { path: 'active/shared/tmp/render.mp4', require_audio: true, require_video: true },
  ],
  validate_narrated_video_artifact: [
    {
      narration_path: 'active/shared/tmp/narration.aiff',
      video_output_path: 'active/shared/tmp/render.mp4',
      video_bundle_dir: 'active/shared/tmp/render-bundle',
      mission_evidence_dir: 'active/shared/tmp/evidence',
      video_slug: 'demo',
    },
  ],
};

export const VIDEO_COMPOSITION_ACTUATOR_CAPTURE_OPS = [
  'get_video_composition_job_status',
  'get_video_composition_queue',
  'list_video_composition_templates',
] as const;

export const VIDEO_COMPOSITION_ACTUATOR_TRANSFORM_OPS = [
  'compile_narrated_video_brief',
  'compile_video_content_brief',
  'lint_video_composition',
] as const;

export const VIDEO_COMPOSITION_ACTUATOR_APPLY_OPS = [
  'await_video_composition_job',
  'cancel_video_composition_job',
  'create_narrated_intro_movie',
  'create_narrated_video_from_content_brief',
  'prepare_video_composition',
  'verify_rendered_video_artifact',
  'validate_narrated_video_artifact',
] as const;

function toSpec(op: string, kind: PipelineStepType) {
  const schema = VIDEO_COMPOSITION_CONTRACTS[op];
  const description = schema
    ? { op, kind, input_schema: schema, examples: VIDEO_COMPOSITION_EXAMPLES[op] || [{}] }
    : { op, kind };
  return withCatalogInputContract('video-composition', op, kind, description);
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...VIDEO_COMPOSITION_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...VIDEO_COMPOSITION_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...VIDEO_COMPOSITION_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
