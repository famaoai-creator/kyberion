/**
 * D8 / MEMORY_LOOP_CLOSURE M2: HA-01 background-review patch proposals
 * (pipeline_proposal / skill_patch / memory_consolidation) are MemoryCandidate
 * queue rows (`kind: process_improvement`, `origin.record_kind:
 * background_review`, decided via `pnpm background-review`). Approve, apply,
 * rollback, pin and the curator's archive act on these rows.
 *
 * The legacy unscoped DistillCandidateRecords under
 * `active/shared/runtime/distill-candidates/` are read-only history; for one
 * release `migrateLegacyBackgroundReviewProposals` imports the pending ones
 * with the scope their mission state declares. Items whose scope cannot be
 * determined are reported, never guessed.
 */

import {
  captureFacadeProposal,
  LEGACY_DISTILL_CANDIDATE_STORE,
  listFacadeProposals,
  loadFacadeProposal,
  mutateFacadeProposal,
  updateFacadeProposal,
  withFacadeProposalLock,
  type CaptureFacadeProposalInput,
  type FacadeProposalPatch,
  type FacadeProposalRecord,
  type FacadeProposalSpec,
} from '../knowledge/facade-proposal-rows.js';
import {
  listDistillCandidateRecords,
  type DistillCandidateRecord,
} from '../knowledge/distill-candidate-registry.js';
import { missionMemoryCaptureScope } from '../knowledge/memory-capture-scope.js';
import type { MemoryScopeEnvelope } from '../knowledge/memory-scope.js';
import type { MemoryCandidateKind } from '../knowledge/memory-promotion-queue.js';

export const BACKGROUND_REVIEW_PROPOSAL: FacadeProposalSpec = {
  recordKind: 'background_review',
  learningKind: 'process_improvement',
  decidedVia: 'pnpm background-review',
  idPrefix: 'BRP',
};

export type BackgroundReviewProposalRecord = FacadeProposalRecord;
export type BackgroundReviewProposalAction =
  'pipeline_proposal' | 'skill_patch' | 'memory_consolidation';

/**
 * Capture scope of a fork: the mission's own tenant scope from its state for a
 * mission fork, the session owner for a session fork. Throws
 * `[MEMORY_SCOPE_REQUIRED]` when neither determines it.
 */
export function backgroundReviewCaptureScope(input: {
  missionId?: string;
  ownerNhi?: string;
}): MemoryScopeEnvelope {
  if (input.missionId) {
    const scope = missionMemoryCaptureScope(input.missionId).scope;
    if (scope?.tier === 'confidential') return scope;
    throw new Error(
      `[MEMORY_SCOPE_REQUIRED] mission ${input.missionId} has no confidential tenant scope in its state — background-review output is not captured`
    );
  }
  const ownerNhi = input.ownerNhi?.trim();
  if (ownerNhi) return { tier: 'personal', owner_nhi: ownerNhi };
  throw new Error(
    '[MEMORY_SCOPE_REQUIRED] session background review has no owner_nhi — background-review output is not captured'
  );
}

function proposedMemoryKindFor(action: unknown): MemoryCandidateKind {
  return action === 'memory_consolidation' ? 'heuristic' : 'sop';
}

export function captureBackgroundReviewProposal(
  input: Omit<CaptureFacadeProposalInput, 'proposedMemoryKind'>
): BackgroundReviewProposalRecord {
  return captureFacadeProposal(BACKGROUND_REVIEW_PROPOSAL, {
    ...input,
    proposedMemoryKind: proposedMemoryKindFor(input.metadata?.action),
  });
}

export function listBackgroundReviewProposals(
  scope?: MemoryScopeEnvelope
): BackgroundReviewProposalRecord[] {
  return listFacadeProposals(BACKGROUND_REVIEW_PROPOSAL, scope);
}

function isLegacyBackgroundReviewRecord(record: DistillCandidateRecord): boolean {
  return record.metadata?.origin === 'background_review_fork';
}

/** Load a proposal row; a legacy-only id fails with the migration hint. */
export function loadBackgroundReviewProposal(
  candidateId: string,
  scope?: MemoryScopeEnvelope
): BackgroundReviewProposalRecord | null {
  const row = loadFacadeProposal(BACKGROUND_REVIEW_PROPOSAL, candidateId, scope);
  if (row) return row;
  if (
    !scope &&
    listDistillCandidateRecords().some(
      (record) => record.candidate_id === candidateId && isLegacyBackgroundReviewRecord(record)
    )
  )
    throw new Error(
      `[BACKGROUND_REVIEW_NOT_ON_QUEUE] ${candidateId} is only in the read-only legacy distill-candidate store | next: pnpm background-review migrate --apply, then retry`
    );
  return null;
}

