// AR-02: self-described op catalog — the single source for Wisdom operation
// kind, ownership, compatibility metadata, and discovery generation.
// Runtime dispatch validates against this catalog before reaching a handler.

import type { WisdomOperationExecutor, WisdomOperationSpec } from './contracts/wisdom-operation.js';
import type { WisdomContext } from './contracts/wisdom-context.js';
import { DEPRECATED_WISDOM_ALIASES } from './compatibility/legacy-aliases.js';
import { withCatalogInputContract } from '../../../core/actuator-sdk.js';

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

const WISDOM_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    actuator: { type: 'string' },
    append_to: { type: 'string' },
    condition: { type: 'string' },
    context: {},
    context_fragments_from: { type: 'string' },
    context_label: { type: 'string' },
    convergence_severity: { type: 'number' },
    convergence_threshold: { type: 'number' },
    cost_cap_tokens: { type: 'number' },
    count_all: { type: 'boolean' },
    else: { type: 'array' },
    execution_mode: { type: 'string' },
    export_as: { type: 'string' },
    field: { type: 'string' },
    fr: {},
    from: { type: 'string' },
    goal: { type: 'string' },
    idempotency_key: { type: 'string' },
    include_scheduled: { type: 'boolean' },
    instruction: { type: 'string' },
    knowledge_path: { type: 'string' },
    analogy: { type: 'string' },
    anchor: { type: 'string' },
    append: { type: 'boolean' },
    allow_backend_delegation: { type: 'boolean' },
    candidate_fragments: { type: 'array' },
    limit: { type: 'number' },
    max_iterations: { type: 'number' },
    max_results: { type: 'number' },
    max_steps: { type: 'number' },
    max_steps_per_branch: { type: 'number' },
    mean_convergence: { type: 'number' },
    message: { type: 'string' },
    min_hypotheses_per_participant: { type: 'number' },
    min_hypotheses_per_persona: { type: 'number' },
    min_score: { type: 'number' },
    mission_id: { type: 'string' },
    mode: { type: 'string' },
    model_tier: { type: 'string' },
    new_signals: {},
    nodes: { type: 'array' },
    op: { type: 'string' },
    options: {},
    origin_agent_id: { type: 'string' },
    origin_project_id: { type: 'string' },
    origin_tenant_id: { type: 'string' },
    objective: { type: 'string' },
    output_dir: { type: 'string' },
    output_path: { type: 'string' },
    output_tier: { type: 'string' },
    package_id: { type: 'string' },
    package_path: { type: 'string' },
    participants: { type: 'array' },
    participants_from: { type: 'string' },
    path: { type: 'string' },
    pattern: { type: 'string' },
    persona: {},
    persona_from: { type: 'string' },
    personas_from: { type: 'string' },
    pipeline: { type: 'array' },
    preferred_label: { type: 'string' },
    preferred_provider: { type: 'string' },
    promotion_approval_id: { type: 'string' },
    prompt: { type: 'string' },
    query: { type: 'string' },
    question: { type: 'string' },
    refresh_public_index: { type: 'boolean' },
    requested_target_tier: { type: 'string' },
    runs: { type: 'number' },
    session_id: { type: 'string' },
    severity_from: { type: 'string' },
    signals_from: { type: 'string' },
    skill_path: { type: 'string' },
    source_path: { type: 'string' },
    source: { type: 'string' },
    source_tier: { type: 'string' },
    sources: { type: 'array' },
    system_prompt: { type: 'string' },
    tags: { type: 'array' },
    tags_from: { type: 'string' },
    template: { type: 'string' },
    tenant_slug: { type: 'string' },
    topic: { type: 'string' },
    execution_profile: { type: 'string' },
    session_log_path: { type: 'string' },
    proposal_path: { type: 'string' },
    readiness_ref: { type: 'string' },
    signals: {},
    decision: { type: 'string' },
    then: { type: 'array' },
    threshold: { type: 'number' },
    tier: { type: 'string' },
    time_budget_minutes: { type: 'number' },
    tone: { type: 'string' },
    tools: { type: 'array' },
    deferred_tools: { type: 'array' },
    use_subagent: { type: 'boolean' },
    value: {},
    vetoed_options: {},
    vetoed_options_from: { type: 'string' },
    visibility: { type: 'string' },
    where: {},
    yellow_threshold: { type: 'number' },
  },
  additionalProperties: false,
};

