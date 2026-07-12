// AR-02: self-described op catalog — mirrors this actuator's action
// dispatch (if/else style handleAction). None of these ops appear in the
// shared pools, so every entry is strictly additive: pipelines reached them
// via explicit step roles, and determineActuatorStepType threw unknown-op.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const MEDIA_GENERATION_ACTUATOR_CAPTURE_OPS = [
  'capture_focused_window',
  'capture_screen',
  'get_generation_job',
] as const;

export const MEDIA_GENERATION_ACTUATOR_TRANSFORM_OPS = [] as const;

export const MEDIA_GENERATION_ACTUATOR_APPLY_OPS = [
  'collect_generation_artifact',
  'generate_image',
  'submit_generation',
  'wait_generation_job',
] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return { op, kind };
}

export function describeOps() {
  return [
    ...MEDIA_GENERATION_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...MEDIA_GENERATION_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...MEDIA_GENERATION_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
