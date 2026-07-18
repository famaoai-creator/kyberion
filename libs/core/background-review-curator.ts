/**
 * HA-01 archive-only curator for background-review output.
 *
 * The curator is deterministic and never asks a model to decide what to
 * delete. It only archives stale proposal records that carry the exact
 * background-review provenance marker. Bundled, manually authored, promoted,
 * and otherwise unprovenanced records are protected by default.
 */

import { assertBackgroundReviewOperationAllowed } from './background-review-policy.js';
import {
  listDistillCandidateRecords,
  updateDistillCandidateRecord,
  type DistillCandidateRecord,
} from './distill-candidate-registry.js';

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const BACKGROUND_REVIEW_ORIGIN = 'background_review_fork';
const BACKGROUND_REVIEW_GENERATOR = 'background-review-fork';

export interface BackgroundReviewCuratorInput {
  now?: Date;
  maxAgeMs?: number;
  limit?: number;
  dryRun?: boolean;
}

export interface BackgroundReviewCuratorResult {
  scanned: number;
  eligible: number;
  archived: string[];
  would_archive: string[];
  protected_records: string[];
  skipped_fresh: string[];
  skipped_invalid_timestamp: string[];
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function isBackgroundReviewProposal(record: DistillCandidateRecord): boolean {
  const metadata = record.metadata;
  if (!metadata || metadata.origin !== BACKGROUND_REVIEW_ORIGIN) return false;
  const provenance = metadata.provenance;
  return Boolean(
    provenance &&
    typeof provenance === 'object' &&
    (provenance as Record<string, unknown>).generated_by === BACKGROUND_REVIEW_GENERATOR
  );
}

function timestampFor(record: DistillCandidateRecord): number {
  return Date.parse(String(record.updated_at || record.created_at || ''));
}

/**
 * Archive stale, agent-created proposals while preserving their record and
 * provenance. A later human/control-plane action can restore an archived
 * record by changing its status back to `proposed`.
 */
export function curateBackgroundReviewProposals(
  input: BackgroundReviewCuratorInput = {}
): BackgroundReviewCuratorResult {
  assertBackgroundReviewOperationAllowed('memory:archive');
  const now = input.now || new Date();
  const nowMs = now.getTime();
  const maxAgeMs = positiveInteger(input.maxAgeMs, DEFAULT_MAX_AGE_MS);
  const limit = positiveInteger(input.limit, DEFAULT_LIMIT);
  const records = listDistillCandidateRecords();
  const result: BackgroundReviewCuratorResult = {
    scanned: records.length,
    eligible: 0,
    archived: [],
    would_archive: [],
    protected_records: [],
    skipped_fresh: [],
    skipped_invalid_timestamp: [],
  };

  for (const record of records) {
    if (record.status !== 'proposed' || !isBackgroundReviewProposal(record)) {
      result.protected_records.push(record.candidate_id);
      continue;
    }
    result.eligible += 1;
    if (result.would_archive.length >= limit) continue;
    const timestamp = timestampFor(record);
    if (!Number.isFinite(timestamp)) {
      result.skipped_invalid_timestamp.push(record.candidate_id);
      continue;
    }
    if (nowMs - timestamp < maxAgeMs) {
      result.skipped_fresh.push(record.candidate_id);
      continue;
    }

    result.would_archive.push(record.candidate_id);
    if (input.dryRun) continue;

    const updated = updateDistillCandidateRecord(record.candidate_id, {
      status: 'archived',
      metadata: {
        ...(record.metadata || {}),
        archive: {
          archived_at: now.toISOString(),
          previous_status: record.status,
          reason: 'background-review curator stale proposal retention',
          reversible: true,
        },
      },
    });
    if (updated?.status === 'archived') result.archived.push(record.candidate_id);
  }

  return result;
}
