import { getOpInputContract } from '@agent/core';

export const SYSTEM_ACTUATOR_CAPTURE_OPS = [
  'screenshot',
  'record_screen',
  'clipboard_read',
  'get_focused_input',
  'get_screen_size',
  'macos_automation_probe',
  'window_list',
  'chrome_tab_list',
  'read_file',
  'read_json',
  'probe',
  'glob_files',
  'scan_directory',
  'pulse_status',
  'exec',
  'shell',
  'cli_health_check',
  'list_missions',
  'list_projects',
  'list_capabilities',
  'list_incidents',
  'list_knowledge',
  'list_running_apps',
  'list_input_devices',
  'list_displays',
  'list_media_devices',
  'list_tool_runtimes',
  'list_service_runtimes',
  'control_media_devices',
  'collect_artifacts',
  'sample_traces',
  'reconcile_config_fallbacks',
  'reconcile_unclassified_errors',
  'reconcile_unhandled_intents',
  'cost_report',
  'audit_verify',
  'summarize_memory_promotion_queue',
  'summarize_task_model_routing',
  'vision_consult',
  'test_screen_stream',
  'test_screen_mp4_roundtrip',
  'test_camera_injection',
] as const;

export const SYSTEM_ACTUATOR_APPLY_OPS = [
  'scroll',
  'drag',
  'clipboard_write',
  'system_notify',
  'open_file',
  'app_quit',
  'process_kill',
  'run_applescript',
  'keyboard',
  'paste_text',
  'press_key',
  'voice_input_toggle',
  'mouse_click',
  'mouse_move',
  'activate_application',
  'open_url',
  'write_file',
  'write_artifact',
  'write_json',
  'mkdir',
  'log',
  'voice',
  'native_tts_speak',
  'check_native_tts',
  'notify',
  'wait',
] as const;

export const SYSTEM_ACTUATOR_TRANSFORM_OPS = [
  'regex_extract',
  'json_query',
  'sre_analyze',
  'run_js',
  'distill_output',
  'llm_decide',
] as const;

export const SYSTEM_ACTUATOR_CONTROL_OPS = ['if', 'while'] as const;

export interface SystemOpSpec {
  op: string;
  kind: 'capture' | 'transform' | 'apply' | 'control';
  input_schema?: Record<string, unknown>;
  examples?: Array<Record<string, unknown>>;
}

function withInputSchema(op: string, kind: SystemOpSpec['kind']): SystemOpSpec {
  const contract = getOpInputContract('system', op);
  return contract
    ? { op, kind, input_schema: contract.schema, examples: contract.examples }
    : { op, kind };
}

export function describeOps() {
  return [
    ...SYSTEM_ACTUATOR_CAPTURE_OPS.map((op) => withInputSchema(op, 'capture')),
    ...SYSTEM_ACTUATOR_TRANSFORM_OPS.map((op) => withInputSchema(op, 'transform')),
    ...SYSTEM_ACTUATOR_APPLY_OPS.map((op) => withInputSchema(op, 'apply')),
    ...SYSTEM_ACTUATOR_CONTROL_OPS.map((op) => withInputSchema(op, 'control')),
  ];
}
