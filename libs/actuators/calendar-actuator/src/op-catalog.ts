// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the op dispatch in
// this actuator's source; check:op-registry fails on drift.
//
// Kind notes: none of these ops appear in the shared pools, so every entry
// is strictly additive — determineActuatorStepType previously threw
// unknown-op for all of them.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

const CALENDAR_PROPERTIES = {
  attendees: { type: 'array', items: { type: 'string' } },
  backend: { type: 'string' },
  backends: { type: 'array', items: { type: 'string' } },
  calendar_id: { type: 'string' },
  calendar_names: { type: 'array', items: { type: 'string' } },
  calendar_targets: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        backend: { type: 'string' },
        calendar_id: { type: 'string' },
        calendar_name: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  conference_request_id: { type: 'string' },
  description: { type: 'string' },
  end_date: { type: 'string', format: 'date-time' },
  location: { type: 'string' },
  query: { type: 'string' },
  start_date: { type: 'string', format: 'date-time' },
  time_zone: { type: 'string' },
  title: { type: 'string' },
  with_meet: { type: 'boolean' },
};

const CALENDAR_SCHEMA = {
  type: 'object',
  properties: CALENDAR_PROPERTIES,
  additionalProperties: false,
} as const;

const CALENDAR_EXAMPLES = {
  list_calendars: [{ backend: 'auto' }],
  list_events: [{ calendar_names: ['primary'], start_date: '2026-08-26T00:00:00+09:00' }],
  query_freebusy: [
    {
      calendar_names: ['primary'],
      start_date: '2026-08-26T09:00:00+09:00',
      end_date: '2026-08-26T18:00:00+09:00',
    },
  ],
  create_event: [
    {
      calendar_names: ['primary'],
      title: 'Review',
      start_date: '2026-08-26T10:00:00+09:00',
      end_date: '2026-08-26T11:00:00+09:00',
    },
  ],
};

export const CALENDAR_ACTUATOR_CAPTURE_OPS = [
  'list_calendars',
  'list_events',
  'query_freebusy',
] as const;

export const CALENDAR_ACTUATOR_TRANSFORM_OPS = [] as const;

export const CALENDAR_ACTUATOR_APPLY_OPS = ['create_event'] as const;

function toSpec(op: string, kind: OpSpecKind) {
  const schema = {
    ...CALENDAR_SCHEMA,
    ...(op === 'create_event'
      ? {
          required: ['title', 'start_date'],
          anyOf: [
            { required: ['calendar_id'] },
            { required: ['calendar_names'] },
            { required: ['calendar_targets'] },
          ],
        }
      : {}),
  };
  return {
    op,
    kind,
    input_schema: schema,
    examples: CALENDAR_EXAMPLES[op as keyof typeof CALENDAR_EXAMPLES],
  };
}

export function describeOps() {
  return [
    ...CALENDAR_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...CALENDAR_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...CALENDAR_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
