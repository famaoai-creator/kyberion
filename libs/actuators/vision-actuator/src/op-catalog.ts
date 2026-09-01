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
  },
  additionalProperties: false,
  required: ['path'],
} as const;

const VISION_EXAMPLES = {
  inspect_image: [{ path: 'active/shared/tmp/example.png' }],
  ocr_image: [{ path: 'active/shared/tmp/example.png', language: 'eng' }],
  describe_image: [{ path: 'active/shared/tmp/example.png', kind: 'brief' }],
};

export const VISION_ACTUATOR_CAPTURE_OPS = [
  'inspect_image',
  'ocr_image',
  'describe_image',
] as const;

export const VISION_ACTUATOR_TRANSFORM_OPS = [] as const;

export const VISION_ACTUATOR_APPLY_OPS = [] as const;

function toSpec(op: string, kind: PipelineStepType) {
  return {
    op,
    kind,
    input_schema: VISION_SCHEMA,
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
