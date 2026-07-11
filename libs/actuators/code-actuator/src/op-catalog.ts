// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch
// switches in the pipeline helpers; check:op-registry fails on drift.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const CODE_ACTUATOR_CAPTURE_OPS = [
  'discover_capabilities',
  'discover_skills',
  'glob_files',
  'read_file',
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

const toSpec = (op: string, kind: OpSpecKind) => ({ op, kind });

export function describeOps() {
  return [
    ...CODE_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...CODE_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...CODE_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
    ...CODE_ACTUATOR_CONTROL_OPS.map((op) => toSpec(op, 'control')),
  ];
}
