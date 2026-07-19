// AR-02: self-described op catalog — mirrors this actuator's action
// dispatch (if/else style handleAction). None of these ops appear in the
// shared pools, so every entry is strictly additive: pipelines reached them
// via explicit step roles, and determineActuatorStepType threw unknown-op.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const MEDIA_GENERATION_ACTIONS = [
  'generate_image',
  'generate_video',
  'generate_music',
  'run_workflow',
  'submit_generation',
  'get_generation_job',
  'wait_generation_job',
  'collect_generation_artifact',
  'capture_screen',
  'capture_focused_window',
  'record_screen',
  'pipeline',
] as const;

export const MEDIA_GENERATION_ACTUATOR_CAPTURE_OPS = [
  'capture_focused_window',
  'capture_screen',
  'record_screen',
] as const;

export const MEDIA_GENERATION_ACTUATOR_TRANSFORM_OPS = [] as const;

export const MEDIA_GENERATION_ACTUATOR_APPLY_OPS = [
  'collect_generation_artifact',
  'generate_image',
  'generate_music',
  'generate_video',
  'get_generation_job',
  'run_workflow',
  'submit_generation',
  'wait_generation_job',
] as const;

export const MEDIA_GENERATION_ACTUATOR_CONTROL_OPS = ['pipeline'] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return { op, kind };
}

export function describeOps() {
  return [
    ...MEDIA_GENERATION_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...MEDIA_GENERATION_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...MEDIA_GENERATION_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
    ...MEDIA_GENERATION_ACTUATOR_CONTROL_OPS.map((op) => toSpec(op, 'control')),
  ];
}
