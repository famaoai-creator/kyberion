// AR-02: self-described op catalog — mirrors the three switch(op) dispatch
// blocks in ios-runtime-helpers.ts (capture / transform / apply), whose
// structure already matches the kinds. Shared-pool members (log -> apply,
// read_json -> capture, set -> transform) sit in the matching blocks, so
// step-type inference is unchanged; all other ops were previously
// unclassifiable (determineActuatorStepType threw unknown-op).

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const IOS_ACTUATOR_CAPTURE_OPS = [
  'capture_runtime_session_handoff',
  'read_json',
  'read_text_file',
  'simctl_health_check',
] as const;

export const IOS_ACTUATOR_TRANSFORM_OPS = ['set'] as const;

export const IOS_ACTUATOR_APPLY_OPS = [
  'boot_simulator',
  'capture_screen',
  'emit_session_handoff',
  'install_app',
  'launch_app',
  'log',
  'open_deep_link',
  'shutdown_simulator',
  'uninstall_app',
] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return { op, kind };
}

export function describeOps() {
  return [
    ...IOS_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...IOS_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...IOS_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
