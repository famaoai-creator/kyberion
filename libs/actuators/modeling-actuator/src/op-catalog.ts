import { withCatalogInputContract } from '../../../core/actuator-sdk.js';

// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch
// switches in the pipeline helpers; check:op-registry fails on drift.

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

type InputSchema = Record<string, unknown>;
const MODELING_CONTRACTS: Record<string, InputSchema> = {
  glob_files: {
    type: 'object',
    properties: {
      dir: { type: 'string' },
      export_as: { type: 'string' },
      ext: { type: 'string' },
    },
    required: ['dir'],
    additionalProperties: false,
  },
  read_file: {
    type: 'object',
    properties: { export_as: { type: 'string' }, path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  read_json: {
    type: 'object',
    properties: { export_as: { type: 'string' }, path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  shell: {
    type: 'object',
    properties: { cmd: { type: 'string' }, export_as: { type: 'string' } },
    required: ['cmd'],
    additionalProperties: false,
  },
  ajv_validate: {
    type: 'object',
    properties: {
      data_from: { type: 'string' },
      errors_as: { type: 'string' },
      export_as: { type: 'string' },
      schema_from: { type: 'string' },
    },
    additionalProperties: false,
  },
  json_query: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      from: { type: 'string' },
      path: { type: 'string' },
    },
    required: ['from', 'path'],
    additionalProperties: false,
  },
  mermaid_gen: {
    type: 'object',
    properties: { export_as: { type: 'string' }, from: { type: 'string' } },
    required: ['from'],
    additionalProperties: false,
  },
  analyze_source_tree: {
    type: 'object',
    properties: {
      dir: { type: 'string' },
      export_as: { type: 'string' },
      max_files: { type: 'number' },
      source_root: { type: 'string' },
    },
    additionalProperties: false,
  },
  ui_flow_to_test_inventory: {
    type: 'object',
    properties: { export_as: { type: 'string' }, from: { type: 'string' } },
    required: ['from'],
    additionalProperties: false,
  },
  web_profile_to_ui_flow_adf: {
    type: 'object',
    properties: { export_as: { type: 'string' }, from: { type: 'string' } },
    required: ['from'],
    additionalProperties: false,
  },
  test_inventory_to_browser_pipeline: {
    type: 'object',
    properties: {
      default_email: { type: 'string' },
      default_password: { type: 'string' },
      export_as: { type: 'string' },
      from: { type: 'string' },
      handoff_output_path: { type: 'string' },
      headless: { type: 'boolean' },
      preset: { type: 'string' },
      profile_from: { type: 'string' },
      ui_flow_from: { type: 'string' },
    },
    required: ['from'],
    additionalProperties: false,
  },
  test_inventory_to_device_pipeline: {
    type: 'object',
    properties: {
      artifacts_dir: { type: 'string' },
      export_as: { type: 'string' },
      from: { type: 'string' },
      platform: { type: 'string' },
      profile_from: { type: 'string' },
    },
    required: ['from', 'platform'],
    additionalProperties: false,
  },
  log: {
    type: 'object',
    properties: { message: { type: 'string' } },
    additionalProperties: false,
  },
  if: {
    type: 'object',
    properties: {
      condition: { type: 'string' },
      else: { type: 'array' },
      then: { type: 'array' },
    },
    required: ['condition'],
    additionalProperties: false,
  },
  while: {
    type: 'object',
    properties: {
      condition: { type: 'string' },
      max_iterations: { type: 'number' },
      pipeline: { type: 'array' },
    },
    required: ['condition'],
    additionalProperties: false,
  },
  terraform_to_architecture_adf: {
    type: 'object',
    properties: {
      dir: { type: 'string' },
      export_as: { type: 'string' },
      from: { type: 'string' },
      path: { type: 'string' },
      title: { type: 'string' },
    },
    additionalProperties: false,
  },
  terraform_to_topology_ir: {
    type: 'object',
    properties: {
      dir: { type: 'string' },
      export_as: { type: 'string' },
      from: { type: 'string' },
      path: { type: 'string' },
      title: { type: 'string' },
    },
    additionalProperties: false,
  },
  build_agentic_source_review_participants: {
    type: 'object',
    properties: {
      allowed_reasoning_backends: { type: 'array' },
      export_as: { type: 'string' },
      external_egress: { type: 'boolean' },
      external_egress_approved: { type: 'boolean' },
      mission_id: { type: 'string' },
      output_tier: { type: 'string' },
      project_id: { type: 'string' },
      tenant_slug: { type: 'string' },
    },
    additionalProperties: false,
  },
  compile_agentic_source_review_plan: {
    type: 'object',
    properties: {
      approval_ref: { type: 'string' },
      architecture_refs: { type: 'array' },
      export_as: { type: 'string' },
      from: { type: 'string' },
      project_id: { type: 'string' },
      sbom_refs: { type: 'array' },
      threat_intelligence_refs: { type: 'array' },
      threat_model_approved: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  compile_agentic_source_review_verification: {
    type: 'object',
    properties: {
      analysis_from: { type: 'string' },
      candidates_from: { type: 'string' },
      export_as: { type: 'string' },
      known_finding_fingerprints: { type: 'array' },
      known_finding_scope: { type: 'string' },
      mission_id: { type: 'string' },
      plan_from: { type: 'string' },
      project_id: { type: 'string' },
      tenant_slug: { type: 'string' },
    },
    additionalProperties: false,
  },
  compile_engineering_artifacts: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      from: { type: 'string' },
      project_id: { type: 'string' },
      target_provider: { type: 'string' },
    },
    additionalProperties: false,
  },
  derive_test_inventory: {
    type: 'object',
    properties: {
      additional_context: {},
      contract: {},
      contract_from: { type: 'string' },
      contract_path: { type: 'string' },
      export_as: { type: 'string' },
      output_path: { type: 'string' },
      project_id: { type: 'string' },
      risk_refs: { type: 'array' },
      risk_refs_from: { type: 'string' },
      system_tags: { type: 'array' },
      system_tags_from: { type: 'string' },
    },
    additionalProperties: false,
  },
  evaluate_architecture_ready: {
    type: 'object',
    properties: { export_as: { type: 'string' }, mission_id: { type: 'string' } },
    required: ['mission_id'],
    additionalProperties: false,
  },
  evaluate_customer_signoff: {
    type: 'object',
    properties: { export_as: { type: 'string' }, mission_id: { type: 'string' } },
    required: ['mission_id'],
    additionalProperties: false,
  },
  evaluate_qa_ready: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      mission_id: { type: 'string' },
      must_have_ids: { type: 'array' },
      must_have_ids_from: { type: 'string' },
    },
    required: ['mission_id'],
    additionalProperties: false,
  },
  evaluate_requirements_completeness: {
    type: 'object',
    properties: { export_as: { type: 'string' }, mission_id: { type: 'string' } },
    required: ['mission_id'],
    additionalProperties: false,
  },
  extract_design_spec: {
    type: 'object',
    properties: {
      additional_context: {},
      export_as: { type: 'string' },
      mission_id: { type: 'string' },
      project_name: { type: 'string' },
      requirements_draft_path: { type: 'string' },
    },
    additionalProperties: false,
  },
  extract_requirements: {
    type: 'object',
    properties: {
      customer_name: { type: 'string' },
      customer_org: { type: 'string' },
      customer_person_slug: { type: 'string' },
      export_as: { type: 'string' },
      language: { type: 'string' },
      mission_id: { type: 'string' },
      prior_draft_ref: { type: 'string' },
      project_name: { type: 'string' },
      source_path: { type: 'string' },
      source_type: { type: 'string' },
      transcript_path: { type: 'string' },
    },
    additionalProperties: false,
  },
  extract_test_plan: {
    type: 'object',
    properties: {
      app_id: { type: 'string' },
      design_spec_path: { type: 'string' },
      export_as: { type: 'string' },
      mission_id: { type: 'string' },
      project_name: { type: 'string' },
      requirements_draft_path: { type: 'string' },
    },
    additionalProperties: false,
  },
  write_engineering_artifacts: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      from: { type: 'string' },
      output_dir: { type: 'string' },
    },
    additionalProperties: false,
  },
  write_agentic_source_review_plan: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      from: { type: 'string' },
      mission_id: { type: 'string' },
      output_dir: { type: 'string' },
      tenant_slug: { type: 'string' },
    },
    additionalProperties: false,
  },
  write_agentic_source_review_verification: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      from: { type: 'string' },
      mission_id: { type: 'string' },
      output_dir: { type: 'string' },
      plan_from: { type: 'string' },
      tenant_slug: { type: 'string' },
    },
    additionalProperties: false,
  },
  write_artifact: {
    type: 'object',
    properties: {
      artifact: { type: 'object' },
      content: {},
      data: {},
      from: { type: 'string' },
      output_path: { type: 'string' },
      path: { type: 'string' },
    },
    additionalProperties: false,
  },
  write_file: {
    type: 'object',
    properties: {
      content: {},
      data: {},
      from: { type: 'string' },
      output_path: { type: 'string' },
      path: { type: 'string' },
    },
    additionalProperties: false,
  },
};

