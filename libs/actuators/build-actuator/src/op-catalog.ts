// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the op dispatch in
// this actuator's source; check:op-registry fails on drift.
//
// Kind notes: none of these ops appear in the shared pools, so every entry
// is strictly additive — determineActuatorStepType previously threw
// unknown-op for all of them.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    app_name: { type: 'string' },
    bundle_id: { type: 'string' },
    connected: { type: 'boolean' },
    dest_dir: { type: 'string' },
    mission_id: { type: 'string' },
    platform: { type: 'string', enum: ['ios', 'android'] },
    project_dir: { type: 'string' },
    scheme: { type: 'string' },
    simulator: { type: 'string' },
    timeout_ms: { type: 'number' },
  },
  additionalProperties: false,
} as const;

const BUILD_EXAMPLE = [{ project_dir: 'active/shared/tmp/mobile-app', timeout_ms: 2700000 }];

export const BUILD_ACTUATOR_CAPTURE_OPS = [] as const;

export const BUILD_ACTUATOR_TRANSFORM_OPS = [] as const;

export const BUILD_ACTUATOR_APPLY_OPS = [
  'ios_generate_project',
  'ios_build',
  'ios_test',
  'ios_archive',
  'android_build',
  'android_test',
  'android_bundle',
] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return { op, kind, input_schema: BUILD_SCHEMA, examples: BUILD_EXAMPLE };
}

export function describeOps() {
  return [
    ...BUILD_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...BUILD_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...BUILD_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
