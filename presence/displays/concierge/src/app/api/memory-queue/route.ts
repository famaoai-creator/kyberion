import { NextResponse } from 'next/server';
import {
  listMemoryPromotionCandidates,
  withExecutionContext,
  type MemoryCandidate,
} from '@agent/core';

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

export function GET() {
  try {
    const candidates = withExecutionContext('sovereign_concierge', () =>
      listMemoryPromotionCandidates()
    )
      // Only undecided candidates are the operator's business here; approved/
      // rejected/promoted rows stay in the ledger for the CLI and audits.
      .filter((candidate) => candidate.status === 'queued')
      .sort((a, b) => String(b.queued_at).localeCompare(String(a.queued_at)));
    return NextResponse.json({ ok: true, candidates: candidates.map(toItem) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
