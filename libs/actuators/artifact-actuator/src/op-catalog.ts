// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch switch
// in artifact-actuator-helpers.ts; check:op-registry fails on drift.
//
// Kind notes: ops that previously classified via the shared pools keep their
// historical kind (e.g. list -> capture) so step-type inference does not
// change; every other op previously made determineActuatorStepType throw, so
// those entries are strictly additive.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const ARTIFACT_ACTUATOR_CAPTURE_OPS = ['read_json', 'list'] as const;

export const ARTIFACT_ACTUATOR_TRANSFORM_OPS = [] as const;

export const ARTIFACT_ACTUATOR_APPLY_OPS = [
  'write_json',
  'append_event',
  'ensure_dir',
  'write_delivery_pack',
] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return { op, kind };
}

export function describeOps() {
  return [
    ...ARTIFACT_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...ARTIFACT_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...ARTIFACT_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
