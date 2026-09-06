// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the op dispatch in
// this actuator's source; check:op-registry fails on drift.
//
// Kind notes: none of these ops appear in the shared pools, so every entry
// is strictly additive — determineActuatorStepType previously threw
// unknown-op for all of them.

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

const EMAIL_SCHEMA = {
  type: 'object',
  properties: {
    backend: { type: 'string' },
    to: { type: 'string' },
    cc: { type: 'string' },
    subject: { type: 'string' },
    body: { type: 'string' },
    body_file: { type: 'string' },
    from: { type: 'string' },
    export_as: { type: 'string' },
  },
  additionalProperties: false,
};

const EMAIL_EXAMPLES = {
  create_draft: [{ to: 'operator@example.com', subject: 'Draft', body: '内容' }],
  send: [{ to: 'operator@example.com', subject: 'Notice', body: '内容' }],
  send_from_file: [
    { to: 'operator@example.com', subject: 'Notice', body_file: 'active/shared/tmp/body.txt' },
  ],
};

export const EMAIL_ACTUATOR_CAPTURE_OPS = [] as const;

export const EMAIL_ACTUATOR_TRANSFORM_OPS = [] as const;

export const EMAIL_ACTUATOR_APPLY_OPS = ['create_draft', 'send', 'send_from_file'] as const;

function toSpec(op: string, kind: PipelineStepType) {
  return {
    op,
    kind,
    input_schema: {
      ...EMAIL_SCHEMA,
      required: op === 'send_from_file' ? ['to', 'body_file'] : ['to', 'subject'],
    },
    examples: EMAIL_EXAMPLES[op as keyof typeof EMAIL_EXAMPLES],
  };
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...EMAIL_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...EMAIL_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...EMAIL_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
