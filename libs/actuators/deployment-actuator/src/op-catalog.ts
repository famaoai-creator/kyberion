type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

const DEPLOYMENT_SCHEMA = {
  type: 'object',
  properties: {
    environment: { type: 'string' },
    mission_id: { type: 'string' },
    project_name: { type: 'string' },
    release_notes_path: { type: 'string' },
    version: { type: 'string' },
  },
  required: ['mission_id', 'project_name', 'version', 'environment'],
  additionalProperties: false,
} as const;

export const DEPLOYMENT_ACTUATOR_CAPTURE_OPS = [] as const;
export const DEPLOYMENT_ACTUATOR_TRANSFORM_OPS = [] as const;
export const DEPLOYMENT_ACTUATOR_APPLY_OPS = ['deploy_release'] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return {
    op,
    kind,
    input_schema: DEPLOYMENT_SCHEMA,
    examples: [
      {
        mission_id: 'MSN-20260826-001',
        project_name: 'kyberion',
        version: '2026.08.26',
        environment: 'staging',
      },
    ],
  };
}

export function describeOps() {
  return [
    ...DEPLOYMENT_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...DEPLOYMENT_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...DEPLOYMENT_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
