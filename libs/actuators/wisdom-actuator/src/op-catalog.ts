// AR-02: self-described op catalog — the single source for Wisdom operation
// kind, ownership, compatibility metadata, and discovery generation.
// Runtime dispatch validates against this catalog before reaching a handler.

import type { WisdomOperationExecutor, WisdomOperationSpec } from './contracts/wisdom-operation.js';
import type { WisdomContext } from './contracts/wisdom-context.js';
import { DEPRECATED_WISDOM_ALIASES } from './compatibility/legacy-aliases.js';

export type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const WISDOM_ACTUATOR_CAPTURE_OPS = [
  'glob_files',
  'history_search',
  'knowledge_search',
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
  'conduct_1on1',
  'curate_background_review',
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
  find_slides_by_owner: { actuator: 'media', op: 'pptx_filter_slides' },
  pptx_diff: { actuator: 'media', op: 'pptx_diff' },
  transcribe_audio: { actuator: 'voice', op: 'transcribe' },
  extract_action_items: { actuator: 'meeting', op: 'extract_action_items' },
  generate_facilitation_script: { actuator: 'meeting', op: 'generate_facilitation_script' },
  generate_reminder_message: { actuator: 'meeting', op: 'generate_reminder_message' },
  conduct_1on1: { actuator: 'meeting', op: 'conduct_1on1' },
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
  history_search: 'read',
  query: 'read',
  glob_files: 'read',
  read_file: 'read',
  read_json: 'read',
  knowledge_inject: 'idempotent_write',
  knowledge_export: 'idempotent_write',
  knowledge_import: 'idempotent_write',
};

function toSpec(op: string, kind: OpSpecKind) {
  const canonicalOp = DEPRECATED_WISDOM_ALIASES[op as keyof typeof DEPRECATED_WISDOM_ALIASES];
  const forwardTo = FORWARD_TARGETS[op];
  const executionKind = ENSEMBLE_OPS.has(op)
    ? ('reasoning_ensemble' as const)
    : SINGLE_REASONING_OPS.has(op)
      ? ('reasoning_single' as const)
      : ('deterministic' as const);
  return {
    op,
    kind,
    owner: forwardTo?.actuator || 'wisdom',
    inputSchema: { type: 'object' },
    idempotency: IDEMPOTENCY_BY_OP[op] || 'non_idempotent',
    execution_kind: executionKind,
    ...(canonicalOp ? { canonical_op: canonicalOp, deprecated: true } : {}),
    ...(forwardTo ? { forward_to: forwardTo } : {}),
  };
}

export function describeOps() {
  return [
    ...WISDOM_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...WISDOM_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...WISDOM_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
    ...WISDOM_ACTUATOR_CONTROL_OPS.map((op) => toSpec(op, 'control')),
  ];
}

type CatalogSpec = ReturnType<typeof toSpec> & { kind: Exclude<OpSpecKind, 'control'> };

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
        inputSchema: descriptor.inputSchema,
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
