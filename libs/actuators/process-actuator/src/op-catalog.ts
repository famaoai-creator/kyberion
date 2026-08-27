// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch switch
// in process-actuator-helpers.ts; check:op-registry fails on drift.
//
// Kind notes: ops that previously classified via the shared pools keep their
// historical kind (e.g. list -> capture) so step-type inference does not
// change; every other op previously made determineActuatorStepType throw, so
// those entries are strictly additive.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

const PROCESS_PROPERTIES = {
  args: { type: 'array', items: { type: 'string' } },
  command: { type: 'string' },
  cwd: { type: 'string' },
  env: { type: 'object', additionalProperties: { type: 'string' } },
  export_as: { type: 'string' },
  kind: { type: 'string' },
  ownerId: { type: 'string' },
  ownerType: { type: 'string' },
  resourceId: { type: 'string' },
  shutdownPolicy: { type: 'string', enum: ['manual', 'mission', 'task', 'process'] },
};

const PROCESS_SCHEMA = {
  type: 'object',
  properties: PROCESS_PROPERTIES,
  additionalProperties: false,
} as const;

const PROCESS_EXAMPLES = {
  status: [{ resourceId: 'surface:operator' }],
  list: [{}],
  'list-surfaces': [{ export_as: 'surfaces' }],
  spawn: [
    {
      resourceId: 'surface:operator',
      kind: 'surface',
      ownerId: 'mission-123',
      ownerType: 'mission',
      command: 'pnpm',
      args: ['surface', 'start', 'operator'],
      shutdownPolicy: 'mission',
    },
  ],
  stop: [{ resourceId: 'surface:operator' }],
};

export const PROCESS_ACTUATOR_CAPTURE_OPS = ['status', 'list', 'list-surfaces'] as const;

export const PROCESS_ACTUATOR_TRANSFORM_OPS = [] as const;

export const PROCESS_ACTUATOR_APPLY_OPS = ['spawn', 'stop'] as const;

function toSpec(op: string, kind: OpSpecKind) {
  const required =
    op === 'spawn'
      ? ['resourceId', 'command', 'kind', 'ownerId', 'ownerType']
      : op === 'stop' || op === 'status'
        ? ['resourceId']
        : [];
  return {
    op,
    kind,
    input_schema: { ...PROCESS_SCHEMA, ...(required.length > 0 ? { required } : {}) },
    examples: PROCESS_EXAMPLES[op as keyof typeof PROCESS_EXAMPLES],
  };
}

export function describeOps() {
  return [
    ...PROCESS_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...PROCESS_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...PROCESS_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
