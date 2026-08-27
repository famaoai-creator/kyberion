import { getOpInputContract } from '@agent/core';

// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch
// switches in the pipeline helpers; check:op-registry fails on drift.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

const FILE_EXTRA_CONTRACTS: Record<
  string,
  { schema: Record<string, unknown>; examples: Array<Record<string, unknown>> }
> = {
  json_parse: {
    schema: {
      type: 'object',
      properties: { export_as: { type: 'string' }, from: { type: 'string' } },
      required: ['from'],
      additionalProperties: false,
    },
    examples: [{ from: 'raw_json' }],
  },
  path_join: {
    schema: {
      type: 'object',
      properties: { export_as: { type: 'string' }, parts: { type: 'array' } },
      required: ['parts'],
      additionalProperties: false,
    },
    examples: [{ parts: ['active', 'shared', 'tmp', 'result.json'] }],
  },
  regex_replace: {
    schema: {
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
    examples: [{ from: 'text', pattern: 'old', template: 'new' }],
  },
  if: {
    schema: {
      type: 'object',
      properties: {
        condition: { type: 'string' },
        else: { type: 'array' },
        then: { type: 'array' },
      },
      required: ['condition'],
      additionalProperties: false,
    },
    examples: [{ condition: 'ready' }],
  },
  while: {
    schema: {
      type: 'object',
      properties: {
        condition: { type: 'string' },
        max_iterations: { type: 'number' },
        pipeline: { type: 'array' },
      },
      required: ['condition'],
      additionalProperties: false,
    },
    examples: [{ condition: 'pending', max_iterations: 3, pipeline: [] }],
  },
};

export const FILE_ACTUATOR_CAPTURE_OPS = [
  'exists',
  'list',
  'read',
  'read_file',
  'read_json',
  'search',
  'stat',
  'tail',
] as const;

export const FILE_ACTUATOR_TRANSFORM_OPS = ['json_parse', 'path_join', 'regex_replace'] as const;

export const FILE_ACTUATOR_APPLY_OPS = [
  'append',
  'copy',
  'delete',
  'mkdir',
  'move',
  'write',
  'write_artifact',
  'write_file',
] as const;

export const FILE_ACTUATOR_CONTROL_OPS = ['if', 'while'] as const;

function withInputSchema(op: string, kind: OpSpecKind) {
  const contract = getOpInputContract('file', op);
  return contract
    ? { op, kind, input_schema: contract.schema, examples: contract.examples }
    : FILE_EXTRA_CONTRACTS[op]
      ? {
          op,
          kind,
          input_schema: FILE_EXTRA_CONTRACTS[op].schema,
          examples: FILE_EXTRA_CONTRACTS[op].examples,
        }
      : { op, kind };
}

const toSpec = withInputSchema;

export function describeOps() {
  return [
    ...FILE_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...FILE_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...FILE_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
    ...FILE_ACTUATOR_CONTROL_OPS.map((op) => toSpec(op, 'control')),
  ];
}
