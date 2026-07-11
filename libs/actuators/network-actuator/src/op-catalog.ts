// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch
// switches in the pipeline helpers; check:op-registry fails on drift.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const NETWORK_ACTUATOR_CAPTURE_OPS = ['a2a_poll', 'fetch', 'shell'] as const;

export const NETWORK_ACTUATOR_TRANSFORM_OPS = ['json_query', 'regex_extract'] as const;

export const NETWORK_ACTUATOR_APPLY_OPS = [
  'a2a_send',
  'log',
  'write_artifact',
  'write_file',
] as const;

export const NETWORK_ACTUATOR_CONTROL_OPS = ['if', 'while'] as const;

const toSpec = (op: string, kind: OpSpecKind) => ({ op, kind });

export function describeOps() {
  return [
    ...NETWORK_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...NETWORK_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...NETWORK_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
    ...NETWORK_ACTUATOR_CONTROL_OPS.map((op) => toSpec(op, 'control')),
  ];
}
