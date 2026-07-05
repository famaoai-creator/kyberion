import {
  appendGovernedArtifactJsonl,
  ensureGovernedArtifactDir,
  listGovernedArtifacts,
  readGovernedArtifactJson,
  writeGovernedArtifactJson,
} from '@agent/core';
import type { GovernedArtifactRole } from '@agent/core';
import {
  listServiceBindingRecords,
  type ServiceBindingRecord,
} from '@agent/core/service-binding-registry';

const REVIEW_DIR = 'active/shared/coordination/connection-reviews';
const REVIEW_LOG = `${REVIEW_DIR}/reviews.jsonl`;

export type ConnectionReviewAction = 'approve' | 'hold' | 'delete' | 'modify';

export interface ConnectionReviewEntry {
  review_id: string;
  binding_id: string;
  service_id?: string;
  action: ConnectionReviewAction;
  note?: string;
  reviewer: string;
  reviewed_at: string;
}

export interface ConnectionReviewState {
  binding_id: string;
  latest_action?: ConnectionReviewAction;
  latest_note?: string;
  reviewed_at?: string;
  reviews: ConnectionReviewEntry[];
}

function reviewStatePath(bindingId: string): string {
  return `${REVIEW_DIR}/${bindingId}.json`;
}

function readReviewState(bindingId: string): ConnectionReviewState | null {
  return readGovernedArtifactJson<ConnectionReviewState>(reviewStatePath(bindingId));
}

function writeReviewState(role: GovernedArtifactRole, state: ConnectionReviewState): void {
  ensureGovernedArtifactDir(role, REVIEW_DIR);
  writeGovernedArtifactJson(role, reviewStatePath(state.binding_id), state);
}

export function listConnectionReviewStates(): ConnectionReviewState[] {
  if (!listGovernedArtifacts(REVIEW_DIR).length) return [];
  return listGovernedArtifacts(REVIEW_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => readReviewState(entry.replace(/\.json$/, '')))
    .filter((state): state is ConnectionReviewState => Boolean(state));
}

export interface ConnectionReviewItem extends ServiceBindingRecord {
  reviewAction?: ConnectionReviewAction;
  reviewNote?: string;
  reviewedAt?: string;
}

export function listConnectionReviewItems(): ConnectionReviewItem[] {
  const reviewByBinding = new Map(
    listConnectionReviewStates().map((state) => [state.binding_id, state])
  );
  return listServiceBindingRecords().map((binding) => {
    const review = reviewByBinding.get(binding.binding_id);
    return {
      ...binding,
      reviewAction: review?.latest_action,
      reviewNote: review?.latest_note,
      reviewedAt: review?.reviewed_at,
    };
  });
}

export function recordConnectionReview(input: {
  bindingId: string;
  action: ConnectionReviewAction;
  note?: string;
  reviewer: string;
  reviewRole?: GovernedArtifactRole;
}): ConnectionReviewEntry {
  const binding = listServiceBindingRecords().find(
    (record) => record.binding_id === input.bindingId
  );
  if (!binding) {
    throw new Error(`Service binding not found: ${input.bindingId}`);
  }

  const role = input.reviewRole || 'mission_controller';
  const state = readReviewState(input.bindingId) || {
    binding_id: input.bindingId,
    reviews: [],
  };
  const entry: ConnectionReviewEntry = {
    review_id: `${input.bindingId}-${Date.now().toString(36)}`,
    binding_id: input.bindingId,
    service_id: binding.service_id,
    action: input.action,
    note: input.note,
    reviewer: input.reviewer,
    reviewed_at: new Date().toISOString(),
  };
  state.latest_action = input.action;
  state.latest_note = input.note;
  state.reviewed_at = entry.reviewed_at;
  state.reviews.push(entry);
  writeReviewState(role, state);
  appendGovernedArtifactJsonl(role, REVIEW_LOG, entry);
  return entry;
}
