// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the op dispatch in
// this actuator's source; check:op-registry fails on drift.
//
// Kind notes: none of these ops appear in the shared pools, so every entry
// is strictly additive — determineActuatorStepType previously threw
// unknown-op for all of them.

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

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
  event_id: { type: 'string' },
  reminder_minutes_before_start: { type: 'integer', minimum: 0 },
  send_updates: { enum: ['all', 'externalOnly', 'none'] },
  duration_minutes: { type: 'integer', minimum: 1 },
  slot_step_minutes: { type: 'integer', minimum: 1 },
  business_calendar: { enum: ['none', 'japanese_bank'] },
  working_hours: {
    type: 'object',
    properties: {
      start: { type: 'string' },
      end: { type: 'string' },
      weekdays: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
    },
    required: ['start', 'end'],
    additionalProperties: false,
  },
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
  find_slots: [
    {
      calendar_names: ['primary'],
      start_date: '2026-08-26T00:00:00+09:00',
      end_date: '2026-08-29T00:00:00+09:00',
      duration_minutes: 60,
      business_calendar: 'japanese_bank',
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
  update_event: [
    {
      calendar_id: 'primary',
      event_id: 'event-123',
      start_date: '2026-08-26T11:00:00+09:00',
      end_date: '2026-08-26T12:00:00+09:00',
      reminder_minutes_before_start: 15,
    },
  ],
  delete_event: [{ calendar_id: 'primary', event_id: 'event-123' }],
};

export const CALENDAR_ACTUATOR_CAPTURE_OPS = [
  'list_calendars',
  'list_events',
  'query_freebusy',
  'find_slots',
] as const;

export const CALENDAR_ACTUATOR_TRANSFORM_OPS = [] as const;

export const CALENDAR_ACTUATOR_APPLY_OPS = [
  'create_event',
  'update_event',
  'delete_event',
] as const;

function toSpec(op: string, kind: PipelineStepType) {
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
      : op === 'update_event' || op === 'delete_event'
        ? { required: ['event_id', 'calendar_id'] }
        : {}),
  };
  return {
    op,
    kind,
    input_schema: schema,
    examples: CALENDAR_EXAMPLES[op as keyof typeof CALENDAR_EXAMPLES],
  };
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...CALENDAR_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...CALENDAR_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...CALENDAR_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
