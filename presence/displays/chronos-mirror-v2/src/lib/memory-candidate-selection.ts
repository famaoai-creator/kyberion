import {
  listMemoryPromotionCandidates,
  memoryPromotionCandidateKey,
  type MemoryCandidate,
} from '@agent/core/knowledge/memory-promotion-queue';
import { memoryCandidateVisibleToViewer } from './knowledge-scope';
import type { ViewerContext } from './viewer-context';

/** An opaque selector, not an authorization token. Visibility is always rechecked. */
export const memoryCandidateKey = memoryPromotionCandidateKey;

export class MemoryCandidateAmbiguityError extends Error {}

export function resolveMemoryCandidateForViewer(input: {
  candidateId: string;
  candidateKey?: string;
  viewer: ViewerContext;
  requestedTenant?: string;
}): MemoryCandidate | null {
  const matches = listMemoryPromotionCandidates().filter(
    (candidate) =>
      candidate.candidate_id === input.candidateId &&
      memoryCandidateVisibleToViewer(candidate, input.viewer, input.requestedTenant) &&
      (!input.candidateKey || memoryCandidateKey(candidate) === input.candidateKey)
  );
  if (matches.length > 1)
    throw new MemoryCandidateAmbiguityError(
      'Memory candidate identity is ambiguous; reconcile duplicate records or narrow the selection.'
    );
  return matches[0] ?? null;
}