export const WISDOM_ACTUATOR_CAPTURE_OPS = [
  'glob_files',
  'history_search',
  'knowledge_search',
  'knowledge_read',
  'query',
  'read_file',
  'read_json',
  'shell',
] as const;

export const WISDOM_ACTUATOR_TRANSFORM_OPS = [
  'array_count',
  'json_query',
  'regex_extract',
  'regex_replace',
  'yaml_update',
] as const;

export const WISDOM_ACTUATOR_APPLY_OPS = [
  'a2a_fanout',
  'perspective_fanout',
  'a2a_roleplay',
  'counterparty_roleplay',
  'adjust_proposal',
  'audit_speaker_fairness',
  'capture_intuition',
  'compute_readiness_matrix',
  'conduct_1on_1',
  'conduct_1on1',
  'curate_background_review',
  'curation_report',
  'knowledge_validation_sweep',
  'cross_critique',
  'typed_cross_critique',
  'decompose_into_tasks',
  'deploy_release',
  'distill',
  'derive_test_inventory',
  'emit_dissent_log',
  'escalate_for_review',
  'evaluate_architecture_ready',
  'evaluate_customer_signoff',
  'evaluate_decision_rights_approval',
  'evaluate_ensemble_convergence',
  'evaluate_qa_ready',
  'evaluate_requirements_completeness',
  'evaluate_simulation_quality',
  'evaluate_task_plan_ready',
  'execute_self_action_items',
  'execute_task_plan',
  'extract_action_items',
  'extract_design_spec',
  'extract_dissent_signals',
  'extract_requirements',
  'extract_test_plan',
  'find_slides_by_owner',
  'fork_branches',
  'generate_facilitation_script',
  'generate_reminder_message',
  'inject_prior_knowledge',
  'knowledge_export',
  'knowledge_import',
  'knowledge_inject',
  'log',
  'peer_advice',
  'pptx_diff',
  'propose_tool_calls',
  'react_loop',
  'reasoning_loop',
  'reasoning',
  'recommend',
  'register_presentation_preference_profile',
  'render_hypothesis_report',
  'resolve_hypothesis_conflict',
  'simulate_all',
  'simulate_all_ensemble',
  'stakeholder_grid_sort',
  'synthesize_counterparty_persona',
  'task_plan_to_next_tasks',
  'tool_use',
  'track_pending_action_items',
  'transcribe_audio',
  'uncertainty_gate',
  'write_artifact',
  'write_file',
] as const;

export const WISDOM_ACTUATOR_CONTROL_OPS = ['if', 'while'] as const;

