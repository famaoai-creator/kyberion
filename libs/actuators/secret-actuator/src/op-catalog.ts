// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch switch
// in secret-actuator-helpers.ts; check:op-registry fails on drift.
//
// Kind notes: ops that previously classified via the shared pools keep their
// historical kind (e.g. list -> capture, set -> transform) so step-type inference does not
// change; every other op previously made determineActuatorStepType throw, so
// those entries are strictly additive.

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

const SECRET_SCHEMA = {
  type: 'object',
  properties: {
    account: { type: 'string' },
    export_as: { type: 'string' },
    service: { type: 'string' },
    value: { type: 'string' },
  },
  additionalProperties: false,
} as const;

const SECRET_EXAMPLES = {
  get: [{ service: 'github', account: 'api-token', export_as: 'token' }],
  list: [{ service: 'github' }],
  set: [{ service: 'github', account: 'api-token', value: 'use-secret-reference' }],
  delete: [{ service: 'github', account: 'api-token' }],
};

export const SECRET_ACTUATOR_CAPTURE_OPS = ['get', 'list'] as const;

export const SECRET_ACTUATOR_TRANSFORM_OPS = ['set'] as const;

export const SECRET_ACTUATOR_APPLY_OPS = ['delete'] as const;

function toSpec(op: string, kind: PipelineStepType) {
  const required =
    op === 'set'
      ? ['service', 'account', 'value']
      : op === 'delete'
        ? ['service', 'account']
        : ['service'];
  return {
    op,
    kind,
    input_schema: { ...SECRET_SCHEMA, required },
    examples: SECRET_EXAMPLES[op as keyof typeof SECRET_EXAMPLES],
  };
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...SECRET_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...SECRET_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...SECRET_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
