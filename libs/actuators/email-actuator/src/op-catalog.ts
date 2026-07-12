// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the op dispatch in
// this actuator's source; check:op-registry fails on drift.
//
// Kind notes: none of these ops appear in the shared pools, so every entry
// is strictly additive — determineActuatorStepType previously threw
// unknown-op for all of them.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const EMAIL_ACTUATOR_CAPTURE_OPS = [] as const;

export const EMAIL_ACTUATOR_TRANSFORM_OPS = [] as const;

export const EMAIL_ACTUATOR_APPLY_OPS = ['create_draft', 'send', 'send_from_file'] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return { op, kind };
}

export function describeOps() {
  return [
    ...EMAIL_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...EMAIL_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...EMAIL_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
