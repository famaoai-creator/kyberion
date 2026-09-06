// AR-02: self-described op catalog — mirrors the three switch(op) dispatch
// blocks in ios-runtime-helpers.ts (capture / transform / apply), whose
// structure already matches the kinds. Shared-pool members (log -> apply,
// read_json -> capture, set -> transform) sit in the matching blocks, so
// step-type inference is unchanged; all other ops were previously
// unclassifiable (determineActuatorStepType threw unknown-op).

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

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
  log: [{ message: 'completed' }],
};

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
