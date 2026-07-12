// AR-02: self-described op catalog — mirrors this actuator's action
// dispatch (if/else style handleAction). None of these ops appear in the
// shared pools, so every entry is strictly additive: pipelines reached them
// via explicit step roles, and determineActuatorStepType threw unknown-op.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const VIDEO_COMPOSITION_ACTUATOR_CAPTURE_OPS = [
  'get_video_composition_job_status',
  'get_video_composition_queue',
  'list_video_composition_templates',
] as const;

export const VIDEO_COMPOSITION_ACTUATOR_TRANSFORM_OPS = [
  'compile_narrated_video_brief',
  'compile_video_content_brief',
] as const;

export const VIDEO_COMPOSITION_ACTUATOR_APPLY_OPS = [
  'await_video_composition_job',
  'cancel_video_composition_job',
  'create_narrated_intro_movie',
  'create_narrated_video_from_content_brief',
  'prepare_video_composition',
  'verify_rendered_video_artifact',
] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return { op, kind };
}

export function describeOps() {
  return [
    ...VIDEO_COMPOSITION_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...VIDEO_COMPOSITION_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...VIDEO_COMPOSITION_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
