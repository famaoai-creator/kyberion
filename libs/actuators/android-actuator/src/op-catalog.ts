// AR-02: self-described op catalog — mirrors the three switch(op) dispatch
// blocks in android-runtime-helpers.ts (capture / transform / apply), whose
// structure already matches the kinds. Shared-pool members (log -> apply,
// read_json -> capture, set -> transform) sit in the matching blocks, so
// step-type inference is unchanged; all other ops were previously
// unclassifiable (determineActuatorStepType threw unknown-op).

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

type InputSchema = Record<string, unknown>;

const ANDROID_UI_SELECTOR_PROPERTIES: Record<string, unknown> = {
  class_name: { type: 'string' },
  clickable: { type: 'boolean' },
  enabled: { type: 'boolean' },
  export_as: { type: 'string' },
  from: { type: 'string' },
  package_name: { type: 'string' },
  resource_id: { type: 'string' },
  source: { type: 'string' },
  text: { type: 'string' },
};

const ANDROID_UI_SELECTOR_SCHEMA: InputSchema = {
  type: 'object',
  properties: ANDROID_UI_SELECTOR_PROPERTIES,
  additionalProperties: false,
};

const ANDROID_UI_ACTION_PROPERTIES: Record<string, unknown> = {
  ...ANDROID_UI_SELECTOR_PROPERTIES,
  dry_run: { type: 'boolean' },
  match_index: { type: 'number' },
  serial: { type: 'string' },
};

