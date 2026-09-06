// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch switch
// in artifact-actuator-helpers.ts; check:op-registry fails on drift.
//
// Kind notes: ops that previously classified via the shared pools keep their
// historical kind (e.g. list -> capture) so step-type inference does not
// change; every other op previously made determineActuatorStepType throw, so
// those entries are strictly additive.

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

const ARTIFACT_PROPERTIES = {
  artifacts: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        kind: { type: 'string' },
        path: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['id', 'kind', 'path'],
      additionalProperties: false,
    },
  },
  artifactsByRole: {
    type: 'object',
    properties: {
      primary: { type: 'array', items: { type: 'string' } },
      specification: { type: 'array', items: { type: 'string' } },
      evidence: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  conversationSummary: { type: 'string' },
  logicalDir: { type: 'string' },
  logicalPath: { type: 'string' },
  mainArtifactId: { type: 'string' },
  packId: { type: 'string' },
  recommendedNextAction: { type: 'string' },
  requestText: { type: 'string' },
  role: { type: 'string' },
  summary: { type: 'string' },
  value: {},
};

const ARTIFACT_SCHEMA = {
  type: 'object',
  properties: ARTIFACT_PROPERTIES,
  additionalProperties: false,
} as const;

const ARTIFACT_EXAMPLES = {
  write_json: [{ logicalPath: 'active/shared/tmp/result.json', value: { ok: true } }],
  append_event: [{ logicalPath: 'active/shared/tmp/events.jsonl', value: { event: 'completed' } }],
  read_json: [{ logicalPath: 'active/shared/tmp/result.json' }],
  list: [{ logicalDir: 'active/shared/tmp' }],
  ensure_dir: [{ logicalDir: 'active/shared/tmp/results' }],
  write_delivery_pack: [
    {
      logicalDir: 'active/shared/tmp/delivery',
      packId: 'pack-20260826',
      summary: 'Delivery summary',
    },
  ],
};

const REQUIRED_FIELDS: Record<string, string[]> = {
  write_json: ['logicalPath'],
  append_event: ['logicalPath'],
  read_json: ['logicalPath'],
  list: ['logicalDir'],
  ensure_dir: ['logicalDir'],
  write_delivery_pack: ['logicalDir'],
};

export const ARTIFACT_ACTUATOR_CAPTURE_OPS = ['read_json', 'list'] as const;

export const ARTIFACT_ACTUATOR_TRANSFORM_OPS = [] as const;

export const ARTIFACT_ACTUATOR_APPLY_OPS = [
  'write_json',
  'append_event',
  'ensure_dir',
  'write_delivery_pack',
] as const;

function toSpec(op: string, kind: PipelineStepType) {
  return {
    op,
    kind,
    input_schema: { ...ARTIFACT_SCHEMA, required: REQUIRED_FIELDS[op] },
    examples: ARTIFACT_EXAMPLES[op as keyof typeof ARTIFACT_EXAMPLES],
  };
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...ARTIFACT_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...ARTIFACT_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...ARTIFACT_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
