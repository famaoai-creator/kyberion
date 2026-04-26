/**
 * Heuristic Feedback Loop — correlate captured intuitions (heuristic-entry)
 * with subsequent mission outcomes to produce a validity score.
 *
 * Implements CONCEPT_INTEGRATION_BACKLOG P2-5. The loop is deliberately
 * non-blocking: it annotates existing heuristic entries in place with a
 * `validation` block rather than rewriting them. Closing the intent-loop
 * "learn" phase depends on this running periodically (via a retrospective
 * mission or scheduled task) so heuristics decay gracefully instead of
 * accumulating unchallenged.
 */

import * as path from 'node:path';
import { rootResolve } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeReaddir, safeWriteFile } from './secure-io.js';
import { createMemoryPromotionCandidate, enqueueMemoryPromotionCandidate, type MemoryCandidate } from './memory-promotion-queue.js';

const HEURISTICS_ROOT = 'knowledge/confidential/heuristics';

export interface HeuristicEntry {
  id: string;
  captured_at: string;
  mission_id?: string;
  decision: string;
  trigger?: string;
  anchor: string;
  vetoed_options?: string[];
  analogy: string;
  tags?: string[];
  outcome_ref?: string;
  validation?: HeuristicValidation;
  [k: string]: unknown;
}

export interface MissionOutcome {
  mission_id: string;
  completed_at: string;
  result: 'success' | 'partial' | 'failure';
  metric_score?: number;
  notes?: string;
}

export interface HeuristicValidation {
  validated_at: string;
  outcome_result: MissionOutcome['result'];
  validity_score: number;
  evidence_ref?: string;
  notes?: string;
}

export interface ValidateParams {
  entryId: string;
  outcome: MissionOutcome;
  evidenceRef?: string;
  notes?: string;
}

function heuristicFilePath(entryId: string): string {
  return rootResolve(path.join(HEURISTICS_ROOT, `${entryId}.json`));
}

/**
 * Map an outcome into a validity score in [0, 1]. Simple linear mapping
 * for the MVP: success=1.0, partial=0.5, failure=0.0. If the caller
 * supplies a metric_score (e.g. revenue captured vs forecast), it is
 * averaged in with equal weight so heuristics earn credit for getting
 * close on quantitative decisions.
 */
export function scoreValidity(outcome: MissionOutcome): number {
  const base = outcome.result === 'success' ? 1 : outcome.result === 'partial' ? 0.5 : 0;
  if (typeof outcome.metric_score === 'number' && !Number.isNaN(outcome.metric_score)) {
    const bounded = Math.max(0, Math.min(1, outcome.metric_score));
    return round((base + bounded) / 2);
  }
  return round(base);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function readHeuristic(entryId: string): HeuristicEntry | null {
  const file = heuristicFilePath(entryId);
  if (!safeExistsSync(file)) return null;
  return JSON.parse(safeReadFile(file, { encoding: 'utf8' }) as string) as HeuristicEntry;
}

export function listHeuristics(): HeuristicEntry[] {
  const dir = rootResolve(HEURISTICS_ROOT);
  if (!safeExistsSync(dir)) return [];
  const entries = safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/u, ''));
  return entries
    .map((id) => readHeuristic(id))
    .filter((entry): entry is HeuristicEntry => entry != null);
}

/**
 * Stamp a heuristic entry with its post-hoc validation. Idempotent:
 * re-validating an already-validated entry overwrites the validation
 * block (so periodic re-scoring is safe).
 */
export function validateHeuristic(params: ValidateParams): HeuristicEntry {
  const existing = readHeuristic(params.entryId);
  if (!existing) {
    throw new Error(`[heuristic-feedback] entry not found: ${params.entryId}`);
  }
  const validation: HeuristicValidation = {
    validated_at: new Date().toISOString(),
    outcome_result: params.outcome.result,
    validity_score: scoreValidity(params.outcome),
    ...(params.evidenceRef ? { evidence_ref: params.evidenceRef } : {}),
    ...(params.notes ? { notes: params.notes } : {}),
  };
  const updated: HeuristicEntry = {
    ...existing,
    outcome_ref: existing.outcome_ref ?? params.evidenceRef,
    validation,
  };
  safeWriteFile(heuristicFilePath(params.entryId), `${JSON.stringify(updated, null, 2)}\n`, {
    encoding: 'utf8',
    mkdir: true,
  });
  return updated;
}

export interface HeuristicReport {
  total: number;
  validated: number;
  unvalidated: number;
  average_validity: number | null;
  recent: HeuristicEntry[];
}

/**
 * Summarise validated heuristics. Used by the retrospective mission
 * phase to surface whether the Sovereign's intuition track record is
 * improving, stable, or drifting.
 */
export function summarizeHeuristics(limit = 5): HeuristicReport {
  const entries = listHeuristics();
  const validated = entries.filter((entry) => entry.validation);
  const unvalidated = entries.length - validated.length;
  const averageValidity =
    validated.length > 0
      ? round(
          validated.reduce((sum, entry) => sum + (entry.validation?.validity_score ?? 0), 0) /
            validated.length,
        )
      : null;
  const recent = [...validated]
    .sort((a, b) => (a.validation?.validated_at ?? '').localeCompare(b.validation?.validated_at ?? ''))
    .reverse()
    .slice(0, limit);
  return {
    total: entries.length,
    validated: validated.length,
    unvalidated,
    average_validity: averageValidity,
    recent,
  };
}

export function queueHeuristicMemoryCandidate(input: {
  entryId: string;
  sensitivityTier?: 'public' | 'confidential' | 'personal';
  evidenceRef?: string;
}): MemoryCandidate {
  const entry = readHeuristic(input.entryId);
  if (!entry) {
    throw new Error(`[heuristic-feedback] entry not found: ${input.entryId}`);
  }
  const evidenceRefs = [input.evidenceRef, entry.outcome_ref]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const candidate = createMemoryPromotionCandidate({
    sourceType: 'incident',
    sourceRef: `heuristic:${entry.id}`,
    proposedMemoryKind: 'heuristic',
    summary: entry.decision || entry.anchor,
    evidenceRefs,
    sensitivityTier: input.sensitivityTier || 'confidential',
    ratificationRequired: true,
  });
  enqueueMemoryPromotionCandidate(candidate);
  return candidate;
}
