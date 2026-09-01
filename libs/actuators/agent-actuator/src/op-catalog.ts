// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch switch
// in agent-actuator-helpers.ts; check:op-registry fails on drift.
//
// Kind notes: ops that previously classified via the shared pools keep their
// historical kind (e.g. list -> capture) so step-type inference does not
// change; every other op previously made determineActuatorStepType throw, so
// those entries are strictly additive.

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

const EMPTY_INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

const EMPTY_INPUT_EXAMPLES = [{}];

type InputSchema = Record<string, unknown>;
const AGENT_CONTRACTS: Record<string, InputSchema> = {
  list: { type: 'object', properties: { filter: {} }, additionalProperties: false },
  list_manifests: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  list_runtimes: {
    type: 'object',
    properties: { export_as: { type: 'string' } },
    additionalProperties: false,
  },
  snapshot: {
    type: 'object',
    properties: { agentId: { type: 'string' } },
    required: ['agentId'],
    additionalProperties: false,
  },
  team_plan: {
    type: 'object',
    properties: { missionId: { type: 'string' } },
    required: ['missionId'],
    additionalProperties: false,
  },
  team_role: {
    type: 'object',
    properties: { missionId: { type: 'string' }, teamRole: { type: 'string' } },
    required: ['missionId', 'teamRole'],
    additionalProperties: false,
  },
  spawn: {
    type: 'object',
    properties: {
      agentId: { type: 'string' },
      capabilities: { type: 'array' },
      cwd: { type: 'string' },
      missionId: { type: 'string' },
      modelId: { type: 'string' },
      parentAgentId: { type: 'string' },
      provider: { type: 'string' },
      systemPrompt: { type: 'string' },
      trustRequired: { type: 'number' },
    },
    required: ['provider'],
    additionalProperties: false,
  },
  ask: {
    type: 'object',
    properties: { agentId: { type: 'string' }, query: { type: 'string' } },
    required: ['agentId', 'query'],
    additionalProperties: false,
  },
  delegate: {
    type: 'object',
    properties: { task: { type: 'object' } },
    required: ['task'],
    additionalProperties: false,
  },
  shutdown: {
    type: 'object',
    properties: { agentId: { type: 'string' } },
    required: ['agentId'],
    additionalProperties: false,
  },
  refresh: {
    type: 'object',
    properties: { agentId: { type: 'string' } },
    required: ['agentId'],
    additionalProperties: false,
  },
  restart: {
    type: 'object',
    properties: {
      agentId: { type: 'string' },
      capabilities: { type: 'array' },
      modelId: { type: 'string' },
      provider: { type: 'string' },
      systemPrompt: { type: 'string' },
    },
    required: ['agentId'],
    additionalProperties: false,
  },
  a2a: {
    type: 'object',
    properties: { envelope: { type: 'object' } },
    required: ['envelope'],
    additionalProperties: false,
  },
  staff_mission: {
    type: 'object',
    properties: { missionId: { type: 'string' } },
    required: ['missionId'],
    additionalProperties: false,
  },
  prewarm_mission: {
    type: 'object',
    properties: { missionId: { type: 'string' } },
    required: ['missionId'],
    additionalProperties: false,
  },
};

const AGENT_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  list: [{}],
  list_manifests: [{}],
  list_runtimes: [{}],
  health: [{}],
  shutdown_all: [{}],
  snapshot: [{ agentId: 'agent-1' }],
  team_plan: [{ missionId: 'MSN-20260826-001' }],
  team_role: [{ missionId: 'MSN-20260826-001', teamRole: 'planner' }],
  spawn: [{ provider: 'stub', modelId: 'deterministic' }],
  ask: [{ agentId: 'agent-1', query: 'status?' }],
  delegate: [{ task: { title: 'Review' } }],
  shutdown: [{ agentId: 'agent-1' }],
  refresh: [{ agentId: 'agent-1' }],
  restart: [{ agentId: 'agent-1' }],
  a2a: [{ envelope: { type: 'ping' } }],
  staff_mission: [{ missionId: 'MSN-20260826-001' }],
  prewarm_mission: [{ missionId: 'MSN-20260826-001' }],
};

export const AGENT_ACTUATOR_CAPTURE_OPS = [
  'list',
  'list_manifests',
  'list_runtimes',
  'health',
  'snapshot',
] as const;

export const AGENT_ACTUATOR_TRANSFORM_OPS = ['team_plan', 'team_role'] as const;

export const AGENT_ACTUATOR_APPLY_OPS = [
  'spawn',
  'ask',
  'delegate',
  'shutdown',
  'shutdown_all',
  'refresh',
  'restart',
  'a2a',
  'staff_mission',
  'prewarm_mission',
] as const;

function toSpec(op: string, kind: PipelineStepType) {
  const schema = AGENT_CONTRACTS[op];
  return schema
    ? { op, kind, input_schema: schema, examples: AGENT_EXAMPLES[op] || [{}] }
    : op === 'health' || op === 'shutdown_all'
      ? { op, kind, input_schema: EMPTY_INPUT_SCHEMA, examples: EMPTY_INPUT_EXAMPLES }
      : { op, kind };
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...AGENT_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...AGENT_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...AGENT_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
