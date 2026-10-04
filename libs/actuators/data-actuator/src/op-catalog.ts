// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the op dispatch in
// data-helpers.ts; check:op-registry fails on drift.

import type { PipelineStepType } from '../../../core/actuator/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator/actuator-sdk.js';

const WHERE_SCHEMA = {
  type: 'object',
  description: 'Exact-match predicates: every key must equal the row value.',
} as const;

const DATA_PROPERTIES = {
  file: { type: 'string', minLength: 1 },
  file_a: { type: 'string', minLength: 1 },
  file_b: { type: 'string', minLength: 1 },
  key: { type: 'string', minLength: 1 },
  left_key: { type: 'string', minLength: 1 },
  right_key: { type: 'string', minLength: 1 },
  how: { enum: ['inner', 'left'] },
  where: WHERE_SCHEMA,
  select: { type: 'array', items: { type: 'string' } },
  sort_by: { type: 'string' },
  limit: { type: 'integer', minimum: 1 },
  group_by: { type: 'string' },
  aggregations: {
    type: 'array',
    items: {
      type: 'object',
      required: ['func'],
      additionalProperties: false,
      properties: {
        func: { enum: ['count', 'sum', 'avg', 'min', 'max'] },
        field: { type: 'string' },
        as: { type: 'string' },
      },
    },
  },
};

const DATA_SCHEMA = {
  type: 'object',
  properties: DATA_PROPERTIES,
  additionalProperties: false,
} as const;

const DATA_EXAMPLES = {
  query: [
    {
      file: 'active/shared/staging/rows.json',
      where: { status: 'active' },
      select: ['id', 'status'],
      sort_by: 'id',
      limit: 10,
    },
  ],
  filter: [{ file: 'active/shared/staging/rows.csv', where: { status: 'active' } }],
  join: [
    {
      file_a: 'active/shared/staging/orders.json',
      file_b: 'active/shared/staging/customers.json',
      left_key: 'customer_id',
      right_key: 'id',
      how: 'inner',
    },
  ],
  aggregate: [
    {
      file: 'active/shared/staging/orders.json',
      group_by: 'status',
      aggregations: [{ func: 'count', as: 'n' }],
    },
  ],
};

export const DATA_ACTUATOR_CAPTURE_OPS = ['query'] as const;

export const DATA_ACTUATOR_TRANSFORM_OPS = ['filter', 'join', 'aggregate'] as const;

export const DATA_ACTUATOR_APPLY_OPS = [] as const;

function toSpec(op: string, kind: PipelineStepType) {
  const schema = {
    ...DATA_SCHEMA,
    ...(op === 'query' || op === 'filter'
      ? { required: ['file'] }
      : op === 'join'
        ? { required: ['file_a', 'file_b'] }
        : { required: ['file', 'group_by', 'aggregations'] }),
  };
  return {
    op,
    kind,
    input_schema: schema,
    examples: DATA_EXAMPLES[op as keyof typeof DATA_EXAMPLES],
  };
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...DATA_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...DATA_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...DATA_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
