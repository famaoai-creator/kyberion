// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch
// switches in the pipeline helpers; check:op-registry fails on drift.
// The apply list includes the decision ops served by dispatchDecisionOp.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const WISDOM_ACTUATOR_CAPTURE_OPS = [
  'glob_files',
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
  'adjust_proposal',
  'audit_speaker_fairness',
  'capture_intuition',
  'compute_readiness_matrix',
  'conduct_1on1',
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
  'react_loop',
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

const toSpec = (op: string, kind: OpSpecKind) => ({ op, kind });

export function describeOps() {
  return [
    ...WISDOM_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...WISDOM_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...WISDOM_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
    ...WISDOM_ACTUATOR_CONTROL_OPS.map((op) => toSpec(op, 'control')),
  ];
}
