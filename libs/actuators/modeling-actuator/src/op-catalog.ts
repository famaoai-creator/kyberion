// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch
// switches in the pipeline helpers; check:op-registry fails on drift.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const MODELING_ACTUATOR_CAPTURE_OPS = [
  'glob_files',
  'read_file',
  'read_json',
  'shell',
] as const;

export const MODELING_ACTUATOR_TRANSFORM_OPS = [
  'ajv_validate',
  'json_query',
  'mermaid_gen',
  'terraform_to_architecture_adf',
  'terraform_to_topology_ir',
  'test_inventory_to_browser_pipeline',
  'test_inventory_to_device_pipeline',
  'ui_flow_to_test_inventory',
  'web_profile_to_ui_flow_adf',
] as const;

export const MODELING_ACTUATOR_APPLY_OPS = [
  'derive_test_inventory',
  'evaluate_architecture_ready',
  'evaluate_customer_signoff',
  'evaluate_qa_ready',
  'evaluate_requirements_completeness',
  'extract_design_spec',
  'extract_requirements',
  'extract_test_plan',
  'log',
  'write_artifact',
  'write_file',
] as const;

export const MODELING_ACTUATOR_CONTROL_OPS = ['if', 'while'] as const;

const toSpec = (op: string, kind: OpSpecKind) => ({ op, kind });

export function describeOps() {
  return [
    ...MODELING_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...MODELING_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...MODELING_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
    ...MODELING_ACTUATOR_CONTROL_OPS.map((op) => toSpec(op, 'control')),
  ];
}