const FORWARD_TARGETS: Record<string, { actuator: string; op: string }> = {
  read_file: { actuator: 'file', op: 'read_file' },
  read_json: { actuator: 'file', op: 'read_json' },
  glob_files: { actuator: 'file', op: 'list' },
  write_file: { actuator: 'file', op: 'write_file' },
  write_artifact: { actuator: 'file', op: 'write_artifact' },
  shell: { actuator: 'terminal', op: 'shell_command' },
  find_slides_by_owner: { actuator: 'media', op: 'find_slides_by_owner' },
  pptx_diff: { actuator: 'media', op: 'pptx_diff' },
  register_presentation_preference_profile: {
    actuator: 'media',
    op: 'register_presentation_preference_profile',
  },
  transcribe_audio: { actuator: 'voice', op: 'transcribe' },
  extract_action_items: { actuator: 'meeting', op: 'extract_action_items' },
  generate_facilitation_script: { actuator: 'meeting', op: 'generate_facilitation_script' },
  generate_reminder_message: { actuator: 'meeting', op: 'generate_reminder_message' },
  conduct_1on_1: { actuator: 'meeting', op: 'conduct_1on_1' },
  conduct_1on1: { actuator: 'meeting', op: 'conduct_1on_1' },
  execute_self_action_items: { actuator: 'meeting', op: 'execute_self_action_items' },
  track_pending_action_items: { actuator: 'meeting', op: 'track_pending_action_items' },
  audit_speaker_fairness: { actuator: 'meeting', op: 'audit_speaker_fairness' },
  execute_task_plan: { actuator: 'orchestrator', op: 'execute_task_plan' },
  deploy_release: { actuator: 'deployment', op: 'deploy_release' },
  extract_requirements: { actuator: 'modeling', op: 'extract_requirements' },
  extract_design_spec: { actuator: 'modeling', op: 'extract_design_spec' },
  extract_test_plan: { actuator: 'modeling', op: 'extract_test_plan' },
  evaluate_requirements_completeness: {
    actuator: 'modeling',
    op: 'evaluate_requirements_completeness',
  },
  evaluate_customer_signoff: { actuator: 'modeling', op: 'evaluate_customer_signoff' },
  evaluate_architecture_ready: { actuator: 'modeling', op: 'evaluate_architecture_ready' },
  derive_test_inventory: { actuator: 'modeling', op: 'derive_test_inventory' },
  evaluate_qa_ready: { actuator: 'modeling', op: 'evaluate_qa_ready' },
  decompose_into_tasks: { actuator: 'orchestrator', op: 'decompose_into_tasks' },
  evaluate_task_plan_ready: { actuator: 'orchestrator', op: 'evaluate_task_plan_ready' },
  task_plan_to_next_tasks: { actuator: 'orchestrator', op: 'task_plan_to_next_tasks' },
  evaluate_decision_rights_approval: { actuator: 'approval', op: 'evaluate_decision_rights' },
  escalate_for_review: { actuator: 'approval', op: 'request_review' },
};

const ENSEMBLE_OPS = new Set([
  'a2a_fanout',
  'perspective_fanout',
  'cross_critique',
  'typed_cross_critique',
  'simulate_all_ensemble',
  'evaluate_ensemble_convergence',
]);

const SINGLE_REASONING_OPS = new Set([
  'reasoning',
  'peer_advice',
  'synthesize_counterparty_persona',
  'a2a_roleplay',
  'counterparty_roleplay',
  'conduct_1on1',
  'extract_requirements',
  'extract_design_spec',
  'extract_test_plan',
  'decompose_into_tasks',
  'propose_tool_calls',
  'tool_use',
  'react_loop',
  'reasoning_loop',
]);

const IDEMPOTENCY_BY_OP: Record<string, WisdomOperationSpec['idempotency']> = {
  knowledge_search: 'read',
  knowledge_read: 'read',
  history_search: 'read',
  query: 'read',
  glob_files: 'read',
  read_file: 'read',
  read_json: 'read',
  knowledge_inject: 'idempotent_write',
  knowledge_export: 'idempotent_write',
  knowledge_import: 'idempotent_write',
  // KP-06: recomputes + overwrites CURATION_REPORT.md deterministically from
  // the KP-05 usage aggregate + corpus frontmatter — safe to retry.
  curation_report: 'idempotent_write',
  knowledge_validation_sweep: 'read',
  execute_task_plan: 'external_effect',
  execute_self_action_items: 'external_effect',
  track_pending_action_items: 'external_effect',
  escalate_for_review: 'external_effect',
  deploy_release: 'external_effect',
  shell: 'external_effect',
  write_file: 'external_effect',
  write_artifact: 'external_effect',
  transcribe_audio: 'external_effect',
};

