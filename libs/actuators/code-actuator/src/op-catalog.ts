// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch
// switches in the pipeline helpers; check:op-registry fails on drift.

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

type InputSchema = Record<string, unknown>;
const CODE_CONTROL_SCHEMA: InputSchema = {
  type: 'object',
  properties: {
    condition: { type: 'string' },
    else: { type: 'array' },
    then: { type: 'array' },
  },
  required: ['condition'],
  additionalProperties: false,
};
const CODE_CONTRACTS: Record<string, InputSchema> = {
  discover_capabilities: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  discover_skills: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  glob_files: {
    type: 'object',
    properties: { dir: { type: 'string' }, export_as: { type: 'string' }, ext: { type: 'string' } },
    required: ['dir'],
    additionalProperties: false,
  },
  read_file: {
    type: 'object',
    properties: { export_as: { type: 'string' }, path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  run_tests: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      framework: { type: 'string' },
      test_path: { type: 'string' },
    },
    required: ['test_path'],
    additionalProperties: false,
  },
  semgrep_scan: {
    type: 'object',
    properties: {
      config: { type: 'string' },
      export_as: { type: 'string' },
      target_dir: { type: 'string' },
    },
    required: ['target_dir'],
    additionalProperties: false,
  },
  shell: {
    type: 'object',
    properties: { cmd: { type: 'string' }, export_as: { type: 'string' } },
    required: ['cmd'],
    additionalProperties: false,
  },
  impact_analysis: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      output_path: { type: 'string' },
      repo_path: { type: 'string' },
      repo_path_from: { type: 'string' },
      requirements: { type: 'string' },
      requirements_from: { type: 'string' },
    },
    additionalProperties: false,
  },
  json_update: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      from: { type: 'string' },
      updates: { type: 'object' },
    },
    required: ['from'],
    additionalProperties: false,
  },
  regex_replace: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      from: { type: 'string' },
      pattern: { type: 'string' },
      template: { type: 'string' },
    },
    required: ['from', 'pattern', 'template'],
    additionalProperties: false,
  },
  run_js: {
    type: 'object',
    properties: { code: { type: 'string' } },
    required: ['code'],
    additionalProperties: false,
  },
  log: { type: 'object', properties: { message: { type: 'string' } }, additionalProperties: false },
  write_artifact: {
    type: 'object',
    properties: {
      artifact: { type: 'object' },
      content: {},
      data: {},
      output_path: { type: 'string' },
      path: { type: 'string' },
    },
    additionalProperties: false,
  },
  write_file: {
    type: 'object',
    properties: { content: {}, data: {}, from: { type: 'string' }, path: { type: 'string' } },
    additionalProperties: false,
  },
  if: CODE_CONTROL_SCHEMA,
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
};

const CODE_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  discover_capabilities: [{}],
  discover_skills: [{}],
  glob_files: [{ dir: 'src', ext: '.ts' }],
  read_file: [{ path: 'README.md' }],
  run_tests: [{ test_path: 'tests/smoke.test.ts', framework: 'vitest' }],
  semgrep_scan: [{ target_dir: 'libs', config: 'p/security-audit' }],
  shell: [{ cmd: 'pnpm typecheck' }],
  impact_analysis: [{ repo_path: 'libs/core', requirements: 'secure IO' }],
  json_update: [{ from: 'config', updates: { enabled: true } }],
  regex_replace: [{ from: 'source', pattern: 'old', template: 'new' }],
  run_js: [{ code: 'return input;' }],
  log: [{ message: 'completed' }],
  if: [{ condition: 'ready' }],
  while: [{ condition: 'pending' }],
  write_artifact: [{ output_path: 'active/shared/tmp/artifact.json', content: '{}' }],
  write_file: [{ path: 'active/shared/tmp/note.txt', content: 'completed' }],
};

export const CODE_ACTUATOR_CAPTURE_OPS = [
  'discover_capabilities',
  'discover_skills',
  'glob_files',
  'read_file',
  'run_tests',
  'semgrep_scan',
  'shell',
] as const;

export const CODE_ACTUATOR_TRANSFORM_OPS = [
  'impact_analysis',
  'json_update',
  'regex_replace',
  'run_js',
] as const;

export const CODE_ACTUATOR_APPLY_OPS = ['log', 'write_artifact', 'write_file'] as const;

export const CODE_ACTUATOR_CONTROL_OPS = ['if', 'while'] as const;

const toSpec = (op: string, kind: PipelineStepType) => {
  const schema = CODE_CONTRACTS[op];
  return schema
    ? { op, kind, input_schema: schema, examples: CODE_EXAMPLES[op] || [{}] }
    : { op, kind };
};

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...CODE_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...CODE_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...CODE_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
    ...CODE_ACTUATOR_CONTROL_OPS.map((op) => toSpec(op, 'control')),
  ];
}