const ANDROID_CONTRACTS: Record<string, InputSchema> = {
  adb_health_check: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  android_cli_describe: {
    type: 'object',
    properties: { apk_path: { type: 'string' }, export_as: { type: 'string' } },
    additionalProperties: false,
  },
  android_cli_docs_search: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      limit: { type: 'number' },
      query: { type: 'string' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  android_cli_health_check: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  android_cli_layout: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      path: { type: 'string' },
      pretty: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  android_cli_screen_resolve: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      label: { type: 'string' },
      screenshot_path: { type: 'string' },
      string: { type: 'string' },
    },
    additionalProperties: false,
  },
  capture_foreground_activity: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  capture_runtime_session_handoff: {
    type: 'object',
    properties: {
      device_path: { type: 'string' },
      export_as: { type: 'string' },
      path: { type: 'string' },
    },
    additionalProperties: false,
  },
  extract_ui_tree: {
    type: 'object',
    properties: { export_as: { type: 'string' }, path: { type: 'string' } },
    additionalProperties: false,
  },
  read_json: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      path: { type: 'string' },
      validate_as: { type: 'string' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  read_text_file: {
    type: 'object',
    properties: { export_as: { type: 'string' }, path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  summarize_ui_tree: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      max_resource_ids: { type: 'number' },
      max_texts: { type: 'number' },
    },
    additionalProperties: false,
  },
  android_cli_screen_capture: {
    type: 'object',
    properties: {
      annotate: { type: 'boolean' },
      export_as: { type: 'string' },
      path: { type: 'string' },
    },
    additionalProperties: false,
  },
  capture_screen: {
    type: 'object',
    properties: { path: { type: 'string' } },
    additionalProperties: false,
  },
  emit_session_handoff: {
    type: 'object',
    properties: { export_as: { type: 'string' }, path: { type: 'string' } },
    additionalProperties: false,
  },
  input_text: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  launch_app: {
    type: 'object',
    properties: { component: { type: 'string' } },
    required: ['component'],
    additionalProperties: false,
  },
  open_deep_link: {
    type: 'object',
    properties: { package: { type: 'string' }, url: { type: 'string' } },
    required: ['url'],
    additionalProperties: false,
  },
  set: {
    type: 'object',
    properties: { key: { type: 'string' }, value: {} },
    required: ['key'],
    additionalProperties: false,
  },
  swipe: {
    type: 'object',
    properties: {
      duration_ms: { type: 'number' },
      x1: { type: 'number' },
      x2: { type: 'number' },
      y1: { type: 'number' },
      y2: { type: 'number' },
    },
    required: ['x1', 'y1', 'x2', 'y2'],
    additionalProperties: false,
  },
  tap: {
    type: 'object',
    properties: { x: { type: 'number' }, y: { type: 'number' } },
    required: ['x', 'y'],
    additionalProperties: false,
  },
  wait_for_ui_text: {
    type: 'object',
    properties: {
      interval_ms: { type: 'number' },
      text: { type: 'string' },
      timeout_ms: { type: 'number' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  find_ui_nodes: {
    ...ANDROID_UI_SELECTOR_SCHEMA,
  },
  llm_decide: {
    type: 'object',
    properties: {
      context: {},
      export_as: { type: 'string' },
      instruction: { type: 'string' },
      options: {},
      prompt: { type: 'string' },
    },
    additionalProperties: false,
  },
  authenticate_with_passkey: {
    type: 'object',
    properties: {
      ...ANDROID_UI_ACTION_PROPERTIES,
      app_profile: { type: 'object' },
      app_profile_from: { type: 'string' },
      profile: { type: 'object' },
      profile_from: { type: 'string' },
      selector_class_name: { type: 'string' },
      selector_package_name: { type: 'string' },
      selector_resource_id: { type: 'string' },
      selector_text: { type: 'string' },
    },
    additionalProperties: false,
  },
  fill_login_form: {
    type: 'object',
    properties: {
      ...ANDROID_UI_ACTION_PROPERTIES,
      app_profile: { type: 'object' },
      app_profile_from: { type: 'string' },
      email: { type: 'string' },
      email_selector_class_name: { type: 'string' },
      email_selector_package_name: { type: 'string' },
      email_selector_resource_id: { type: 'string' },
      email_selector_text: { type: 'string' },
      password: { type: 'string' },
      password_selector_class_name: { type: 'string' },
      password_selector_package_name: { type: 'string' },
      password_selector_resource_id: { type: 'string' },
      password_selector_text: { type: 'string' },
      pre_input_delay_ms: { type: 'number' },
      profile: { type: 'object' },
      profile_from: { type: 'string' },
      submit: { type: 'boolean' },
      submit_selector_class_name: { type: 'string' },
      submit_selector_package_name: { type: 'string' },
      submit_selector_resource_id: { type: 'string' },
      submit_selector_text: { type: 'string' },
    },
    required: ['email', 'password'],
    additionalProperties: false,
  },
  input_text_into_ui_node: {
    type: 'object',
    properties: {
      ...ANDROID_UI_ACTION_PROPERTIES,
      app_profile: { type: 'object' },
      profile: { type: 'object' },
      pre_input_delay_ms: { type: 'number' },
      selector: { type: 'object' },
      selector_class_name: { type: 'string' },
      selector_package_name: { type: 'string' },
      selector_resource_id: { type: 'string' },
      selector_text: { type: 'string' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  log: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false,
  },
  tap_ui_node: {
    type: 'object',
    properties: ANDROID_UI_ACTION_PROPERTIES,
    additionalProperties: false,
  },
  wait_for_ui_node: {
    type: 'object',
    properties: {
      ...ANDROID_UI_ACTION_PROPERTIES,
      interval_ms: { type: 'number' },
      timeout_ms: { type: 'number' },
    },
    additionalProperties: false,
  },
};

const ANDROID_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  adb_health_check: [{}],
  android_cli_describe: [{ apk_path: 'active/shared/tmp/app.apk' }],
  android_cli_docs_search: [{ query: 'screen capture', limit: 5 }],
  android_cli_health_check: [{}],
  android_cli_layout: [{ pretty: true }],
  android_cli_screen_resolve: [{ label: 'Login' }],
  capture_foreground_activity: [{}],
  capture_runtime_session_handoff: [{ path: 'active/shared/tmp/handoff.json' }],
  extract_ui_tree: [{ path: 'active/shared/tmp/ui.xml' }],
  read_json: [{ path: 'active/shared/tmp/config.json' }],
  read_text_file: [{ path: 'active/shared/tmp/ui.xml' }],
  summarize_ui_tree: [{ max_texts: 20 }],
  android_cli_screen_capture: [{ path: 'active/shared/tmp/screen.png' }],
  capture_screen: [{ path: 'active/shared/tmp/screen.png' }],
  emit_session_handoff: [{ path: 'active/shared/tmp/handoff.json' }],
  input_text: [{ text: 'hello' }],
  launch_app: [{ component: 'com.example/.MainActivity' }],
  open_deep_link: [{ url: 'example://home' }],
  set: [{ key: 'last_screen', value: 'active/shared/tmp/screen.png' }],
  swipe: [{ x1: 100, y1: 600, x2: 100, y2: 200 }],
  tap: [{ x: 120, y: 240 }],
  wait_for_ui_text: [{ text: 'Ready', timeout_ms: 15000 }],
  find_ui_nodes: [{ text: 'Login' }],
  llm_decide: [{ instruction: 'Choose the safest next step.' }],
  authenticate_with_passkey: [{ dry_run: true }],
  fill_login_form: [{ dry_run: true, submit: false }],
  input_text_into_ui_node: [{ text: 'hello', dry_run: true }],
  log: [{ message: 'completed' }],
  tap_ui_node: [{ dry_run: true }],
  wait_for_ui_node: [{ timeout_ms: 15000 }],
};

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

function toSpec(op: string, kind: PipelineStepType) {
  const schema = ANDROID_CONTRACTS[op];
  return schema
    ? { op, kind, input_schema: schema, examples: ANDROID_EXAMPLES[op] || [{}] }
    : { op, kind };
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...ANDROID_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...ANDROID_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...ANDROID_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
