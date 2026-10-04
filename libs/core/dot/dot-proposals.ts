/**
 * Dot action proposals — the only way a resident dot asks for work to happen.
 *
 * A dot is a coordinator: during a wake it observes and then *proposes*
 * actions. It never performs them. The runtime turns each proposal into a
 * governed outcome (`dot-dispatch.ts`): autonomous-ops-gate verdict raised to
 * the charter floor, then a WorkItem, a parked decision card, or a refusal.
 *
 * Two producers share one contract:
 * - tool-capable backends call the `dot_propose_action` tool;
 * - delegated (shell CLI) backends end their reply with a fenced
 *   ```dot-proposals``` JSON array.
 */

import type { ToolDefinition } from '../reasoning/reasoning-backend-contracts.js';

export type DotWorkShape = 'mission' | 'task_session' | 'pipeline' | 'direct_reply';
export type DotDecisionLevel = 'auto' | 'notify' | 'approve';

export interface DotProposal {
  /** Derived, never dot-chosen: {@link DOT_HANDOFF_ACTION_ID} with handoff_to, else {@link DEFAULT_DOT_ACTION_ID}. */
  action_id: string;
  title: string;
  /** What the delegated worker (or receiving dot) should accomplish. */
  objective: string;
  work_shape: DotWorkShape;
  rationale?: string;
  /** Repo-relative paths the work is expected to touch (high-risk paths force approve). */
  changed_paths?: string[];
  /** A dot may ask for a stricter decision than the gate computes, never a looser one. */
  requested_decision?: DotDecisionLevel;
  /** Hand the work to another dot instead of the worker pool. */
  handoff_to?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  /** pipeline-shaped work: repo-relative pipeline, must be in charter authority.allowed_pipelines to execute. */
  pipeline_ref?: string;
  /** What this action should move; the outcome check measures it after the settle window. */
  expected_effect?: DotExpectedEffect;
  /** Normalized target: path:<glob>, service:<id>, pr:<owner>/<repo>#<n>, work_item:<id>, org_operation:<id>. */
  target?: string;
  intent?: DotProposalIntent;
}

export interface DotExpectedEffect {
  kr_id?: string;
  signal?: string;
  direction: 'increase' | 'decrease' | 'maintain';
}

export const DOT_PROPOSAL_INTENTS = [
  'create',
  'remove',
  'enable',
  'disable',
  'increase',
  'decrease',
  'apply',
  'revert',
  'merge',
  'close',
  'update',
] as const;
export type DotProposalIntent = (typeof DOT_PROPOSAL_INTENTS)[number];

