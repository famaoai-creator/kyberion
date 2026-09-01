import { NextRequest, NextResponse } from 'next/server';
import {
  listMemoryPromotionCandidates,
  type MemoryCandidate,
} from '@agent/core/memory-promotion-queue';
import { withExecutionContext } from '@agent/core/authority';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../lib/viewer-context';

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
  return {
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
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const candidates = withExecutionContext('sovereign_concierge', () =>
      listMemoryPromotionCandidates()
    )
      // Only undecided candidates are the operator's business here; approved/
      // rejected/promoted rows stay in the ledger for the CLI and audits.
      .filter((candidate) => candidate.status === 'queued')
      .filter(
        (candidate) =>
          resolved.context.tierAccess.includes(candidate.sensitivity_tier) &&
          (resolved.context.tenantSlugs === 'all'
            ? true
            : Boolean(
                candidate.scope?.tenant_slug &&
                resolved.context.tenantSlugs.includes(candidate.scope.tenant_slug)
              ))
      )
      .sort((a, b) => String(b.queued_at).localeCompare(String(a.queued_at)));
    return NextResponse.json({ ok: true, candidates: candidates.map(toItem) });
  } catch (error) {
    return conciergeErrorResponse(error);
  }
}
