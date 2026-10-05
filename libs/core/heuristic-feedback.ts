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
import { pathResolver, rootResolve } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { clamp } from './foundation/text.js';
import { nowIso } from './foundation/time.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeReaddir,
  safeWriteFile,
} from './secure-io.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  type MemoryCandidate,
} from './knowledge/memory-promotion-queue.js';

const HEURISTICS_ROOT = 'knowledge/confidential/heuristics';

// Resolved on use, not at import: importing this module (the mission retrospective
// does) must not touch the filesystem or fail where the knowledge root is not mounted.
function heuristicSchemaPath(): string {
  return assertSafeRepositoryPath(
    pathResolver.knowledge('product/schemas/heuristic-entry.schema.json')
  );
}

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
  const normalized = String(entryId || '').trim();
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/]/u.test(normalized)) {
    throw new Error(`[heuristic-feedback] illegal entry id: ${entryId}`);
  }
  return assertSafeRepositoryPath(rootResolve(path.join(HEURISTICS_ROOT, `${normalized}.json`)), {
    allowMissingLeaf: true,
  });
}

function heuristicCatalog(filePath: string) {
  return defineCatalog<HeuristicEntry>({
    id: 'heuristic-entry',
    path: filePath,
    schema: heuristicSchemaPath(),
  });
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
    const bounded = clamp(outcome.metric_score, 0, 1);
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
  return heuristicCatalog(file).load();
}

export function listHeuristics(): HeuristicEntry[] {
  const dir = assertSafeRepositoryPath(rootResolve(HEURISTICS_ROOT), { allowMissingLeaf: true });
  if (!safeExistsSync(dir)) return [];
  const entries = safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/u, ''));
  return entries.flatMap((id) => {
    try {
      const entry = readHeuristic(id);
      return entry ? [entry] : [];
    } catch {
      return [];
    }
  });
}

export function writeHeuristicAtPath(filePath: string, entry: HeuristicEntry): HeuristicEntry {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const validated = heuristicCatalog(safePath).validate(entry, safePath);
  safeWriteFile(safePath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: 'utf8',
    mkdir: true,
  });
  return validated;
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
    validated_at: nowIso(),
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
  const filePath = heuristicFilePath(params.entryId);
  return writeHeuristicAtPath(filePath, updated);
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
            validated.length
        )
      : null;
  const recent = [...validated]
    .sort((a, b) =>
      (a.validation?.validated_at ?? '').localeCompare(b.validation?.validated_at ?? '')
    )
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

const SUCCESSFUL_ITEM_STATUSES = ['done', 'completed', 'accepted'];

/** A heuristic that scored at least this well is offered for ratification as durable memory. */
export const HEURISTIC_PROMOTION_THRESHOLD = 0.75;

/**
 * Derive a mission's outcome from its measured work items, deterministically:
 * every item done and no finish-gate failure is `success`, no item done is
 * `failure`, anything between is `partial`. A mission with no items has no
 * outcome to score against, so it returns null.
 */
export function deriveMissionOutcome(input: {
  missionId: string;
  itemStatuses: readonly string[];
  finishGateFailures: number;
  completedAt?: string;
}): MissionOutcome | null {
  if (input.itemStatuses.length === 0) return null;
  const done = input.itemStatuses.filter((status) =>
    SUCCESSFUL_ITEM_STATUSES.includes(String(status).toLowerCase())
  ).length;
  const result: MissionOutcome['result'] =
    done === input.itemStatuses.length && input.finishGateFailures === 0
      ? 'success'
      : done === 0
        ? 'failure'
        : 'partial';
  return {
    mission_id: input.missionId,
    completed_at: input.completedAt ?? nowIso(),
    result,
    metric_score: round(done / input.itemStatuses.length),
  };
}

export interface MissionHeuristicValidationResult {
  validated: string[];
  /** Subset of `validated` offered to the memory-promotion queue (ratification still required). */
  queued: string[];
  errors: string[];
}

/**
 * Close the heuristic "learn" loop for one finished mission: every captured
 * intuition that surfaced during it and has not been scored yet is stamped with
 * the mission's outcome, and the ones that held up are offered to the
 * memory-promotion queue, where a steward ratifies them before they can reach
 * a future worker. Already-validated entries are left alone, so a mission that
 * is finished twice does not restamp or re-queue anything.
 */
export function validateMissionHeuristics(
  outcome: MissionOutcome
): MissionHeuristicValidationResult {
  const result: MissionHeuristicValidationResult = { validated: [], queued: [], errors: [] };
  const missionId = outcome.mission_id.toUpperCase();
  for (const entry of listHeuristics()) {
    if (entry.validation || String(entry.mission_id ?? '').toUpperCase() !== missionId) continue;
    try {
      const validated = validateHeuristic({ entryId: entry.id, outcome });
      result.validated.push(entry.id);
      if ((validated.validation?.validity_score ?? 0) >= HEURISTIC_PROMOTION_THRESHOLD) {
        queueHeuristicMemoryCandidate({ entryId: entry.id });
        result.queued.push(entry.id);
      }
    } catch (error) {
      result.errors.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
