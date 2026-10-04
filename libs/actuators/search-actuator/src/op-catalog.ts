// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the op dispatch in
// this actuator's source; check:op-registry fails on drift.
//
// Scope note: search-actuator owns the query starting point (web_search) and
// a bounded plain-text reader (fetch_reader). General fetch / A2A transport
// pipelines stay with network-actuator (network-pipeline.schema.json).

import type { PipelineStepType } from '../../../core/actuator/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator/actuator-sdk.js';

const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    provider: { type: 'string', minLength: 1 },
    top_k: { type: 'integer', minimum: 1, maximum: 50 },
  },
  additionalProperties: false,
} as const;

const READER_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', minLength: 1 },
    max_chars: { type: 'integer', minimum: 1, maximum: 200000 },
  },
  additionalProperties: false,
} as const;

const SEARCH_EXAMPLES = {
  web_search: [{ query: 'kyberion actuator contract', top_k: 5 }],
  fetch_reader: [{ url: 'https://example.com/', max_chars: 8000 }],
};

export const SEARCH_ACTUATOR_CAPTURE_OPS = ['web_search', 'fetch_reader'] as const;

export const SEARCH_ACTUATOR_TRANSFORM_OPS = [] as const;

export const SEARCH_ACTUATOR_APPLY_OPS = [] as const;

function toSpec(op: string, kind: PipelineStepType) {
  const schema =
    op === 'web_search'
      ? { ...SEARCH_SCHEMA, required: ['query'] }
      : { ...READER_SCHEMA, required: ['url'] };
  return {
    op,
    kind,
    input_schema: schema,
    examples: SEARCH_EXAMPLES[op as keyof typeof SEARCH_EXAMPLES],
  };
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...SEARCH_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...SEARCH_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...SEARCH_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
