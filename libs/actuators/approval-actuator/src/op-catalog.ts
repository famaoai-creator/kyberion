// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch switch
// in approval-actuator-helpers.ts; check:op-registry fails on drift.
//
// Kind notes: ops that previously classified via the shared pools keep their
// historical kind (e.g. list -> capture) so step-type inference does not
// change; every other op previously made determineActuatorStepType throw, so
// those entries are strictly additive.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const APPROVAL_ACTUATOR_CAPTURE_OPS = ['load', 'list_pending'] as const;

export const APPROVAL_ACTUATOR_TRANSFORM_OPS = [] as const;

export const APPROVAL_ACTUATOR_APPLY_OPS = ['create', 'decide'] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return { op, kind };
}

export function describeOps() {
  return [
    ...APPROVAL_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...APPROVAL_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...APPROVAL_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
