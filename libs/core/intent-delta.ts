/**
 * Intent Delta — compute drift between mission intent snapshots.
 *
 * Implements the computation side of CONCEPT_INTEGRATION_BACKLOG P1-7
 * (Intent Delta instrumentation). Observation side (hooks that emit
 * snapshots at lifecycle transitions) lives in the worker.
 *
 * Drift classifications feed intent_drift_gate in the mission review
 * gate registry and are accumulated on the execution receipt as a
 * mission-quality indicator.
 */

import { randomUUID } from 'node:crypto';

export interface IntentBody {
  goal: string;
  constraints?: string[];
  deliverables?: string[];
  excluded?: string[];
  stakeholders?: string[];
}

export interface IntentSnapshot {
  snapshot_id: string;
  mission_id: string;
  stage: string;
  created_at: string;
  source: 'user_prompt' | 'mission_state' | 'gate_evaluation' | 'worker_transition' | 'manual';
  intent: IntentBody;
  trace_ref?: string;
}

export interface IntentDeltaChanges {
  goal_changed: boolean;
  goal_similarity: number;
  constraints_added?: string[];
  constraints_removed?: string[];
  deliverables_added?: string[];
  deliverables_removed?: string[];
  excluded_added?: string[];
  excluded_removed?: string[];
  stakeholders_added?: string[];
  stakeholders_removed?: string[];
}

export type DriftVerdict = 'none' | 'minor' | 'significant' | 'blocking';

export interface IntentDelta {
  delta_id: string;
  mission_id: string;
  from_snapshot: string;
  to_snapshot: string;
  computed_at: string;
  changes: IntentDeltaChanges;
  drift_score: number;
  drift_verdict: DriftVerdict;
  notes?: string;
}

export interface DriftThresholds {
  minor: number;
  significant: number;
  blocking: number;
}

export const DEFAULT_THRESHOLDS: DriftThresholds = {
  minor: 0.15,
  significant: 0.35,
  blocking: 0.6,
};

const TOKEN_SPLIT = /[\s,.;:!?()\[\]{}"'`\-—–/\\|]+/u;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(TOKEN_SPLIT)
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
  );
}

/** Jaccard similarity on tokenized strings. 1.0 when both strings are empty. */
export function goalSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  const intersection = new Set<string>();
  for (const token of ta) if (tb.has(token)) intersection.add(token);
  const union = new Set<string>([...ta, ...tb]);
  return intersection.size / union.size;
}

function arrayDiff(from: string[] = [], to: string[] = []): { added: string[]; removed: string[] } {
  const fromSet = new Set(from);
  const toSet = new Set(to);
  return {
    added: [...toSet].filter((x) => !fromSet.has(x)),
    removed: [...fromSet].filter((x) => !toSet.has(x)),
  };
}

export function computeIntentDelta(
  from: IntentSnapshot,
  to: IntentSnapshot,
  thresholds: DriftThresholds = DEFAULT_THRESHOLDS,
): IntentDelta {
  if (from.mission_id !== to.mission_id) {
    throw new Error(
      `[intent-delta] cross-mission comparison refused: ${from.mission_id} vs ${to.mission_id}`,
    );
  }

  const sim = goalSimilarity(from.intent.goal, to.intent.goal);
  const goalChanged = sim < 1;

  const constraints = arrayDiff(from.intent.constraints, to.intent.constraints);
  const deliverables = arrayDiff(from.intent.deliverables, to.intent.deliverables);
  const excluded = arrayDiff(from.intent.excluded, to.intent.excluded);
  const stakeholders = arrayDiff(from.intent.stakeholders, to.intent.stakeholders);

  const changes: IntentDeltaChanges = {
    goal_changed: goalChanged,
    goal_similarity: round(sim),
  };
  if (constraints.added.length) changes.constraints_added = constraints.added;
  if (constraints.removed.length) changes.constraints_removed = constraints.removed;
  if (deliverables.added.length) changes.deliverables_added = deliverables.added;
  if (deliverables.removed.length) changes.deliverables_removed = deliverables.removed;
  if (excluded.added.length) changes.excluded_added = excluded.added;
  if (excluded.removed.length) changes.excluded_removed = excluded.removed;
  if (stakeholders.added.length) changes.stakeholders_added = stakeholders.added;
  if (stakeholders.removed.length) changes.stakeholders_removed = stakeholders.removed;

  const goalDrift = 1 - sim;
  const fieldChurn = estimateFieldChurn(changes);
  // Goal carries the dominant weight (70%) because it is the single most
  // semantically loaded field; per-field churn contributes the rest so
  // that any single-field change still crosses the minor threshold.
  const driftScore = round(Math.min(1, goalDrift * 0.7 + fieldChurn * 0.3));

  return {
    delta_id: randomUUID(),
    mission_id: from.mission_id,
    from_snapshot: from.snapshot_id,
    to_snapshot: to.snapshot_id,
    computed_at: new Date().toISOString(),
    changes,
    drift_score: driftScore,
    drift_verdict: classifyDrift(driftScore, thresholds),
  };
}

function estimateFieldChurn(changes: IntentDeltaChanges): number {
  const fields: Array<keyof IntentDeltaChanges> = [
    'constraints_added',
    'constraints_removed',
    'deliverables_added',
    'deliverables_removed',
    'excluded_added',
    'excluded_removed',
    'stakeholders_added',
    'stakeholders_removed',
  ];
  let touched = 0;
  for (const field of fields) {
    const value = changes[field];
    if (Array.isArray(value) && value.length > 0) {
      touched += 1;
    }
  }
  // Each touched field contributes 0.5, capped at 1.0. Two touched
  // fields fully saturate churn so that a constraint swap registers
  // at or above the minor drift threshold.
  return Math.min(1, touched * 0.5);
}

export function classifyDrift(score: number, thresholds: DriftThresholds = DEFAULT_THRESHOLDS): DriftVerdict {
  if (score >= thresholds.blocking) return 'blocking';
  if (score >= thresholds.significant) return 'significant';
  if (score >= thresholds.minor) return 'minor';
  return 'none';
}

export function isBlockingDrift(delta: IntentDelta): boolean {
  return delta.drift_verdict === 'blocking';
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
