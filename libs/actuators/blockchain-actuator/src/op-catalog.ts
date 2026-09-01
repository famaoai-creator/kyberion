// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the op dispatch in
// this actuator's source; check:op-registry fails on drift.
//
// Kind notes: none of these ops appear in the shared pools, so every entry
// is strictly additive — determineActuatorStepType previously threw
// unknown-op for all of them.

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

const BLOCKCHAIN_SCHEMA = {
  type: 'object',
  properties: {
    agent_id: { type: 'string' },
    hash: { type: 'string' },
    mission_id: { type: 'string' },
    score: { type: 'number' },
    tx_metadata: { type: 'object', properties: {}, additionalProperties: false },
  },
  additionalProperties: false,
} as const;

const BLOCKCHAIN_EXAMPLES = {
  anchor_mission: [{ mission_id: 'MSN-20260826-001', hash: 'sha256:example' }],
  anchor_trust: [{ agent_id: 'agent-1', score: 0.95 }],
  verify_anchor: [{ mission_id: 'MSN-20260826-001' }],
};

export const BLOCKCHAIN_ACTUATOR_CAPTURE_OPS = ['verify_anchor'] as const;

export const BLOCKCHAIN_ACTUATOR_TRANSFORM_OPS = [] as const;

export const BLOCKCHAIN_ACTUATOR_APPLY_OPS = ['anchor_mission', 'anchor_trust'] as const;

function toSpec(op: string, kind: PipelineStepType) {
  const required =
    op === 'anchor_mission'
      ? ['mission_id', 'hash']
      : op === 'anchor_trust'
        ? ['agent_id', 'score']
        : [];
  return {
    op,
    kind,
    input_schema: {
      ...BLOCKCHAIN_SCHEMA,
      ...(required.length > 0
        ? { required }
        : { anyOf: [{ required: ['mission_id'] }, { required: ['agent_id'] }] }),
    },
    examples: BLOCKCHAIN_EXAMPLES[op as keyof typeof BLOCKCHAIN_EXAMPLES],
  };
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...BLOCKCHAIN_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...BLOCKCHAIN_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...BLOCKCHAIN_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
