import { getOpInputContract } from '@agent/core/op-input-contracts';
import { withCatalogInputContract } from '../../../core/actuator-sdk.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

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
  'probe_active_profile',
  'glob_files',
  'scan_directory',
  'pulse_status',
  'baseline_check',
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

const SYSTEM_EXTRA_CONTRACTS: Record<string, SystemOpSpec['input_schema']> = {
  screenshot: {
    type: 'object',
    properties: {
      application: { type: 'string' },
      capture_mode: { type: 'string' },
      export_as: { type: 'string' },
      window_match_policy: { type: 'string' },
      window_title: { type: 'string' },
    },
    additionalProperties: false,
  },
  window_list: {
    type: 'object',
    properties: { application: { type: 'string' }, export_as: { type: 'string' } },
    additionalProperties: false,
  },
  chrome_tab_list: {
    type: 'object',
    properties: { application: { type: 'string' }, export_as: { type: 'string' } },
    additionalProperties: false,
  },
  probe: {
    type: 'object',
    properties: {
      capability: { type: 'string' },
      export_as: { type: 'string' },
      path: { type: 'string' },
      retry: { type: 'object' },
      allow_symlink_leaf: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  glob_files: {
    type: 'object',
    required: ['dir'],
    properties: { dir: { type: 'string' }, export_as: { type: 'string' }, ext: { type: 'string' } },
    additionalProperties: false,
  },
  scan_directory: {
    type: 'object',
    properties: {
      exclude: {},
      export_as: { type: 'string' },
      include_metadata: { type: 'boolean' },
      max_depth: { type: 'number' },
      path: { type: 'string' },
      pattern: { type: 'string' },
      recursive: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  cli_health_check: {
    type: 'object',
    required: ['command'],
    properties: {
      args: { type: 'array' },
      command: { type: 'string' },
      export_as: { type: 'string' },
      retry: { type: 'object' },
      timeout_ms: { type: 'number' },
    },
    additionalProperties: false,
  },
  list_missions: {
    type: 'object',
    properties: { export_as: { type: 'string' }, status: { type: 'string' } },
    additionalProperties: false,
  },
  list_tool_runtimes: {
    type: 'object',
    properties: { export_as: { type: 'string' }, requested_mode: { type: 'string' } },
    additionalProperties: false,
  },
  list_service_runtimes: {
    type: 'object',
    properties: { export_as: { type: 'string' }, requested_mode: { type: 'string' } },
    additionalProperties: false,
  },
  control_media_devices: {
    type: 'object',
    properties: {
      action: { type: 'string' },
      export_as: { type: 'string' },
      scope: { type: 'string' },
    },
    additionalProperties: false,
  },
  collect_artifacts: {
    type: 'object',
    properties: { export_as: { type: 'string' }, mission_ids: {}, patterns: {} },
    additionalProperties: false,
  },
  sample_traces: {
    type: 'object',
    properties: { count: { type: 'number' }, export_as: { type: 'string' } },
    additionalProperties: false,
  },
  vision_consult: {
    type: 'object',
    properties: {
      context: {},
      export_as: { type: 'string' },
      retry: { type: 'object' },
      tie_break_options: {},
    },
    additionalProperties: false,
  },
  test_screen_stream: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      frame_interval_ms: { type: 'number' },
      max_frames: { type: 'number' },
    },
    additionalProperties: false,
  },
  test_screen_mp4_roundtrip: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      frame_interval_ms: { type: 'number' },
      max_frames: { type: 'number' },
    },
    additionalProperties: false,
  },
  test_camera_injection: {
    type: 'object',
    properties: {
      camera_device_preference: { type: 'string' },
      device_path: { type: 'string' },
      device_preference: { type: 'string' },
      export_as: { type: 'string' },
      frame_count: { type: 'number' },
      frame_interval_ms: { type: 'number' },
      input_mp4_path: { type: 'string' },
      output_path: { type: 'string' },
      preferred_camera_backend: { type: 'string' },
      subject_hint: { type: 'string' },
    },
    additionalProperties: false,
  },
  sre_analyze: {
    type: 'object',
    properties: { export_as: { type: 'string' }, from: { type: 'string' } },
    additionalProperties: false,
  },
  llm_decide: {
    type: 'object',
    properties: {
      context: {},
      export_as: { type: 'string' },
      instruction: { type: 'string' },
      mode: { type: 'string' },
      options: {},
      prompt: { type: 'string' },
    },
    additionalProperties: false,
  },
  run_applescript: {
    type: 'object',
    required: ['script'],
    properties: {
      export_as: { type: 'string' },
      retry: { type: 'object' },
      script: { type: 'string' },
    },
    additionalProperties: false,
  },
  clipboard_read: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  get_focused_input: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  get_screen_size: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  pulse_status: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  baseline_check: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  list_projects: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  list_capabilities: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  list_incidents: { type: 'object', properties: {}, additionalProperties: false },
  list_knowledge: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  list_running_apps: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  list_input_devices: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  list_displays: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  list_media_devices: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  scroll: {
    type: 'object',
    properties: {
      amount: { type: 'number' },
      direction: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
    },
    additionalProperties: false,
  },
  drag: {
    type: 'object',
    properties: {
      from_x: { type: 'number' },
      from_y: { type: 'number' },
      to_x: { type: 'number' },
      to_y: { type: 'number' },
    },
    required: ['from_x', 'from_y', 'to_x', 'to_y'],
    additionalProperties: false,
  },
  clipboard_write: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  system_notify: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      subtitle: { type: 'string' },
      text: { type: 'string' },
      title: { type: 'string' },
    },
    additionalProperties: false,
  },
  keyboard: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  paste_text: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  press_key: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
    additionalProperties: false,
  },
  voice_input_toggle: {
    type: 'object',
    properties: { dictation_keycode: { type: 'number' } },
    additionalProperties: false,
  },
  mouse_click: {
    type: 'object',
    properties: {
      button: { type: 'string' },
      click_count: { type: 'number' },
      x: { type: 'number' },
      y: { type: 'number' },
    },
    additionalProperties: false,
  },
  mouse_move: {
    type: 'object',
    properties: { x: { type: 'number' }, y: { type: 'number' } },
    required: ['x', 'y'],
    additionalProperties: false,
  },
  activate_application: {
    type: 'object',
    properties: { application: { type: 'string' } },
    required: ['application'],
    additionalProperties: false,
  },
  voice: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  check_native_tts: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  native_tts_speak: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      rate: { type: 'number' },
      retry: { type: 'object' },
      text: { type: 'string' },
      timeout_ms: { type: 'number' },
      voice: { type: 'string' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  regex_extract: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      from: { type: 'string' },
      pattern: { type: 'string' },
    },
    required: ['from', 'pattern'],
    additionalProperties: false,
  },
  json_query: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      from: { type: 'string' },
      path: { type: 'string' },
    },
    required: ['from', 'path'],
    additionalProperties: false,
  },
  run_js: {
    type: 'object',
    properties: { code: { type: 'string' } },
    required: ['code'],
    additionalProperties: false,
  },
  distill_output: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      from: { type: 'string' },
      max_error_lines: { type: 'number' },
      max_head_lines: { type: 'number' },
      max_tail_lines: { type: 'number' },
      text: { type: 'string' },
    },
    additionalProperties: false,
  },
  log: { type: 'object', properties: { message: { type: 'string' } }, additionalProperties: false },
  if: {
    type: 'object',
    properties: { condition: { type: 'string' }, else: { type: 'array' }, then: { type: 'array' } },
    required: ['condition'],
    additionalProperties: false,
  },
  while: {
    type: 'object',
    properties: {
      condition: { type: 'string' },
      max_iterations: { type: 'number' },
      pipeline: { type: 'array' },
    },
    required: ['condition'],
    additionalProperties: false,
  },
};

