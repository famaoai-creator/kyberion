// Self-described operation catalog for the working-memory actuator.
// Keep this list aligned with the OPS dispatch table in index.ts and the
// capabilities declared in manifest.json.

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

const WORKING_MEMORY_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    scope: {
      type: 'string',
      enum: ['session', 'mission', 'project', 'personal', 'tenant', 'global'],
    },
    scope_ref: { type: 'string', minLength: 1 },
    tier: { type: 'string', enum: ['personal', 'confidential', 'public'] },
    section: { type: 'string', minLength: 1 },
    content: { type: 'string' },
    focus: { type: 'string' },
    nextAction: { type: 'string' },
    context: { type: 'string' },
    item: { type: 'string' },
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    weekKey: { type: 'string', pattern: '^\\d{4}-W\\d{2}$' },
    mdPath: { type: 'string', minLength: 1 },
    summary: { type: 'string' },
    source_ref: { type: 'string' },
    source_type: { type: 'string', enum: ['mission', 'task_session', 'artifact', 'incident'] },
    proposed_memory_kind: {
      type: 'string',
      enum: ['sop', 'template', 'heuristic', 'risk_rule', 'clarification_prompt'],
    },
    sensitivity_tier: { type: 'string', enum: ['personal', 'confidential', 'public'] },
    evidence_refs: { type: 'array', items: { type: 'string' } },
    trusted: { type: 'boolean' },
    export_as: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const;

const WORKING_MEMORY_OPS = [
  ['note', 'apply'],
  ['set-now', 'apply'],
  ['add-action-item', 'apply'],
  ['complete-action-item', 'apply'],
  ['daily-open', 'apply'],
  ['todo-add', 'apply'],
  ['todo-done', 'apply'],
  ['todo-rollover', 'apply'],
  ['weekly-open', 'apply'],
  ['nominate-promotion', 'apply'],
  ['consolidation-status', 'capture'],
  ['run-gc', 'apply'],
  ['build-index', 'apply'],
  ['read', 'capture'],
  ['list', 'capture'],
] as const satisfies ReadonlyArray<readonly [string, PipelineStepType]>;

export function describeOps(): ActuatorOpDescription[] {
  return WORKING_MEMORY_OPS.map(([op, kind]) => ({
    op,
    kind,
    input_schema: WORKING_MEMORY_INPUT_SCHEMA,
    examples: [{}],
  }));
}
