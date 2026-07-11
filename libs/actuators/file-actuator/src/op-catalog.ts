import { getOpInputContract } from '@agent/core';

// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch
// switches in the pipeline helpers; check:op-registry fails on drift.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

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
