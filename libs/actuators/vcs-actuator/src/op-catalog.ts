// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch switch
// in vcs-helpers.ts; check:op-registry fails on drift.

import type { PipelineStepType } from '../../../core/actuator/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator/actuator-sdk.js';

const VCS_PROPERTIES = {
  cwd: { type: 'string' },
  short: { type: 'boolean' },
  ref: { type: 'string' },
  stat: { type: 'boolean' },
  limit: { type: 'integer', minimum: 1 },
  oneline: { type: 'boolean' },
  action: { type: 'string', enum: ['list', 'create', 'delete'] },
  name: { type: 'string' },
  message: { type: 'string' },
  add: { type: 'boolean' },
  title: { type: 'string' },
  body: { type: 'string' },
  base: { type: 'string' },
};

const VCS_SCHEMA = {
  type: 'object',
  properties: VCS_PROPERTIES,
  additionalProperties: false,
} as const;

const VCS_EXAMPLES = {
  status: [{ short: true }],
  diff: [{ stat: true }],
  log: [{ limit: 10, oneline: true }],
  branch: [{ action: 'list' }],
  commit: [{ message: 'Checkpoint mission progress', add: true }],
  pr_create: [{ title: 'Add vcs-actuator', base: 'main' }],
};

export const VCS_ACTUATOR_CAPTURE_OPS = ['status', 'diff', 'log'] as const;

export const VCS_ACTUATOR_TRANSFORM_OPS = [] as const;

// branch lives here (not capture): action=create/delete mutates the working
// tree, so the op is classified apply/write even though action=list is read-only.
export const VCS_ACTUATOR_APPLY_OPS = ['branch', 'commit', 'pr_create'] as const;

function toSpec(op: string, kind: PipelineStepType) {
  const required =
    op === 'commit'
      ? ['message']
      : op === 'pr_create'
        ? ['title']
        : op === 'branch'
          ? ['action']
          : [];
  return {
    op,
    kind,
    input_schema: { ...VCS_SCHEMA, ...(required.length > 0 ? { required } : {}) },
    examples: VCS_EXAMPLES[op as keyof typeof VCS_EXAMPLES],
  };
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...VCS_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...VCS_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...VCS_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
