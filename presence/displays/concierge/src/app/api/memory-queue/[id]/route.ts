import { NextRequest, NextResponse } from 'next/server';
import {
  listMemoryPromotionCandidates,
  memoryPromotionCandidateKey,
  updateMemoryPromotionCandidateStatus,
} from '@agent/core/knowledge/memory-promotion-queue';
import { withExecutionContext } from '@agent/core/authority';
import {
  reviewMemoryPromotionCandidate,
  assertMemoryPromotionReviewReady,
} from '@agent/core/knowledge/memory-promotion-review';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { readRequestObject } from '../../../../lib/request-input';
import {
  conciergeText,
  resolveConciergeLocale,
  type ConciergeMessageKey,
} from '../../../../lib/i18n';
import { resolveConciergeViewer } from '../../../../lib/viewer-context';
import { memoryCandidateVisibleToViewer } from '../../../../lib/memory-candidate-visibility';
import {
  conciergeDecisionDenied,
  resolveConciergeDecidedBy,
} from '../../../../lib/front-desk-member';

export const dynamic = 'force-dynamic';

/** Human decisions retain exact scope through shared review and atomic queue mutation. */

const ALLOWED_DECISIONS = ['approve', 'reject'] as const;
type MemoryDecision = (typeof ALLOWED_DECISIONS)[number];

const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;

  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
  const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
    conciergeText(key, locale, params);

  try {
    const { id } = await context.params;
    const parsedBody = await readRequestObject(req, 'request body', ['decision', 'candidateKey']);
    if (parsedBody.ok !== true)
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    const { body } = parsedBody;
    const decision = ALLOWED_DECISIONS.includes(body?.decision as MemoryDecision)
      ? (body.decision as MemoryDecision)
      : null;
    if (!id || !CANDIDATE_ID_PATTERN.test(id) || !decision) {
      return NextResponse.json({ ok: false, error: t('api.memory.invalid') }, { status: 400 });
    }

    // Only candidates actually in the queue are actionable, within the
    // viewer's full authorized scope (not the rail's selected company — the
    // list is narrowed, this write is not); the decision authorizes against
    // the candidate's own tenant. Decisions are one-shot: a decided candidate
    // is no longer pending.
    const candidateKey = body.candidateKey;
    if (
      candidateKey !== undefined &&
      (typeof candidateKey !== 'string' || !/^[a-f0-9]{64}$/.test(candidateKey))
    )
      return NextResponse.json({ ok: false, error: t('api.memory.invalid') }, { status: 400 });
    const candidate = withExecutionContext('sovereign_concierge', () => {
      const matches = listMemoryPromotionCandidates().filter(
        (row) =>
          row.candidate_id === id &&
          (typeof candidateKey !== 'string' || memoryPromotionCandidateKey(row) === candidateKey)
      );
      return matches.length === 1 ? matches[0] : null;
    });
    const visible = candidate && memoryCandidateVisibleToViewer(candidate, resolved.context);
    if (!visible) {
      return NextResponse.json({ ok: false, error: t('api.memory.not_found') }, { status: 404 });
    }
    if (candidate.scope && candidate.proposed_memory_kind === 'sop' && decision !== 'reject')
      return NextResponse.json(
        {
          ok: false,
          error: 'Scoped SOPs require the shared review and verified publication flow in Chronos.',
        },
        { status: 409 }
      );
    if (candidate.status !== 'queued') {
      return NextResponse.json({ ok: false, error: t('api.memory.not_pending') }, { status: 409 });
    }

    // The decision lands on the candidate's tenant — the member gate checks
    // the membership for THAT tenant, not the first scope entry (B4/F2).
    const resourceTenant = candidate.scope?.tenant_slug;
    const decisionDenied = conciergeDecisionDenied(resolved.context, resourceTenant);
    if (decisionDenied) return decisionDenied;

    if (candidate.scope && candidateKey !== memoryPromotionCandidateKey(candidate))
      return NextResponse.json(
        { ok: false, error: 'Exact scoped candidate key is required' },
        { status: 409 }
      );
    // An unscoped address has no scope selector in the queue API; retain a
    // unique identity instead of accidentally selecting a scoped sibling.
    if (
      !candidate.scope &&
      withExecutionContext(
        'sovereign_concierge',
        () => listMemoryPromotionCandidates().filter((row) => row.candidate_id === id).length
      ) !== 1
    )
      return NextResponse.json(
        { ok: false, error: 'Candidate identity is ambiguous' },
        { status: 409 }
      );
    const decidedBy = resolveConciergeDecidedBy(resolved.context, resourceTenant);
    const expected = decision === 'approve' ? 'approved' : 'rejected';
    const after = withExecutionContext('sovereign_concierge', () => {
      if (decision === 'approve') {
        const reviews = reviewMemoryPromotionCandidate(candidate.candidate_id, candidate.scope);
        if (
          reviews.length !== 1 ||
          memoryPromotionCandidateKey(reviews[0].candidate) !==
            memoryPromotionCandidateKey(candidate)
        )
          throw new Error('[MEMORY_PROMOTION_AMBIGUOUS] Exact candidate review is required');
        // Match memory-approve: no domain or curation edits are accepted by
        // this surface, and the same evidence/audit/readiness floors apply.
        assertMemoryPromotionReviewReady(
          {
            ...reviews[0],
            blockers: reviews[0].blockers.filter(
              (blocker) => blocker.code !== 'unclassified_domain'
            ),
          },
          'approve'
        );
      }
      return updateMemoryPromotionCandidateStatus({
        candidateId: candidate.candidate_id,
        scope: candidate.scope,
        expectedStatus: candidate.status,
        status: expected,
        ratificationNote:
          decision === 'approve'
            ? 'Approved for promotion.'
            : 'Rejected from the concierge memory review queue.',
        ...(decision === 'approve' ? { approvalChannel: 'steward' as const } : {}),
        ...(decidedBy ? { decidedBy: { ...decidedBy, kind: 'human' as const } } : {}),
      });
    });
    if (after?.status !== expected)
      return NextResponse.json({ ok: false, error: t('api.memory.failed') }, { status: 409 });

    return NextResponse.json({
      ok: true,
      result: {
        id: candidate.candidate_id,
        decision,
        status: after.status,
        message: t(decision === 'approve' ? 'api.memory.approved' : 'api.memory.rejected'),
      },
    });
  } catch (error) {
    console.error(
      `[concierge/memory-queue] decision route failed: ${error instanceof Error ? error.stack || error.message : String(error)}`
    );
    return NextResponse.json({ ok: false, error: t('api.memory.failed') }, { status: 500 });
  }
}
