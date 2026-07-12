// AR-02: self-described op catalog — mirrors this actuator's action
// dispatch (if/else style handleAction). None of these ops appear in the
// shared pools, so every entry is strictly additive: pipelines reached them
// via explicit step roles, and determineActuatorStepType threw unknown-op.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const MEETING_ACTUATOR_CAPTURE_OPS = ['listen', 'status'] as const;

export const MEETING_ACTUATOR_TRANSFORM_OPS = [] as const;

export const MEETING_ACTUATOR_APPLY_OPS = ['chat', 'join', 'leave', 'speak'] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return { op, kind };
}

export function describeOps() {
  return [
    ...MEETING_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...MEETING_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...MEETING_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
