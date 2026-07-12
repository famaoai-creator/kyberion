// AR-02: self-described op catalog — mirrors this actuator's action
// dispatch (if/else style handleAction). None of these ops appear in the
// shared pools, so every entry is strictly additive: pipelines reached them
// via explicit step roles, and determineActuatorStepType threw unknown-op.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const VISION_ACTUATOR_CAPTURE_OPS = ['inspect_image', 'ocr_image'] as const;

export const VISION_ACTUATOR_TRANSFORM_OPS = [] as const;

export const VISION_ACTUATOR_APPLY_OPS = [] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return { op, kind };
}

export function describeOps() {
  return [
    ...VISION_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...VISION_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...VISION_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
