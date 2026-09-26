// AR-02: self-described op catalog — mirrors this actuator's action
// dispatch (if/else style handleAction). None of these ops appear in the
// shared pools, so every entry is strictly additive: pipelines reached them
// via explicit step roles, and determineActuatorStepType threw unknown-op.

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

const VISION_SCHEMA = {
  type: 'object',
  properties: {
    extractStructure: { type: 'boolean' },
    extract_structure: { type: 'boolean' },
    kind: { type: 'string' },
    language: { type: 'string' },
    mode: { type: 'string' },
    path: { type: 'string' },
    providerPreference: { type: 'array', items: { type: 'string' } },
    provider_preference: { type: 'array', items: { type: 'string' } },
    purpose: { type: 'string' },
  },
  additionalProperties: false,
  required: ['path'],
} as const;

const TIER_SCHEMA = { type: 'string', enum: ['public', 'confidential', 'personal'] } as const;

const DESCRIBE_IMAGE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    kind: { type: 'string' },
    tier: TIER_SCHEMA,
    mission_id: { type: 'string' },
    tenant_slug: { type: 'string' },
  },
  additionalProperties: false,
  required: ['path'],
} as const;

const VIDEO_SOURCE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: { kind: { const: 'url' }, url: { type: 'string', minLength: 1 } },
      required: ['kind', 'url'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { const: 'file' }, path: { type: 'string', minLength: 1 } },
      required: ['kind', 'path'],
      additionalProperties: false,
    },
  ],
} as const;

const VIDEO_APPROVAL_SCHEMA = {
  type: 'object',
  properties: {
    agent_id: { type: 'string', minLength: 1 },
  },
  required: ['agent_id'],
  additionalProperties: false,
} as const;

const VIDEO_COMMON_PROPERTIES = {
  language: { type: 'string' },
  max_keyframes: { type: 'integer', minimum: 0 },
  transcript_preference: { type: 'string', enum: ['auto', 'subtitles_only', 'stt_only'] },
  mission_id: { type: 'string' },
  tenant_slug: { type: 'string' },
  keep_source: { type: 'boolean' },
  approval: VIDEO_APPROVAL_SCHEMA,
} as const;

const FETCH_VIDEO_SCHEMA = {
  type: 'object',
  properties: { ...VIDEO_COMMON_PROPERTIES, source: VIDEO_SOURCE_SCHEMA, url: { type: 'string' } },
  additionalProperties: false,
  anyOf: [{ required: ['url'] }, { required: ['source'] }],
} as const;

const BUILD_VIDEO_BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    ...VIDEO_COMMON_PROPERTIES,
    source: VIDEO_SOURCE_SCHEMA,
    url: { type: 'string' },
    path: { type: 'string' },
    input_tier: TIER_SCHEMA,
  },
  additionalProperties: false,
  anyOf: [{ required: ['url'] }, { required: ['path'] }, { required: ['source'] }],
} as const;

const BOX_SCHEMA = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
  },
  required: ['x', 'y', 'width', 'height'],
} as const;

const MARK_ELEMENTS_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    session_id: { type: 'string', minLength: 1 },
    detectors: { type: 'array', items: { type: 'string' } },
    purpose: { type: 'string' },
    dom_elements: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ref: { type: 'string' }, bbox: BOX_SCHEMA },
        required: ['ref'],
      },
    },
    dom_scale: { type: 'number', exclusiveMinimum: 0 },
    scale: { type: 'number', exclusiveMinimum: 0 },
    language: { type: 'string' },
    ocr_mode: { type: 'string' },
    output_path: { type: 'string' },
    max_marks: { type: 'integer', minimum: 1 },
    tier: TIER_SCHEMA,
    mission_id: { type: 'string' },
    dom_snapshot_id: { type: 'string', minLength: 1 },
    display_index: { type: 'integer', minimum: 0 },
    display_origin: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
  required: ['path', 'session_id'],
} as const;

const DESCRIBE_SCREEN_DELTA_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    session_id: { type: 'string', minLength: 1 },
    grid: {
      oneOf: [
        { type: 'integer', minimum: 1 },
        {
          type: 'object',
          properties: {
            cols: { type: 'integer', minimum: 1 },
            rows: { type: 'integer', minimum: 1 },
          },
          required: ['cols', 'rows'],
          additionalProperties: false,
        },
      ],
    },
    tile_px: { type: 'integer', minimum: 1 },
    max_describe_per_call: { type: 'integer', minimum: 1 },
    tier: TIER_SCHEMA,
    tenant_slug: { type: 'string' },
    mission_id: { type: 'string' },
  },
  additionalProperties: false,
  required: ['path', 'session_id'],
} as const;

const VISION_SCHEMAS: Record<string, unknown> = {
  describe_image: DESCRIBE_IMAGE_SCHEMA,
  fetch_video: FETCH_VIDEO_SCHEMA,
  build_video_brief: BUILD_VIDEO_BRIEF_SCHEMA,
  mark_elements: MARK_ELEMENTS_SCHEMA,
  describe_screen_delta: DESCRIBE_SCREEN_DELTA_SCHEMA,
};

const VISION_EXAMPLES = {
  inspect_image: [{ path: 'active/shared/tmp/example.png' }],
  ocr_image: [{ path: 'active/shared/tmp/example.png', language: 'eng' }],
  describe_image: [{ path: 'active/shared/tmp/example.png', kind: 'brief' }],
  fetch_video: [
    {
      url: 'https://www.youtube.com/watch?v=example',
      language: 'en',
      approval: { agent_id: 'kyberion:operator' },
    },
  ],
  build_video_brief: [
    { path: 'active/shared/tmp/example.mp4', max_keyframes: 8 },
    { url: 'https://www.youtube.com/watch?v=example', transcript_preference: 'subtitles_only' },
  ],
  mark_elements: [{ path: 'active/shared/tmp/screen.png', session_id: 'example-session' }],
  describe_screen_delta: [
    {
      path: 'active/shared/tmp/screen.png',
      session_id: 'example-session',
      grid: 4,
      max_describe_per_call: 4,
    },
  ],
};

export const VISION_ACTUATOR_CAPTURE_OPS = [
  'inspect_image',
  'ocr_image',
  'describe_image',
  'fetch_video',
  'mark_elements',
  'describe_screen_delta',
] as const;

export const VISION_ACTUATOR_TRANSFORM_OPS = ['build_video_brief'] as const;

export const VISION_ACTUATOR_APPLY_OPS = [] as const;

function toSpec(op: string, kind: PipelineStepType) {
  return {
    op,
    kind,
    input_schema: VISION_SCHEMAS[op] ?? VISION_SCHEMA,
    examples: VISION_EXAMPLES[op as keyof typeof VISION_EXAMPLES],
  };
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...VISION_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...VISION_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...VISION_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
