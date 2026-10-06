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
  action: { type: 'string', enum: ['list', 'create', 'delete', 'add', 'remove', 'prune'] },
  name: { type: 'string' },
  message: { type: 'string' },
  add: { type: 'boolean' },
  title: { type: 'string' },
  body: { type: 'string' },
  base: { type: 'string' },
  remote: { type: 'string' },
  set_upstream: { type: 'boolean' },
  create_branch: { type: 'boolean' },
  path: { type: 'string' },
  state: { type: 'string', enum: ['open', 'closed', 'merged', 'all'] },
  fields: { type: 'string' },
  method: { type: 'string', enum: ['merge', 'squash', 'rebase'] },
  delete_branch: { type: 'boolean' },
  watch: { type: 'boolean' },
  interval_ms: { type: 'integer', minimum: 1000 },
  timeout_ms: { type: 'integer', minimum: 1000 },
  ignore_checks: { type: 'array', items: { type: 'string' } },
  draft: { type: 'boolean' },
  head: { type: 'string' },
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
  push: [{ remote: 'origin', ref: 'feat/x', set_upstream: true }],
  fetch: [{ remote: 'origin' }],
  pull: [{ remote: 'origin', ref: 'main' }],
  checkout: [{ ref: 'main', create_branch: false }],
  worktree: [{ action: 'add', path: '../wt', ref: 'feat/x' }],
  pr_view: [{ ref: '123', fields: 'number,title,state,url' }],
  pr_list: [{ state: 'open', limit: 50 }],
  pr_checks: [{ ref: '123', watch: true, timeout_ms: 1200000, interval_ms: 15000 }],
  pr_merge: [{ ref: '123', method: 'merge', delete_branch: true }],
  repo_view: [{}],
  gh_status: [{}],
};

export const VCS_ACTUATOR_CAPTURE_OPS = [
  'status',
  'diff',
  'log',
  'pr_view',
  'pr_list',
  'pr_checks',
  'repo_view',
  'gh_status',
] as const;

export const VCS_ACTUATOR_TRANSFORM_OPS = [] as const;

// Everything mutating repo/remote state (incl. fetch/pull writes to .git refs,
// branch create/delete, worktree add/remove) is classified apply/write.
export const VCS_ACTUATOR_APPLY_OPS = [
  'branch',
  'commit',
  'pr_create',
  'push',
  'fetch',
  'pull',
  'checkout',
  'worktree',
  'pr_merge',
] as const;

const REQUIRED = {
  commit: ['message'],
  pr_create: ['title'],
  branch: ['action'],
  checkout: ['ref'],
  worktree: ['action'],
  pr_view: ['ref'],
  pr_checks: ['ref'],
  pr_merge: ['ref'],
} as const;

function toSpec(op: string, kind: PipelineStepType) {
  const required = (REQUIRED as Record<string, readonly string[]>)[op] || [];
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
