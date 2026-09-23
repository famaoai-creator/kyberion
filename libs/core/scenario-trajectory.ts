/**
 * ES-07: scenario trajectory export (`kyberion-scenario-trajectory.v1`).
 *
 * Turns the side-effect log and the trace of one scenario run into ordered
 * steps (one per op invocation) with the reasoning calls made during that
 * step. Only digests and lengths leave the run: params and trace attributes
 * are redacted first (`redactSensitiveObject`, `sanitizeTraceForPersistence`)
 * and then hashed, so no prompt, response, param value or error text is ever
 * written into a trajectory record.
 */

import * as crypto from 'node:crypto';
import { redactSensitiveObject } from './network.js';
import type { ScenarioApprovalDecision } from './scenario-definition.js';
import type { ScenarioEvidenceClass } from './scenario-evidence-class.js';
import type {
  ScenarioApprovalRecord,
  ScenarioOpRecord,
  ScenarioSideEffectLog,
} from './scenario-side-effect-log.js';
import type { Trace, TraceSpan } from './src/trace.js';
import { sanitizeTraceForPersistence } from './trace-schema.js';

export const SCENARIO_TRAJECTORY_SCHEMA_VERSION = 'kyberion-scenario-trajectory.v1';

export type TrajectoryStepOutcome = 'ok' | 'error' | 'unstubbed' | 'held' | 'passthrough';

export interface TrajectoryReasoningCall {
  backend: string;
  prompt_hash: string;
  prompt_len: number;
  output_hash: string | null;
  output_len: number | null;
  outcome: string;
}

export interface TrajectoryApproval {
  channel: ScenarioApprovalRecord['channel'];
  decision: ScenarioApprovalDecision;
}

export interface TrajectoryStep {
  index: number;
  /** Op id, or null for reasoning calls made outside any op step. */
  op: string | null;
  outcome: TrajectoryStepOutcome | null;
  observation_digest: string;
  reasoning_calls: TrajectoryReasoningCall[];
  approval: TrajectoryApproval | null;
}

export interface TrajectoryRecord {
  schema_version: typeof SCENARIO_TRAJECTORY_SCHEMA_VERSION;
  scenario_id: string;
  run_id: string;
  evidence_class: ScenarioEvidenceClass;
  steps: TrajectoryStep[];
}

export interface TrajectoryMeta {
  scenarioId: string;
  runId: string;
  evidenceClass: ScenarioEvidenceClass;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function flattenSpans(span: TraceSpan, out: TraceSpan[] = []): TraceSpan[] {
  out.push(span);
  for (const child of span.children) flattenSpans(child, out);
  return out;
}

interface StepDraft {
  startSeq: number;
  op: string | null;
  records: ScenarioOpRecord[];
}

function heldForApproval(record: ScenarioOpRecord): boolean {
  return record.requiresApproval === true && record.approvalGranted !== true;
}

/**
 * Group op records into invocations. A `pipeline`-source preflight (or an
 * orphan apply/unstubbed) opens one; an admission-level (`actuator`)
 * preflight only opens one when it is held for approval, since a held op
 * never reaches leaf dispatch — a later, still-held pipeline preflight joins that step.
 */
function groupInvocations(log: ScenarioSideEffectLog): StepDraft[] {
  const drafts: StepDraft[] = [];
  const open = new Map<string, StepDraft>();
  for (const record of log.ops) {
    const current = open.get(record.op);
    if (record.stage === 'preflight' && record.source !== 'pipeline') {
      if (!heldForApproval(record)) continue;
      const draft: StepDraft = { startSeq: record.seq, op: record.op, records: [record] };
      drafts.push(draft);
      open.set(record.op, draft);
      continue;
    }
    const heldOnly =
      current?.records.length === 1 &&
      current.records[0]!.source !== 'pipeline' &&
      heldForApproval(current.records[0]!);
    if (record.stage === 'preflight' && current && heldOnly && heldForApproval(record)) {
      current.records.push(record);
      continue;
    }
    if (record.stage === 'preflight' || !current) {
      const draft: StepDraft = { startSeq: record.seq, op: record.op, records: [record] };
      drafts.push(draft);
      open.set(record.op, draft);
      if (record.stage !== 'preflight') open.delete(record.op);
      continue;
    }
    current.records.push(record);
    open.delete(record.op);
  }
  return drafts.sort((a, b) => a.startSeq - b.startSeq);
}

function outcomeOf(records: readonly ScenarioOpRecord[]): TrajectoryStepOutcome {
  const last = records[records.length - 1]!;
  if (last.stage === 'unstubbed') return 'unstubbed';
  if (last.stage === 'apply') return last.outcome === 'error' ? 'error' : 'ok';
  if (last.requiresApproval && !last.approvalGranted) return 'held';
  return 'passthrough';
}

function spanDigestSource(span: TraceSpan | undefined): unknown {
  if (!span) return null;
  return {
    name: span.name,
    status: span.status,
    attributes: span.attributes ?? {},
    events: span.events.map((event) => ({ name: event.name, attributes: event.attributes ?? {} })),
  };
}

export function exportTrajectory(
  trace: Trace | undefined,
  log: ScenarioSideEffectLog,
  meta: TrajectoryMeta
): TrajectoryRecord {
  const spans = trace ? flattenSpans(sanitizeTraceForPersistence(trace).rootSpan) : [];
  const spanCursor = new Map<string, number>();
  const nextSpanFor = (op: string): TraceSpan | undefined => {
    const matching = spans.filter((span) => span.name === op);
    const position = spanCursor.get(op) ?? 0;
    spanCursor.set(op, position + 1);
    return matching[position];
  };

  const drafts = groupInvocations(log);
  const firstSeq = drafts[0]?.startSeq ?? Number.POSITIVE_INFINITY;
  if (log.reasoning.some((record) => record.seq < firstSeq)) {
    drafts.unshift({ startSeq: 0, op: null, records: [] });
  }

  const steps = drafts.map((draft, index): TrajectoryStep => {
    const endSeq = drafts[index + 1]?.startSeq ?? Number.POSITIVE_INFINITY;
    const inStep = (seq: number) => seq >= draft.startSeq && seq < endSeq;
    const reasoningCalls = log.reasoning
      .filter((record) => inStep(record.seq))
      .map((record) => ({
        backend: record.backend,
        prompt_hash: record.prompt_hash,
        prompt_len: record.prompt_length,
        output_hash: record.response_hash ?? null,
        output_len: record.response_length ?? null,
        outcome: record.outcome,
      }));
    const approvalRecord = draft.op
      ? log.approvals
          .filter(
            (record) => record.op === draft.op && record.kind === 'requested' && inStep(record.seq)
          )
          .at(-1)
      : undefined;
    const params = draft.records.find((record) => record.params)?.params ?? {};
    const observation = {
      op: draft.op,
      params: redactSensitiveObject(params),
      span: draft.op ? spanDigestSource(nextSpanFor(draft.op)) : null,
    };
    return {
      index,
      op: draft.op,
      outcome: draft.records.length > 0 ? outcomeOf(draft.records) : null,
      observation_digest: sha256(JSON.stringify(observation)),
      reasoning_calls: reasoningCalls,
      approval: approvalRecord
        ? { channel: approvalRecord.channel, decision: approvalRecord.decision }
        : null,
    };
  });

  return {
    schema_version: SCENARIO_TRAJECTORY_SCHEMA_VERSION,
    scenario_id: meta.scenarioId,
    run_id: meta.runId,
    evidence_class: meta.evidenceClass,
    steps,
  };
}
