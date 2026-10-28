// AR-02: self-described op catalog — mirrors the three switch(op) dispatch
// blocks in ios-runtime-helpers.ts (capture / transform / apply), whose
// structure already matches the kinds. Shared-pool members (log -> apply,
// read_json -> capture, set -> transform) sit in the matching blocks, so
// step-type inference is unchanged; all other ops were previously
// unclassifiable (determineActuatorStepType threw unknown-op).

import type { PipelineStepType } from '@agent/core/actuator/actuator-op-registry';
import type { ActuatorOpDescription } from '@agent/core/actuator/actuator-sdk';

type InputSchema = Record<string, unknown>;

const IOS_CONTRACTS: Record<string, InputSchema> = {
  capture_runtime_session_handoff: {
    type: 'object',
    properties: {
      bundle_id: { type: 'string' },
      container_relative_path: { type: 'string' },
      export_as: { type: 'string' },
      path: { type: 'string' },
    },
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
  simctl_health_check: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  describe_ui: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  set: {
    type: 'object',
    properties: { key: { type: 'string' }, value: {} },
    required: ['key'],
    additionalProperties: false,
  },
  boot_simulator: { type: 'object', properties: {}, additionalProperties: false },
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
  install_app: {
    type: 'object',
    properties: { app_path: { type: 'string' } },
    required: ['app_path'],
    additionalProperties: false,
  },
  launch_app: {
    type: 'object',
    properties: { bundle_id: { type: 'string' } },
    required: ['bundle_id'],
    additionalProperties: false,
  },
  open_deep_link: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
    additionalProperties: false,
  },
  shutdown_simulator: { type: 'object', properties: {}, additionalProperties: false },
  tap: {
    type: 'object',
    properties: { x: { type: 'number' }, y: { type: 'number' } },
    required: ['x', 'y'],
    additionalProperties: false,
  },
  tap_ui_node: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      identifier: { type: 'string' },
      id: { type: 'string' },
      dry_run: { type: 'boolean' },
      export_as: { type: 'string' },
    },
    additionalProperties: false,
  },
  swipe: {
    type: 'object',
    properties: {
      x1: { type: 'number' },
      y1: { type: 'number' },
      x2: { type: 'number' },
      y2: { type: 'number' },
      start_x: { type: 'number' },
      start_y: { type: 'number' },
      end_x: { type: 'number' },
      end_y: { type: 'number' },
      duration_ms: { type: 'number' },
    },
    additionalProperties: false,
  },
  input_text: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  press_button: {
    type: 'object',
    properties: { name: { type: 'string' }, button: { type: 'string' } },
    additionalProperties: false,
  },
  start_screen_stream: {
    type: 'object',
    properties: {
      fps: { type: 'number' },
      no_input: { type: 'boolean' },
      export_as: { type: 'string' },
    },
    additionalProperties: false,
  },
  stop_screen_stream: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  stream_status: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  uninstall_app: {
    type: 'object',
    properties: { bundle_id: { type: 'string' } },
    required: ['bundle_id'],
    additionalProperties: false,
  },
  log: { type: 'object', properties: { message: { type: 'string' } }, additionalProperties: false },
};

const IOS_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  capture_runtime_session_handoff: [{ path: 'active/shared/tmp/ios-handoff.json' }],
  read_json: [{ path: 'active/shared/tmp/config.json' }],
  read_text_file: [{ path: 'active/shared/tmp/log.txt' }],
  simctl_health_check: [{}],
  set: [{ key: 'simulator_name', value: 'iPhone 15' }],
  boot_simulator: [{}],
  capture_screen: [{ path: 'active/shared/tmp/ios-screen.png' }],
  emit_session_handoff: [{ path: 'active/shared/tmp/ios-handoff.json' }],
  install_app: [{ app_path: 'active/shared/tmp/App.app' }],
  launch_app: [{ bundle_id: 'com.example.app' }],
  open_deep_link: [{ url: 'example://home' }],
  shutdown_simulator: [{}],
  uninstall_app: [{ bundle_id: 'com.example.app' }],
  describe_ui: [{}],
  tap: [{ x: 200, y: 480 }],
  tap_ui_node: [{ text: 'Sign in' }, { identifier: 'login-button', dry_run: true }],
  swipe: [{ x1: 200, y1: 600, x2: 200, y2: 200, duration_ms: 350 }],
  input_text: [{ text: 'user@example.com' }],
  press_button: [{ name: 'home' }],
  start_screen_stream: [{ fps: 3 }],
  stop_screen_stream: [{}],
  stream_status: [{}],
  log: [{ message: 'completed' }],
};

export const IOS_ACTUATOR_CAPTURE_OPS = [
  'capture_runtime_session_handoff',
  'describe_ui',
  'read_json',
  'read_text_file',
  'simctl_health_check',
] as const;

export const IOS_ACTUATOR_TRANSFORM_OPS = ['set'] as const;

export const IOS_ACTUATOR_APPLY_OPS = [
  'boot_simulator',
  'capture_screen',
  'emit_session_handoff',
  'input_text',
  'install_app',
  'launch_app',
  'log',
  'open_deep_link',
  'press_button',
  'shutdown_simulator',
  'start_screen_stream',
  'stop_screen_stream',
  'stream_status',
  'swipe',
  'tap',
  'tap_ui_node',
  'uninstall_app',
] as const;

function toSpec(op: string, kind: PipelineStepType) {
  const schema = IOS_CONTRACTS[op];
  return schema
    ? { op, kind, input_schema: schema, examples: IOS_EXAMPLES[op] || [{}] }
    : { op, kind };
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...IOS_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...IOS_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...IOS_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
