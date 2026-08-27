import { withCatalogInputContract } from '@agent/core';

// AR-02: self-described op catalog replacing the hand-curated registry
// entry, which listed ops this actuator never dispatched (list/read/log/
// notify came from the shared pools anyway) while omitting the real op
// surface. Removed curated ops fall back to the shared pools with the same
// kind, so step-type inference is unchanged; the added ops were previously
// unclassifiable (pipelines reach them via explicit role today).

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

type InputSchema = Record<string, unknown>;
const EMPTY_SCHEMA: InputSchema = { type: 'object', properties: {}, additionalProperties: false };
const ORCHESTRATOR_CONTRACTS: Record<string, InputSchema> = {
  discover_capabilities: EMPTY_SCHEMA,
  discover_skills: EMPTY_SCHEMA,
  decompose_into_tasks: {
    type: 'object',
    properties: {
      design_spec_path: { type: 'string' },
      export_as: { type: 'string' },
      mission_id: { type: 'string' },
      project_name: { type: 'string' },
      requirements_draft_path: { type: 'string' },
    },
    additionalProperties: false,
  },
  evaluate_task_plan_ready: {
    type: 'object',
    properties: { export_as: { type: 'string' }, mission_id: { type: 'string' } },
    additionalProperties: false,
  },
  execute_task_plan: {
    type: 'object',
    properties: {
      cwd: { type: 'string' },
      export_as: { type: 'string' },
      halt_on_failure: { type: 'boolean' },
      max_tasks: { type: 'number' },
      mission_id: { type: 'string' },
      model: { type: 'string' },
    },
    additionalProperties: false,
  },
  deploy: {
    type: 'object',
    properties: {
      environment: { type: 'string' },
      export_as: { type: 'string' },
      project_id: { type: 'string' },
      target: { type: 'string' },
    },
    additionalProperties: false,
  },
  run_execution_plan_set: {
    type: 'object',
    properties: { export_as: { type: 'string' }, from: { type: 'string' } },
    additionalProperties: false,
  },
  task_plan_to_next_tasks: {
    type: 'object',
    properties: { export_as: { type: 'string' }, mission_id: { type: 'string' } },
    additionalProperties: false,
  },
};

const ORCHESTRATOR_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  discover_capabilities: [{}],
  discover_skills: [{}],
  decompose_into_tasks: [{ mission_id: 'MSN-20260826-001', project_name: 'kyberion' }],
  evaluate_task_plan_ready: [{ mission_id: 'MSN-20260826-001' }],
  execute_task_plan: [{ mission_id: 'MSN-20260826-001', max_tasks: 10 }],
  deploy: [{ environment: 'staging', target: 'preview' }],
  run_execution_plan_set: [{ from: 'execution_plan_set' }],
  task_plan_to_next_tasks: [{ mission_id: 'MSN-20260826-001' }],
};

export const ORCHESTRATOR_ACTUATOR_CAPTURE_OPS = [
  'discover_capabilities',
  'discover_skills',
] as const;

export const ORCHESTRATOR_ACTUATOR_TRANSFORM_OPS = [] as const;

export const ORCHESTRATOR_ACTUATOR_APPLY_OPS = [
  'decompose_into_tasks',
  'deploy',
  'evaluate_task_plan_ready',
  'execute_task_plan',
  'run_execution_plan_set',
  'task_plan_to_next_tasks',
] as const;

function toSpec(op: string, kind: OpSpecKind) {
  const schema = ORCHESTRATOR_CONTRACTS[op];
  const description = schema
    ? { op, kind, input_schema: schema, examples: ORCHESTRATOR_EXAMPLES[op] || [{}] }
    : { op, kind };
  return withCatalogInputContract('orchestrator', op, kind, description);
}

export function describeOps() {
  return [
    ...ORCHESTRATOR_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...ORCHESTRATOR_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...ORCHESTRATOR_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