export function updateBackgroundReviewProposal(
  candidateId: string,
  patch: FacadeProposalPatch,
  scope?: MemoryScopeEnvelope
): BackgroundReviewProposalRecord | null {
  return updateFacadeProposal(BACKGROUND_REVIEW_PROPOSAL, candidateId, patch, { scope });
}

export function mutateBackgroundReviewProposal(
  candidateId: string,
  mutate: (current: BackgroundReviewProposalRecord) => FacadeProposalPatch | null,
  scope?: MemoryScopeEnvelope
): BackgroundReviewProposalRecord | null {
  return mutateFacadeProposal(BACKGROUND_REVIEW_PROPOSAL, candidateId, mutate, scope);
}

export function withBackgroundReviewProposalLock<T>(candidateId: string, action: () => T): T {
  return withFacadeProposalLock(BACKGROUND_REVIEW_PROPOSAL, candidateId, action);
}

export interface BackgroundReviewMigrationReport {
  mode: 'dry_run' | 'apply';
  imported: Array<{ candidate_id: string; status: string; tenant_slug?: string }>;
  already_on_queue: string[];
  /** Pending items whose scope cannot be determined — reported, never guessed. */
  unresolved: Array<{ candidate_id: string; reason: string }>;
  /** Archived / rolled-back records stay read-only history. */
  left_as_history: string[];
}

/** Applied patches that can still be rolled back are pending a decision too. */
function isPendingLegacyProposal(record: DistillCandidateRecord): boolean {
  if (record.status === 'proposed') return true;
  if (record.status !== 'promoted') return false;
  const application = record.metadata?.patch_application as Record<string, unknown> | undefined;
  return Boolean(application && !application.rollback);
}

/**
 * One-release migration: import pending legacy background-review records onto
 * the queue with the scope of the mission they came from. Idempotent.
 * Session-sourced legacy records carry no owner, so they stay unresolved.
 */
export function migrateLegacyBackgroundReviewProposals(
  options: { apply?: boolean } = {}
): BackgroundReviewMigrationReport {
  const report: BackgroundReviewMigrationReport = {
    mode: options.apply ? 'apply' : 'dry_run',
    imported: [],
    already_on_queue: [],
    unresolved: [],
    left_as_history: [],
  };
  const onQueue = new Set(listBackgroundReviewProposals().map((row) => row.candidate_id));
  for (const record of listDistillCandidateRecords()) {
    if (!isLegacyBackgroundReviewRecord(record) || record.scope) continue;
    if (!isPendingLegacyProposal(record)) {
      report.left_as_history.push(record.candidate_id);
      continue;
    }
    if (onQueue.has(record.candidate_id)) {
      report.already_on_queue.push(record.candidate_id);
      continue;
    }
    let scope: MemoryScopeEnvelope;
    try {
      if (!record.mission_id)
        throw new Error(
          '[MEMORY_SCOPE_REQUIRED] session-sourced legacy proposal names no owner_nhi'
        );
      scope = backgroundReviewCaptureScope({ missionId: record.mission_id });
    } catch (err) {
      report.unresolved.push({
        candidate_id: record.candidate_id,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (options.apply)
      captureBackgroundReviewProposal({
        candidate_id: record.candidate_id,
        created_at: record.created_at,
        status: record.status === 'promoted' ? 'promoted' : 'proposed',
        source_type: record.source_type,
        ...(record.mission_id ? { mission_id: record.mission_id } : {}),
        ...(record.task_session_id ? { task_session_id: record.task_session_id } : {}),
        title: record.title,
        summary: record.summary,
        target_kind: record.target_kind,
        ...(record.promoted_ref ? { promoted_ref: record.promoted_ref } : {}),
        evidence_refs: record.evidence_refs?.length
          ? record.evidence_refs
          : [`distill-candidate:${record.candidate_id}`],
        metadata: record.metadata || {},
        scope,
        migratedFrom: LEGACY_DISTILL_CANDIDATE_STORE,
      });
    report.imported.push({
      candidate_id: record.candidate_id,
      status: record.status,
      ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
    });
  }
  return report;
}
