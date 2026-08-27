// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the op dispatch in
// this actuator's source; check:op-registry fails on drift.
//
// Kind notes: none of these ops appear in the shared pools, so every entry
// is strictly additive — determineActuatorStepType previously threw
// unknown-op for all of them.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

const PRESENCE_SCHEMA = {
  type: 'object',
  properties: {
    channel: { type: 'string' },
    mode: { enum: ['emitter', 'listener', 'conversational'] },
    payload: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        attachments: { type: 'array' },
        threadId: { type: 'string' },
        targetPersona: { type: 'string' },
        from: { type: 'string' },
        event_type: { type: 'string' },
        event_data: {},
        timeline: {},
        person_slug: { type: 'string' },
        org: { type: 'string' },
        summary: { type: 'string' },
        tone_shifts: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  },
  required: ['channel', 'payload'],
  additionalProperties: false,
} as const;

const PRESENCE_EXAMPLE = [
  { channel: 'operator', payload: { text: 'status update', threadId: 'thread-1' } },
];

export const PRESENCE_ACTUATOR_CAPTURE_OPS = [] as const;

export const PRESENCE_ACTUATOR_TRANSFORM_OPS = [] as const;

export const PRESENCE_ACTUATOR_APPLY_OPS = [
  'receive_event',
  'dispatch',
  'dispatch_timeline',
  'record_interaction',
] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return { op, kind, input_schema: PRESENCE_SCHEMA, examples: PRESENCE_EXAMPLE };
}

export function describeOps() {
  return [
    ...PRESENCE_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...PRESENCE_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...PRESENCE_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
