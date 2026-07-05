import { randomUUID } from 'node:crypto';
import {
  appendGovernedArtifactJsonl,
  ensureGovernedArtifactDir,
  listGovernedArtifacts,
  readGovernedArtifactJson,
  writeGovernedArtifactJson,
} from '@agent/core';
import {
  loadArtifactRecord,
  saveArtifactRecord,
  type ArtifactRecord,
} from '@agent/core/artifact-record';
import type { GovernedArtifactRole } from '@agent/core';

const REVIEW_DIR = 'active/shared/coordination/deliverable-reviews';
const REVIEW_LOG = `${REVIEW_DIR}/reviews.jsonl`;

export type DeliverableVerdict = 'accept' | 'reject' | 'request-changes';

export interface DeliverableReviewEntry {
  review_id: string;
  artifact_id: string;
  version: number;
  verdict: DeliverableVerdict;
  comment?: string;
  reviewer: string;
  reviewed_at: string;
  new_artifact_id?: string;
}

export interface DeliverableReviewState {
  artifact_id: string;
  current_artifact_id: string;
  latest_version: number;
  latest_review_sequence: number;
  latest_artifact_version: number;
  reviews: DeliverableReviewEntry[];
  version_artifact_ids: string[];
}

export interface DeliverableReviewInput {
  artifactId: string;
  verdict: DeliverableVerdict;
  comment?: string;
  reviewer: string;
  reviewRole?: GovernedArtifactRole;
}

function reviewStatePath(artifactId: string): string {
  return `${REVIEW_DIR}/${resolveReviewRootArtifactId(artifactId)}.json`;
}

function resolveReviewRootArtifactId(artifactId: string): string {
  const visited = new Set<string>();
  let current = artifactId;

  while (!visited.has(current)) {
    visited.add(current);
    const artifact = loadArtifactRecord(current);
    const parent = artifact?.metadata?.review_parent_artifact_id;
    if (typeof parent !== 'string' || !parent.trim()) {
      return current;
    }
    current = parent.trim();
  }

  return current;
}

function readReviewState(artifactId: string): DeliverableReviewState | null {
  return readGovernedArtifactJson<DeliverableReviewState>(reviewStatePath(artifactId));
}

function writeReviewState(role: GovernedArtifactRole, state: DeliverableReviewState): void {
  ensureGovernedArtifactDir(role, REVIEW_DIR);
  writeGovernedArtifactJson(role, reviewStatePath(state.artifact_id), state);
}

function ensureReviewState(artifactId: string): DeliverableReviewState {
  const existing = readReviewState(artifactId);
  if (existing) return existing;
  return {
    artifact_id: artifactId,
    current_artifact_id: artifactId,
    latest_version: 1,
    latest_review_sequence: 1,
    latest_artifact_version: 1,
    reviews: [],
    version_artifact_ids: [artifactId],
  };
}

export function loadDeliverableReviewState(artifactId: string): DeliverableReviewState | null {
  return readReviewState(artifactId);
}

export function listDeliverableReviewStates(): DeliverableReviewState[] {
  if (!listGovernedArtifacts(REVIEW_DIR).length) return [];
  return listGovernedArtifacts(REVIEW_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => readReviewState(entry.replace(/\.json$/, '')))
    .filter((state): state is DeliverableReviewState => Boolean(state));
}

export function reviewDeliverable(input: DeliverableReviewInput): {
  review: DeliverableReviewEntry;
  state: DeliverableReviewState;
  artifact: ArtifactRecord | null;
} {
  const artifact = loadArtifactRecord(input.artifactId);
  if (!artifact) {
    throw new Error(`Deliverable not found: ${input.artifactId}`);
  }

  const role = input.reviewRole || 'mission_controller';
  const state = ensureReviewState(input.artifactId);
  const reviewSequence = state.latest_review_sequence + 1;
  const review: DeliverableReviewEntry = {
    review_id: randomUUID(),
    artifact_id: input.artifactId,
    version: reviewSequence,
    verdict: input.verdict,
    comment: input.comment,
    reviewer: input.reviewer,
    reviewed_at: new Date().toISOString(),
  };

  if (input.verdict === 'request-changes') {
    const nextArtifactVersion = state.latest_artifact_version + 1;
    const nextArtifactId = `${input.artifactId}-v${nextArtifactVersion}`;
    const nextArtifact: ArtifactRecord = {
      ...artifact,
      artifact_id: nextArtifactId,
      metadata: {
        ...(artifact.metadata || {}),
        review_parent_artifact_id: input.artifactId,
        review_version: reviewSequence,
        review_artifact_version: nextArtifactVersion,
        review_verdict: input.verdict,
        review_comment: input.comment,
      },
    };
    saveArtifactRecord(nextArtifact);
    review.new_artifact_id = nextArtifactId;
    state.current_artifact_id = nextArtifactId;
    state.latest_artifact_version = nextArtifactVersion;
    state.version_artifact_ids.push(nextArtifactId);
  } else if (input.verdict === 'accept') {
    state.current_artifact_id = input.artifactId;
  }

  state.latest_review_sequence = reviewSequence;
  state.latest_version = reviewSequence;
  state.reviews.push(review);
  writeReviewState(role, state);
  appendGovernedArtifactJsonl(role, REVIEW_LOG, review);

  return { review, state, artifact };
}