const WISDOM_REQUIRED_INPUTS: Record<string, string[]> = {
  a2a_fanout: ['personas', 'min_hypotheses_per_persona', 'topic', 'output_path'],
  perspective_fanout: [
    'participants',
    'min_hypotheses_per_participant',
    'topic',
    'output_path',
    'output_tier',
  ],
  typed_cross_critique: ['source_path', 'participants', 'output_path', 'output_tier'],
  cross_critique: ['source_path', 'personas', 'output_path'],
  synthesize_counterparty_persona: ['source_path'],
  a2a_roleplay: ['persona', 'objective', 'time_budget_minutes', 'output_path'],
  extract_dissent_signals: ['session_log_path', 'output_path'],
  fork_branches: [
    'source',
    'execution_profile',
    'cost_cap_tokens',
    'max_steps_per_branch',
    'output_dir',
  ],
  simulate_all: ['goal', 'output_dir'],
  simulate_all_ensemble: ['goal', 'runs', 'output_dir'],
  emit_dissent_log: ['source_path', 'output_path'],
  render_hypothesis_report: ['source_path', 'output_path'],
  resolve_hypothesis_conflict: ['source_path', 'output_path'],
  adjust_proposal: ['proposal_path', 'signals'],
  capture_intuition: ['decision', 'anchor', 'analogy'],
};

function toSpec(op: string, kind: PipelineStepType) {
  const canonicalOp = DEPRECATED_WISDOM_ALIASES[op as keyof typeof DEPRECATED_WISDOM_ALIASES];
  const forwardTo = FORWARD_TARGETS[op];
  const executionKind = ENSEMBLE_OPS.has(op)
    ? ('reasoning_ensemble' as const)
    : SINGLE_REASONING_OPS.has(op)
      ? ('reasoning_single' as const)
      : ('deterministic' as const);
  return withCatalogInputContract('wisdom', op, kind, {
    op,
    kind,
    owner: forwardTo?.actuator || 'wisdom',
    input_schema: WISDOM_REQUIRED_INPUTS[op]
      ? { ...WISDOM_INPUT_SCHEMA, required: WISDOM_REQUIRED_INPUTS[op] }
      : WISDOM_INPUT_SCHEMA,
    examples: [{ export_as: 'result' }],
    idempotency: IDEMPOTENCY_BY_OP[op] || 'non_idempotent',
    execution_kind: executionKind,
    ...(canonicalOp ? { canonical_op: canonicalOp, deprecated: true } : {}),
    ...(forwardTo ? { forward_to: forwardTo } : {}),
  });
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...WISDOM_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...WISDOM_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...WISDOM_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
    ...WISDOM_ACTUATOR_CONTROL_OPS.map((op) => toSpec(op, 'control')),
  ];
}

type CatalogSpec = ReturnType<typeof toSpec> & { kind: Exclude<PipelineStepType, 'control'> };

const OPERATION_REGISTRY = new Map(
  describeOps()
    .filter((spec): spec is CatalogSpec => spec.kind !== 'control')
    .map((descriptor) => [descriptor.op, descriptor] as const)
);

export function getWisdomOperationSpec(op: string): CatalogSpec | undefined {
  return OPERATION_REGISTRY.get(op);
}

export function buildWisdomOperationRegistry(
  execute: WisdomOperationExecutor
): Record<string, WisdomOperationSpec> {
  return Object.fromEntries(
    [...OPERATION_REGISTRY.entries()].map(([op, descriptor]) => [
      op,
      {
        op,
        kind: descriptor.kind,
        inputSchema: descriptor.input_schema,
        execute: (input: unknown, context: WisdomContext) => execute(op, input, context),
        idempotency: descriptor.idempotency,
        owner: descriptor.owner,
        ...(descriptor.deprecated ? { deprecated: true } : {}),
        ...(descriptor.forward_to ? { forwardTo: descriptor.forward_to } : {}),
        ...(descriptor.canonical_op ? { canonicalOp: descriptor.canonical_op } : {}),
        executionKind: descriptor.execution_kind,
      },
    ])
  );
}
