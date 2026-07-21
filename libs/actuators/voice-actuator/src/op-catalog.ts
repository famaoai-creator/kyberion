// AR-02: self-described op catalog — mirrors this actuator's action
// dispatch (if/else style handleAction). None of these ops appear in the
// shared pools, so every entry is strictly additive: pipelines reached them
// via explicit step roles, and determineActuatorStepType threw unknown-op.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const VOICE_ACTUATOR_CAPTURE_OPS = [
  'health',
  'list_voices',
  'list_audio_routes',
  'probe_audio_route',
  'transcribe',
  'transcribe_voice_sample',
] as const;

export const VOICE_ACTUATOR_TRANSFORM_OPS = [] as const;

export const VOICE_ACTUATOR_APPLY_OPS = [
  'collect_and_register_voice_profile',
  'collect_voice_samples',
  'generate_voice',
  'record_interaction',
  'record_voice_sample',
  'record_verify_repair_voice_sample',
  'register_voice_profile',
  'speak_local',
  'verify_tts_loopback',
] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return { op, kind };
}

export function describeOps() {
  return [
    ...VOICE_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...VOICE_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...VOICE_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