const SYSTEM_EXTRA_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  screenshot: [{ export_as: 'screenshot_path' }],
  window_list: [{ export_as: 'windows' }],
  chrome_tab_list: [{ export_as: 'tabs' }],
  probe: [{ capability: 'browser' }],
  glob_files: [{ dir: 'active/shared/tmp' }],
  scan_directory: [{ path: 'active/shared/tmp', recursive: true }],
  cli_health_check: [{ command: 'node', args: ['--version'] }],
  list_missions: [{ status: 'active' }],
  list_tool_runtimes: [{ requested_mode: 'trial' }],
  list_service_runtimes: [{ requested_mode: 'trial' }],
  control_media_devices: [{ action: 'select', scope: 'all' }],
  collect_artifacts: [{ mission_ids: ['MSN-20260826-001'] }],
  sample_traces: [{ count: 5 }],
  vision_consult: [{ context: 'active/shared/tmp/vision.png' }],
  test_screen_stream: [{ max_frames: 2 }],
  test_screen_mp4_roundtrip: [{ max_frames: 2 }],
  test_camera_injection: [{ output_path: 'active/shared/tmp/camera.mp4' }],
  sre_analyze: [{ from: 'last_probe' }],
  llm_decide: [{ instruction: 'Choose the safest next step.' }],
  run_applescript: [{ script: 'return "ok"' }],
};

function withInputSchema(op: string, kind: SystemOpSpec['kind']): SystemOpSpec {
  const contract = getOpInputContract('system', op);
  const description = contract
    ? { op, kind, input_schema: contract.schema, examples: contract.examples }
    : SYSTEM_EXTRA_CONTRACTS[op]
      ? {
          op,
          kind,
          input_schema: SYSTEM_EXTRA_CONTRACTS[op],
          examples: SYSTEM_EXTRA_EXAMPLES[op] || [{}],
        }
      : { op, kind };
  return withCatalogInputContract('system', op, kind, description);
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...SYSTEM_ACTUATOR_CAPTURE_OPS.map((op) => withInputSchema(op, 'capture')),
    ...SYSTEM_ACTUATOR_TRANSFORM_OPS.map((op) => withInputSchema(op, 'transform')),
    ...SYSTEM_ACTUATOR_APPLY_OPS.map((op) => withInputSchema(op, 'apply')),
    ...SYSTEM_ACTUATOR_CONTROL_OPS.map((op) => withInputSchema(op, 'control')),
  ];
}