const EFFECT_DIRECTIONS = ['increase', 'decrease', 'maintain'] as const;
const TARGET_PATTERN =
  /^(path:\S.*|service:[A-Za-z0-9][A-Za-z0-9._-]*|pr:[\w.-]+\/[\w.-]+#\d+|work_item:\S+|org_operation:\S+)$/;

export const DOT_PROPOSE_TOOL_NAME = 'dot_propose_action';
export const DOT_PROPOSALS_FENCE = 'dot-proposals';
export const DEFAULT_DOT_ACTION_ID = 'dot_delegate_work';
export const DOT_HANDOFF_ACTION_ID = 'dot_handoff';
/** The only policy actions a dot proposal can resolve to. */
export const DOT_ACTION_IDS: readonly string[] = [DEFAULT_DOT_ACTION_ID, DOT_HANDOFF_ACTION_ID];
/** A wake that proposes more than this is cut off; the rest is reported as errors. */
export const MAX_DOT_PROPOSALS_PER_WAKE = 10;

const WORK_SHAPES: readonly DotWorkShape[] = [
  'mission',
  'task_session',
  'pipeline',
  'direct_reply',
];
const DECISIONS: readonly DotDecisionLevel[] = ['auto', 'notify', 'approve'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const MAX_TEXT = 4000;

export function buildDotProposeToolDefinition(): ToolDefinition {
  return {
    name: DOT_PROPOSE_TOOL_NAME,
    description:
      'Propose one action for the runtime to govern. You never act directly: the proposal is scored by the autonomous-ops gate, raised to your charter floor, and then delegated as a WorkItem, sent to the operator for a decision, or refused. Call once per action.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short imperative title (<= 200 chars).' },
        objective: {
          type: 'string',
          description: 'What the delegated worker should accomplish, with acceptance criteria.',
        },
        work_shape: { type: 'string', enum: [...WORK_SHAPES] },
        rationale: { type: 'string' },
        changed_paths: { type: 'array', items: { type: 'string' } },
        requested_decision: { type: 'string', enum: [...DECISIONS] },
        handoff_to: { type: 'string', description: 'dot_id to hand this work to.' },
        priority: { type: 'string', enum: [...PRIORITIES] },
        pipeline_ref: {
          type: 'string',
          description:
            'Repo-relative pipeline to run (pipeline work_shape; must be allowed by your charter).',
        },
        expected_effect: {
          type: 'object',
          description: 'The key result or signal this action should move, and in which direction.',
          properties: {
            kr_id: { type: 'string' },
            signal: { type: 'string' },
            direction: { type: 'string', enum: [...EFFECT_DIRECTIONS] },
          },
          required: ['direction'],
        },
        target: {
          type: 'string',
          description:
            'What the action touches: path:<glob>, service:<id>, pr:<owner>/<repo>#<n>, work_item:<id>, or org_operation:<id>.',
        },
        intent: { type: 'string', enum: [...DOT_PROPOSAL_INTENTS] },
      },
      required: ['title', 'objective', 'work_shape'],
    },
  };
}

function text(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim().slice(0, max);
}

function optionalText(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** Validate one untrusted proposal object; throws with a field-level reason. */
export function normalizeDotProposal(value: unknown): DotProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('proposal must be an object');
  }
  const raw = value as Record<string, unknown>;
  const workShape = raw.work_shape;
  if (!WORK_SHAPES.includes(workShape as DotWorkShape)) {
    throw new Error(`work_shape must be one of ${WORK_SHAPES.join(', ')}`);
  }
  const requested = raw.requested_decision;
  if (requested !== undefined && !DECISIONS.includes(requested as DotDecisionLevel)) {
    throw new Error(`requested_decision must be one of ${DECISIONS.join(', ')}`);
  }
  const handoffTo = optionalText(raw.handoff_to, 64);
  if (handoffTo !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(handoffTo)) {
    throw new Error(`handoff_to '${handoffTo}' is not a dot_id`);
  }
  const priority = raw.priority;
  if (priority !== undefined && !PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) {
    throw new Error(`priority must be one of ${PRIORITIES.join(', ')}`);
  }
  const pipelineRef = optionalText(raw.pipeline_ref, 300);
  // expected_effect / target / intent are advisory metadata (outcome
  // measurement, arbitration). A malformed value is dropped rather than
  // discarding the whole proposal — the work itself is still valid.
  let expectedEffect: DotExpectedEffect | undefined;
  const effect = raw.expected_effect as Record<string, unknown> | null | undefined;
  if (
    effect &&
    typeof effect === 'object' &&
    !Array.isArray(effect) &&
    EFFECT_DIRECTIONS.includes(effect.direction as (typeof EFFECT_DIRECTIONS)[number])
  ) {
    const krId = optionalText(effect.kr_id, 64);
    const signal = optionalText(effect.signal, 300);
    if (krId || signal) {
      expectedEffect = {
        ...(krId ? { kr_id: krId } : {}),
        ...(signal ? { signal } : {}),
        direction: effect.direction as DotExpectedEffect['direction'],
      };
    }
  }
  const rawTarget = optionalText(raw.target, 300);
  const target = rawTarget !== undefined && TARGET_PATTERN.test(rawTarget) ? rawTarget : undefined;
  const intent = DOT_PROPOSAL_INTENTS.includes(raw.intent as DotProposalIntent)
    ? (raw.intent as DotProposalIntent)
    : undefined;
  const changedPaths = Array.isArray(raw.changed_paths)
    ? raw.changed_paths
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
        .slice(0, 100)
    : undefined;
  return {
    action_id: handoffTo ? DOT_HANDOFF_ACTION_ID : DEFAULT_DOT_ACTION_ID,
    title: text(raw.title, 'title', 200),
    objective: text(raw.objective, 'objective'),
    work_shape: workShape as DotWorkShape,
    ...(optionalText(raw.rationale) ? { rationale: optionalText(raw.rationale) } : {}),
    ...(changedPaths?.length ? { changed_paths: changedPaths } : {}),
    ...(requested ? { requested_decision: requested as DotDecisionLevel } : {}),
    ...(handoffTo ? { handoff_to: handoffTo } : {}),
    ...(priority ? { priority: priority as DotProposal['priority'] } : {}),
    ...(pipelineRef ? { pipeline_ref: pipelineRef } : {}),
    ...(expectedEffect ? { expected_effect: expectedEffect } : {}),
    ...(target ? { target } : {}),
    ...(intent ? { intent } : {}),
  };
}

