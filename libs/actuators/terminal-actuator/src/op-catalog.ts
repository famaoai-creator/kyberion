// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch switch
// in terminal-actuator-helpers.ts; check:op-registry fails on drift.
//
// Kind notes: ops that previously classified via the shared pools keep their
// historical kind (e.g. list -> capture) so step-type inference does not
// change; every other op previously made determineActuatorStepType throw, so
// those entries are strictly additive.

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

const TERMINAL_SCHEMA = {
  type: 'object',
  properties: {
    args: { type: 'array', items: { type: 'string' } },
    cmd: { type: 'string' },
    cols: { type: 'number' },
    cwd: { type: 'string' },
    data: { type: 'string' },
    degraded_threshold: { type: 'number' },
    env: { type: 'object', additionalProperties: { type: 'string' } },
    export_as: { type: 'string' },
    goal: { type: 'string' },
    keys: { type: 'array', items: { type: 'string' } },
    limit: { type: 'number' },
    observation: { type: 'string' },
    offset: { type: 'number' },
    on_degraded: { type: 'string', enum: ['continue', 'fail'] },
    options: { type: 'array', items: { type: 'string' } },
    persona: { type: 'string' },
    rows: { type: 'number' },
    sessionId: { type: 'string' },
    shell: { type: 'string' },
    text: { type: 'string' },
    threadId: { type: 'string' },
  },
  additionalProperties: false,
} as const;

const TERMINAL_EXAMPLES = {
  spawn: [{ shell: '/bin/zsh', cwd: 'active/shared/tmp' }],
  poll: [{ sessionId: 'terminal-1', limit: 4000 }],
  list: [{}],
  llm_decide: [{ observation: 'command completed', goal: 'choose next action' }],
  shell_command: [{ text: 'pwd' }],
  write: [{ sessionId: 'terminal-1', data: 'echo ready\n' }],
  resize: [{ sessionId: 'terminal-1', cols: 120, rows: 40 }],
  kill: [{ sessionId: 'terminal-1' }],
  spawn_terminal: [{ shell: '/bin/zsh', cwd: 'active/shared/tmp' }],
  poll_terminal: [{ sessionId: 'terminal-1' }],
  write_terminal: [{ sessionId: 'terminal-1', text: 'echo ready\n' }],
  kill_terminal: [{ sessionId: 'terminal-1' }],
  list_terminal_sessions: [{}],
};

export const TERMINAL_ACTUATOR_CAPTURE_OPS = [
  'poll',
  'list',
  'poll_terminal',
  'list_terminal_sessions',
] as const;

export const TERMINAL_ACTUATOR_TRANSFORM_OPS = ['llm_decide'] as const;

export const TERMINAL_ACTUATOR_APPLY_OPS = [
  'spawn',
  'write',
  'resize',
  'kill',
  'spawn_terminal',
  'write_terminal',
  'kill_terminal',
  'shell_command',
] as const;

function toSpec(op: string, kind: PipelineStepType) {
  const required: Record<string, string[]> = {
    poll: ['sessionId'],
    llm_decide: ['observation'],
    write: ['sessionId'],
    resize: ['sessionId', 'cols', 'rows'],
    kill: ['sessionId'],
    poll_terminal: ['sessionId'],
    write_terminal: ['sessionId'],
    kill_terminal: ['sessionId'],
  };
  return {
    op,
    kind,
    input_schema: { ...TERMINAL_SCHEMA, ...(required[op] ? { required: required[op] } : {}) },
    examples: TERMINAL_EXAMPLES[op as keyof typeof TERMINAL_EXAMPLES],
  };
}

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...TERMINAL_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...TERMINAL_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...TERMINAL_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
