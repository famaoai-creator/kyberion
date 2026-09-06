import { withCatalogInputContract } from '../../../core/actuator-sdk.js';

// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch
// switches in the pipeline helpers; check:op-registry fails on drift.

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

type InputSchema = Record<string, unknown>;
const NETWORK_CONTROL_SCHEMA: InputSchema = {
  type: 'object',
  properties: { condition: { type: 'string' }, else: { type: 'array' }, then: { type: 'array' } },
  required: ['condition'],
  additionalProperties: false,
};
const NETWORK_CONTRACTS: Record<string, InputSchema> = {
  a2a_poll: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  fetch: {
    type: 'object',
    properties: {
      data: {},
      export_as: { type: 'string' },
      headers: { type: 'object' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      query: { type: 'object' },
      timeout: { type: 'number' },
      url: { type: 'string' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  shell: {
    type: 'object',
    properties: { cmd: { type: 'string' }, export_as: { type: 'string' } },
    required: ['cmd'],
    additionalProperties: false,
  },
  json_query: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      from: { type: 'string' },
      path: { type: 'string' },
    },
    required: ['from', 'path'],
    additionalProperties: false,
  },
  regex_extract: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      from: { type: 'string' },
      pattern: { type: 'string' },
    },
    required: ['from', 'pattern'],
    additionalProperties: false,
  },
  distill_response: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      from: { type: 'string' },
      max_json_keys: { type: 'number' },
      max_links: { type: 'number' },
      max_preview_chars: { type: 'number' },
    },
    required: ['from'],
    additionalProperties: false,
  },
  a2a_send: {
    type: 'object',
    properties: {
      encrypt: { type: 'boolean' },
      message: {},
      method: { type: 'string' },
      target_public_key: { type: 'string' },
    },
    required: ['message'],
    additionalProperties: false,
  },
  llm_decide: {
    type: 'object',
    properties: {
      degraded_threshold: { type: 'number' },
      export_as: { type: 'string' },
      from: { type: 'string' },
      goal: { type: 'string' },
      instruction: { type: 'string' },
      observation: {},
      on_degraded: { type: 'string' },
      options: {},
      prompt: { type: 'string' },
    },
    required: ['goal'],
    additionalProperties: false,
  },
  write_artifact: {
    type: 'object',
    properties: {
      artifact: { type: 'object' },
      content: {},
      data: {},
      output_path: { type: 'string' },
      path: { type: 'string' },
    },
    additionalProperties: false,
  },
  write_file: {
    type: 'object',
    properties: { content: {}, data: {}, from: { type: 'string' }, path: { type: 'string' } },
    additionalProperties: false,
  },
  log: { type: 'object', properties: { message: { type: 'string' } }, additionalProperties: false },
  if: NETWORK_CONTROL_SCHEMA,
  while: {
    type: 'object',
    properties: {
      condition: { type: 'string' },
      max_iterations: { type: 'number' },
      pipeline: { type: 'array' },
    },
    required: ['condition'],
    additionalProperties: false,
  },
};

const NETWORK_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  a2a_poll: [{}],
  fetch: [{ url: 'https://example.invalid/api', method: 'GET' }],
  shell: [{ cmd: 'curl --version' }],
  json_query: [{ from: 'response', path: '.items' }],
  regex_extract: [{ from: 'response', pattern: 'id=(?<id>\\w+)' }],
  distill_response: [{ from: 'response', max_preview_chars: 2000 }],
  a2a_send: [{ message: { type: 'ping' } }],
  log: [{ message: 'completed' }],
  if: [{ condition: 'ready' }],
  while: [{ condition: 'pending', max_iterations: 3 }],
  llm_decide: [{ instruction: 'Choose the safest next step.' }],
  write_artifact: [{ output_path: 'active/shared/tmp/artifact.json', content: '{}' }],
  write_file: [{ path: 'active/shared/tmp/note.txt', content: 'completed' }],
};

export const NETWORK_ACTUATOR_CAPTURE_OPS = ['a2a_poll', 'fetch', 'shell'] as const;

export const NETWORK_ACTUATOR_TRANSFORM_OPS = [
  'json_query',
  'regex_extract',
  'distill_response',
  'llm_decide',
] as const;

export const NETWORK_ACTUATOR_APPLY_OPS = [
  'a2a_send',
  'log',
  'write_artifact',
  'write_file',
] as const;

export const NETWORK_ACTUATOR_CONTROL_OPS = ['if', 'while'] as const;

const toSpec = (op: string, kind: PipelineStepType) => {
  const schema = NETWORK_CONTRACTS[op];
  const description = schema
    ? { op, kind, input_schema: schema, examples: NETWORK_EXAMPLES[op] || [{}] }
    : { op, kind };
  return withCatalogInputContract('network', op, kind, description);
};

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...NETWORK_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...NETWORK_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...NETWORK_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
    ...NETWORK_ACTUATOR_CONTROL_OPS.map((op) => toSpec(op, 'control')),
  ];
}