export interface ParsedDotProposals {
  proposals: DotProposal[];
  errors: string[];
}

/** Collect proposals from untrusted values, bounded to MAX_DOT_PROPOSALS_PER_WAKE. */
export function collectDotProposals(values: readonly unknown[]): ParsedDotProposals {
  const proposals: DotProposal[] = [];
  const errors: string[] = [];
  values.forEach((value, index) => {
    if (proposals.length >= MAX_DOT_PROPOSALS_PER_WAKE) {
      errors.push(`proposal ${index}: dropped (more than ${MAX_DOT_PROPOSALS_PER_WAKE} per wake)`);
      return;
    }
    try {
      proposals.push(normalizeDotProposal(value));
    } catch (error) {
      errors.push(`proposal ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { proposals, errors };
}

const FENCE_PATTERN = new RegExp('```' + DOT_PROPOSALS_FENCE + '\\s*\\n([\\s\\S]*?)```', 'g');

/** Parse every ```dot-proposals``` fenced JSON array in a delegated reply. */
export function parseDotProposalsFromText(reply: string): ParsedDotProposals {
  const values: unknown[] = [];
  const errors: string[] = [];
  for (const match of reply.matchAll(FENCE_PATTERN)) {
    try {
      const parsed: unknown = JSON.parse(match[1]);
      if (Array.isArray(parsed)) values.push(...parsed);
      else values.push(parsed);
    } catch (error) {
      errors.push(`fence: invalid JSON (${error instanceof Error ? error.message : error})`);
    }
  }
  const collected = collectDotProposals(values);
  return { proposals: collected.proposals, errors: [...errors, ...collected.errors] };
}

/** Prompt section telling the dot how to propose (shape depends on the backend). */
export function dotProposalInstructions(mode: 'tool' | 'fence'): string {
  const how =
    mode === 'tool'
      ? `Call the ${DOT_PROPOSE_TOOL_NAME} tool once per action you want taken.`
      : `End your reply with a fenced block \`\`\`${DOT_PROPOSALS_FENCE}\n[{"title": "...", "objective": "...", "work_shape": "task_session"}]\n\`\`\` listing every action you want taken (an empty array when none).`;
  return [
    'You do not act directly. Every action is a proposal that the runtime governs:',
    'it is scored by the autonomous-ops gate, raised to your charter decision floor, and then',
    'delegated as a WorkItem, sent to the operator for a decision, or refused.',
    how,
    'Use handoff_to to give work to another dot that accepts your handoffs.',
    'For pipeline work set pipeline_ref (it must be one your charter allows). Set expected_effect (kr_id or signal, direction) so the outcome is measured, and target + intent so conflicting proposals from other dots are arbitrated.',
  ].join('\n');
}