const MODELING_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  glob_files: [{ dir: 'src', ext: '.ts' }],
  read_file: [{ path: 'README.md' }],
  read_json: [{ path: 'package.json' }],
  shell: [{ cmd: 'pnpm typecheck' }],
  ajv_validate: [{ data_from: 'input', schema_from: 'schema' }],
  json_query: [{ from: 'payload', path: '.items' }],
  mermaid_gen: [{ from: 'architecture' }],
  analyze_source_tree: [{ source_root: 'libs' }],
  ui_flow_to_test_inventory: [{ from: 'ui_flow' }],
  web_profile_to_ui_flow_adf: [{ from: 'web_profile' }],
  test_inventory_to_browser_pipeline: [{ from: 'test_inventory' }],
  test_inventory_to_device_pipeline: [{ from: 'test_inventory', platform: 'ios' }],
  log: [{ message: 'completed' }],
  if: [{ condition: 'ready' }],
  while: [{ condition: 'pending', max_iterations: 3, pipeline: [] }],
  terraform_to_architecture_adf: [{ from: 'terraform' }],
  terraform_to_topology_ir: [{ from: 'terraform' }],
  build_agentic_source_review_participants: [
    { mission_id: 'MSN-20260826-001', tenant_slug: 'acme' },
  ],
  compile_agentic_source_review_plan: [{ from: 'participants' }],
  compile_agentic_source_review_verification: [{ from: 'plan' }],
  compile_engineering_artifacts: [{ from: 'engineering_plan' }],
  derive_test_inventory: [{ contract_from: 'contract' }],
  evaluate_architecture_ready: [{ mission_id: 'MSN-20260826-001' }],
  evaluate_customer_signoff: [{ mission_id: 'MSN-20260826-001' }],
  evaluate_qa_ready: [{ mission_id: 'MSN-20260826-001' }],
  evaluate_requirements_completeness: [{ mission_id: 'MSN-20260826-001' }],
  extract_design_spec: [{ requirements_draft_path: 'active/shared/tmp/requirements.md' }],
  extract_requirements: [{ source_path: 'active/shared/tmp/brief.txt' }],
  extract_test_plan: [{ design_spec_path: 'active/shared/tmp/design.md' }],
  write_engineering_artifacts: [
    { from: 'engineering_plan', output_dir: 'active/shared/tmp/engineering' },
  ],
  write_agentic_source_review_plan: [
    { from: 'review_plan', output_dir: 'active/shared/tmp/review' },
  ],
  write_agentic_source_review_verification: [
    { from: 'verification', output_dir: 'active/shared/tmp/review' },
  ],
  write_artifact: [{ output_path: 'active/shared/tmp/artifact.json', content: '{}' }],
  write_file: [{ path: 'active/shared/tmp/note.txt', content: 'completed' }],
};

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
  'analyze_source_tree',
  'build_agentic_source_review_participants',
  'compile_agentic_source_review_plan',
  'compile_agentic_source_review_verification',
  'compile_engineering_artifacts',
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
  'write_engineering_artifacts',
  'write_agentic_source_review_plan',
  'write_agentic_source_review_verification',
  'log',
  'write_artifact',
  'write_file',
] as const;

export const MODELING_ACTUATOR_CONTROL_OPS = ['if', 'while'] as const;

const toSpec = (op: string, kind: PipelineStepType) => {
  const schema = MODELING_CONTRACTS[op];
  const description = schema
    ? { op, kind, input_schema: schema, examples: MODELING_EXAMPLES[op] || [{}] }
    : { op, kind };
  return withCatalogInputContract('modeling', op, kind, description);
};

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...MODELING_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...MODELING_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...MODELING_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
    ...MODELING_ACTUATOR_CONTROL_OPS.map((op) => toSpec(op, 'control')),
  ];
}
