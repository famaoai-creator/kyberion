// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the op dispatch in
// scheduler-helpers.ts; check:op-registry fails on drift.

import type { PipelineStepType } from '../../../core/actuator/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator/actuator-sdk.js';

const SCHEDULER_PROPERTIES = {
  id: { type: 'string', minLength: 1 },
  cron: { type: 'string', minLength: 1 },
  payload: { type: 'object' },
  enabled: { type: 'boolean' },
};

const SCHEDULER_SCHEMA = {
  type: 'object',
  properties: SCHEDULER_PROPERTIES,
  additionalProperties: false,
} as const;

const SCHEDULER_EXAMPLES = {
  schedule: [{ cron: '0 9 * * 1', payload: { pipeline: 'pipelines/morning-brief.json' } }],
  list: [{}],
  cancel: [{ id: 'sch-morning-brief' }],
  fire: [{ id: 'sch-morning-brief' }],
};

export const SCHEDULER_ACTUATOR_CAPTURE_OPS = ['list'] as const;

export const SCHEDULER_ACTUATOR_TRANSFORM_OPS = [] as const;

export const SCHEDULER_ACTUATOR_APPLY_OPS = ['schedule', 'cancel', 'fire'] as const;

function toSpec(op: string, kind: PipelineStepType) {
  const schema = {
    ...SCHEDULER_SCHEMA,
    ...(op === 'schedule'
      ? { required: ['cron', 'payload'] }
      : op === 'cancel' || op === 'fire'
        ? { required: ['id'] }
        : {}),
  };
  return {
    op,
    kind,
    input_schema: schema,
    examples: SCHEDULER_EXAMPLES[op as keyof typeof SCHEDULER_EXAMPLES],
  };
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...SCHEDULER_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...SCHEDULER_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...SCHEDULER_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
