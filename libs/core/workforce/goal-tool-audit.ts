/**
 * Goal-loop tool-call audit — one audit-chain record per tool call the goal
 * driver handles, whichever backend proposed it.
 *
 * Tool loops are approved on the condition that every tool used is recorded
 * and auditable. The record names who (actor), where (goal, mission, turn),
 * what (tool name, input digest), how it ended (ok / error / refused) and which
 * provider proposed it. The raw input is never written — it may hold
 * sensitive data — only a sha256 digest of its canonical JSON, which a
 * reviewer holding the input can recompute.
 */

import { createHash } from 'node:crypto';
import { auditChain, type AuditEntry } from '../governance/audit-chain.js';

export const GOAL_TOOL_CALL_AUDIT_ACTION = 'goal_tool_call';

export type GoalToolCallStatus = 'ok' | 'error' | 'refused';

export interface GoalToolCallAuditInput {
  actorId: string;
  goalId: string;
  missionId?: string;
  turn: number;
  toolName: string;
  input: unknown;
  status: GoalToolCallStatus;
  /** Backend / provider label that proposed the call. */
  backend: string;
  /** Short machine-readable reason for `error` / `refused`. */
  reason?: string;
}

export type GoalToolCallAuditEntry = Omit<
  AuditEntry,
  'id' | 'timestamp' | 'previousHash' | 'currentHash'
>;

export type GoalToolCallAuditSink = (entry: GoalToolCallAuditEntry) => void;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/** `sha256:<hex>` of the input's canonical (key-sorted) JSON. */
export function digestToolInput(input: unknown): string {
  const canonical = JSON.stringify(sortKeys(input ?? {})) ?? 'null';
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

const STATUS_TO_RESULT: Record<GoalToolCallStatus, AuditEntry['result']> = {
  ok: 'completed',
  error: 'error',
  refused: 'denied',
};

export function buildGoalToolCallAuditEntry(input: GoalToolCallAuditInput): GoalToolCallAuditEntry {
  return {
    agentId: input.actorId,
    action: GOAL_TOOL_CALL_AUDIT_ACTION,
    operation: input.toolName,
    result: STATUS_TO_RESULT[input.status],
    ...(input.reason ? { reason: input.reason } : {}),
    metadata: {
      goal_id: input.goalId,
      ...(input.missionId ? { mission_id: input.missionId } : {}),
      turn: input.turn,
      tool: input.toolName,
      input_digest: digestToolInput(input.input),
      status: input.status,
      backend: input.backend,
    },
  };
}

/** Default sink: the process audit chain. Failures propagate (fail-closed). */
export const recordGoalToolCallToAuditChain: GoalToolCallAuditSink = (entry) => {
  auditChain.record(entry);
};
