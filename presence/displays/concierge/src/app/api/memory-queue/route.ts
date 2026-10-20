import { resolveSurfaceBrowserUrl } from '@agent/core/surface/surface-url';
import { NextRequest, NextResponse } from 'next/server';
import {
  listMemoryPromotionCandidates,
  memoryPromotionCandidateKey,
  type MemoryCandidate,
} from '@agent/core/knowledge/memory-promotion-queue';
import { withExecutionContext } from '@agent/core/authority';
import { resolveConciergeSelectedViewer } from '../../../lib/selected-tenant';
import { memoryCandidateVisibleToViewer } from '../../../lib/memory-candidate-visibility';
import { conciergeErrorResponse } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

/**
 * CS-03 記憶昇格キュー — read-only list of memory-promotion candidates still
 * waiting for the human's decision (status `queued`). Kind and tier codes are
 * translated to plain language client-side via i18n; this route never mutates
 * the queue — approving/rejecting is a separate guarded POST
 * (api/memory-queue/[id]) that runs the built controller CLI.
 */

const SUMMARY_MAX_CHARS = 400;

export interface MemoryQueueItem {
  learningReviewUrl?: string;
  candidateKey?: string;
  id: string;
  kind: MemoryCandidate['proposed_memory_kind'];
  summary: string;
  /** Human-facing origin, e.g. the mission id behind `mission:MSN-…`. */
  source: string;
  source_type: MemoryCandidate['source_type'];
  sensitivity_tier: MemoryCandidate['sensitivity_tier'];
  occurrences: number;
  queued_at: string;
}

function toItem(candidate: MemoryCandidate): MemoryQueueItem {
  const summary = String(candidate.summary || '').trim();
  const scopedSop = Boolean(candidate.scope && candidate.proposed_memory_kind === 'sop');
  const candidateKey = memoryPromotionCandidateKey(candidate);
  const reviewUrl = scopedSop ? new URL(resolveSurfaceBrowserUrl('chronos')) : undefined;
  if (reviewUrl) {
    reviewUrl.searchParams.set('section', 'knowledge');
    reviewUrl.searchParams.set('candidateKey', candidateKey);
    if (candidate.scope?.tenant_slug)
      reviewUrl.searchParams.set('tenant', candidate.scope.tenant_slug);
  }
  return {
    ...(candidate.scope ? { candidateKey } : {}),
    ...(reviewUrl ? { learningReviewUrl: reviewUrl.href } : {}),
    id: candidate.candidate_id,
    kind: candidate.proposed_memory_kind,
    summary:
      summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS)}…` : summary,
    source: String(candidate.source_ref || '').replace(/^[a-z_]+:/, ''),
    source_type: candidate.source_type,
    sensitivity_tier: candidate.sensitivity_tier,
    occurrences: Math.max(1, Number(candidate.occurrences) || 1),
    queued_at: candidate.queued_at,
  };
}

export function GET(req: NextRequest) {
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const candidates = withExecutionContext('sovereign_concierge', () =>
      listMemoryPromotionCandidates()
    )
      // Only undecided candidates are the operator's business here; approved/
      // rejected/promoted rows stay in the ledger for the CLI and audits.
      .filter((candidate) => candidate.status === 'queued')
      .filter((candidate) => memoryCandidateVisibleToViewer(candidate, resolved.context))
      .sort((a, b) => String(b.queued_at).localeCompare(String(a.queued_at)));
    return NextResponse.json({ ok: true, candidates: candidates.map(toItem) });
  } catch (error) {
    return conciergeErrorResponse(error);
  }
}
