/**
 * ES-02/ES-04: the side-effect log a scenario run collects. All arrays share
 * one monotonically increasing `seq`, so the trajectory writer and the final
 * checks can order ops, approvals, writes and reasoning calls exactly.
 * `warnings` (FU-01) are diagnostics about the run, never side effects.
 */

import type { OpPreflightCall } from './op-preflight.js';
import type { PipelineStepType } from './actuator-op-registry.js';
import type { ScenarioApprovalDecision } from './scenario-definition.js';

export interface ScenarioOpRecord {
  seq: number;
  op: string;
  /**
   * preflight: the op reached admission (recorded by the observe-only listener).
   * apply: a fixture served the op. unstubbed: the op failed closed.
   */
  stage: 'preflight' | 'apply' | 'unstubbed';
  /** preflight only: every listener and guard admitted the call. */
  admitted?: boolean;
  params?: Record<string, unknown>;
  source?: OpPreflightCall['source'];
  requiresApproval?: boolean;
  approvalGranted?: boolean;
  stepType?: PipelineStepType;
  outcome?: 'ok' | 'error';
  error?: string;
}

export interface ScenarioApprovalRecord {
  seq: number;
  op: string;
  /** requested: an op asked for approval. decided: the scenario changed the decision. */
  kind: 'requested' | 'decided';
  channel: 'pipeline' | 'risky-approval' | 'scenario';
  decision: ScenarioApprovalDecision;
  previous?: ScenarioApprovalDecision;
}

export interface ScenarioWriteRecord {
  seq: number;
  /** Relative to the run root, '/'-separated. */
  path: string;
  change: 'created' | 'modified' | 'deleted';
  sha256?: string;
  bytes?: number;
}

export interface ScenarioReasoningRecord {
  seq: number;
  method: string;
  backend: string;
  prompt_hash: string;
  prompt_length: number;
  outcome: 'fixture' | 'miss' | 'forbidden' | 'invalid';
  fixture_index?: number;
  response_hash?: string;
  response_length?: number;
}

/**
 * FU-01 scope_lost: while a simulated run was active, an op reached its seams
 * with no scenario scope at all. That is either unrelated host work or run
 * work that lost its async context (e.g. a callback from a pre-existing
 * emitter); it is not blocked, but the scenario author must see it.
 */
export interface ScenarioWarningRecord {
  seq: number;
  kind: 'scope_lost';
  op: string;
  /** Where the dispatch was observed (preflight source, or the op resolver); never a stack. */
  source: OpPreflightCall['source'] | 'op-dispatch';
}

export interface ScenarioSideEffectLog {
  ops: ScenarioOpRecord[];
  approvals: ScenarioApprovalRecord[];
  writes: ScenarioWriteRecord[];
  reasoning: ScenarioReasoningRecord[];
  warnings: ScenarioWarningRecord[];
}

type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> : never;

const seqCounters = new WeakMap<ScenarioSideEffectLog, number>();

export function createScenarioSideEffectLog(): ScenarioSideEffectLog {
  const log: ScenarioSideEffectLog = {
    ops: [],
    approvals: [],
    writes: [],
    reasoning: [],
    warnings: [],
  };
  seqCounters.set(log, 0);
  return log;
}

function nextSeq(log: ScenarioSideEffectLog): number {
  const next = (seqCounters.get(log) ?? 0) + 1;
  seqCounters.set(log, next);
  return next;
}

export function appendScenarioOp(
  log: ScenarioSideEffectLog,
  record: WithoutSeq<ScenarioOpRecord>
): ScenarioOpRecord {
  const entry = { seq: nextSeq(log), ...record };
  log.ops.push(entry);
  return entry;
}

export function appendScenarioApproval(
  log: ScenarioSideEffectLog,
  record: WithoutSeq<ScenarioApprovalRecord>
): ScenarioApprovalRecord {
  const entry = { seq: nextSeq(log), ...record };
  log.approvals.push(entry);
  return entry;
}

export function appendScenarioWrite(
  log: ScenarioSideEffectLog,
  record: WithoutSeq<ScenarioWriteRecord>
): ScenarioWriteRecord {
  const entry = { seq: nextSeq(log), ...record };
  log.writes.push(entry);
  return entry;
}

export function appendScenarioReasoning(
  log: ScenarioSideEffectLog,
  record: WithoutSeq<ScenarioReasoningRecord>
): ScenarioReasoningRecord {
  const entry = { seq: nextSeq(log), ...record };
  log.reasoning.push(entry);
  return entry;
}

export function appendScenarioWarning(
  log: ScenarioSideEffectLog,
  record: WithoutSeq<ScenarioWarningRecord>
): ScenarioWarningRecord {
  const entry = { seq: nextSeq(log), ...record };
  log.warnings.push(entry);
  return entry;
}
