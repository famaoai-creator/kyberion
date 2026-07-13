// AR-02: self-described op catalog — mirrors the three switch(op) dispatch
// blocks in android-runtime-helpers.ts (capture / transform / apply), whose
// structure already matches the kinds. Shared-pool members (log -> apply,
// read_json -> capture, set -> transform) sit in the matching blocks, so
// step-type inference is unchanged; all other ops were previously
// unclassifiable (determineActuatorStepType threw unknown-op).

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const ANDROID_ACTUATOR_CAPTURE_OPS = [
  'adb_health_check',
  'android_cli_describe',
  'android_cli_docs_search',
  'android_cli_health_check',
  'android_cli_layout',
  'android_cli_screen_resolve',
  'capture_foreground_activity',
  'capture_runtime_session_handoff',
  'extract_ui_tree',
  'read_json',
  'read_text_file',
] as const;

export const ANDROID_ACTUATOR_TRANSFORM_OPS = [
  'find_ui_nodes',
  'llm_decide',
  'set',
  'summarize_ui_tree',
] as const;

export const ANDROID_ACTUATOR_APPLY_OPS = [
  'android_cli_screen_capture',
  'authenticate_with_passkey',
  'capture_screen',
  'emit_session_handoff',
  'fill_login_form',
  'input_text',
  'input_text_into_ui_node',
  'launch_app',
  'log',
  'open_deep_link',
  'swipe',
  'tap',
  'tap_ui_node',
  'wait_for_ui_node',
  'wait_for_ui_text',
] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return { op, kind };
}

export function describeOps() {
  return [
    ...ANDROID_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...ANDROID_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...ANDROID_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
