import { NextResponse } from 'next/server';
import {
  curateScopedLearningCandidate,
  requestScopedLearningCandidateApproval,
  publishScopedLearningCandidate,
} from '@agent/core/knowledge/scoped-learning-workflow';
import {
  memoryPromotionCandidateKey,
  updateMemoryPromotionCandidateStatus,
} from '@agent/core/knowledge/memory-promotion-queue';
import { isScopedLearningCandidate } from '@agent/core/knowledge/scoped-learning-domain';
import { promoteMemoryCandidateToKnowledge } from '@agent/core/knowledge/memory-promotion-workflow';
import {
  MemoryCandidateAmbiguityError,
  resolveMemoryCandidateForViewer,
} from '../../../lib/memory-candidate-selection';
import { projectKnowledgeCandidate } from '../../../lib/knowledge-candidate-projection';
import type { IntelligenceActionHandler } from './actions';

const memoryAction: IntelligenceActionHandler = async (body, resolvedViewer, action) => {
  try {
    const candidate = resolveMemoryCandidateForViewer({
      candidateId: String(body.candidateId || ''),
      candidateKey: typeof body.candidateKey === 'string' ? body.candidateKey : undefined,
      viewer: resolvedViewer.context,
      requestedTenant: typeof body.tenant === 'string' ? body.tenant : undefined,
    });
    if (!candidate)
      return NextResponse.json(
        { ok: false, outcome: 'not_applied', error: 'Memory promotion candidate not found' },
        { status: 404 }
      );
    const scopedSop = Boolean(candidate.scope && candidate.proposed_memory_kind === 'sop');
    if (
      action === 'memory_reject_candidate' &&
      candidate.scope &&
      body.candidateKey !== memoryPromotionCandidateKey(candidate)
    )
      return NextResponse.json(
        { ok: false, outcome: 'not_applied', error: 'Exact scoped candidate key is required' },
        { status: 409 }
      );
    if (
      [
        'memory_curate_candidate',
        'memory_request_learning_approval',
        'memory_publish_learning',
      ].includes(action) &&
      !isScopedLearningCandidate(candidate)
    )
      return NextResponse.json(
        {
          ok: false,
          outcome: 'not_applied',
          error: 'This candidate is not supported by scoped learning publication',
        },
        { status: 409 }
      );
    const scopedInput = {
      candidateId: candidate.candidate_id,
      scope: candidate.scope!,
      expectedPayloadDigest: String(body.expectedPayloadDigest || ''),
    };
    let updated = candidate;
    if (action === 'memory_curate_candidate') {
      updated = curateScopedLearningCandidate({
        ...scopedInput,
        curation: body.curation as NonNullable<typeof candidate.curation>,
      }).candidate;
    } else if (action === 'memory_request_learning_approval') {
      const actor =
        resolvedViewer.context.principal?.actor.id || resolvedViewer.context.principalId;
      if (!actor)
        return NextResponse.json(
          {
            ok: false,
            outcome: 'not_applied',
            error: 'A server-resolved requester identity is required',
          },
          { status: 403 }
        );
      updated = requestScopedLearningCandidateApproval({
        ...scopedInput,
        requester: { requestedBy: actor, actorId: actor },
      }).candidate;
    } else if (action === 'memory_publish_learning') {
      updated = (
        await publishScopedLearningCandidate({ ...scopedInput, executionRole: 'chronos_gateway' })
      ).candidate;
    } else {
      // Rejection only narrows state; it never grants publication authority.
      // All scoped SOP positive effects stay behind the canonical review flow.
      if (scopedSop && action !== 'memory_reject_candidate')
        return NextResponse.json(
          {
            ok: false,
            outcome: 'not_applied',
            error: 'Use the exact scoped learning review and publication flow',
          },
          { status: 409 }
        );
      if (action === 'memory_promote_candidate') {
        updated = (
          await promoteMemoryCandidateToKnowledge({
            candidateId: candidate.candidate_id,
            scope: candidate.scope,
            executionRole: 'chronos_gateway',
            ratificationNote: 'Promoted from the Chronos knowledge review page.',
          })
        ).candidate;
      } else {
        const status = action === 'memory_approve_candidate' ? 'approved' : 'rejected';
        if (
          status === 'approved'
            ? candidate.status !== 'queued' || !candidate.ratification_required
            : !['queued', 'approved'].includes(candidate.status)
        )
          return NextResponse.json(
            {
              ok: false,
              outcome: 'not_applied',
              error: 'Candidate is not actionable in its current state',
            },
            { status: 409 }
          );
        const result = updateMemoryPromotionCandidateStatus({
          candidateId: candidate.candidate_id,
          scope: candidate.scope,
          status,
          ...(status === 'rejected' ? { expectedStatus: candidate.status } : {}),
          ratificationNote:
            typeof body.note === 'string' && body.note.trim()
              ? body.note.trim()
              : 'Reviewed from the Chronos knowledge review page.',
        });
        if (!result)
          return NextResponse.json(
            { ok: false, error: 'Candidate changed during the action' },
            { status: 409 }
          );
        updated = result;
      }
    }
    return NextResponse.json({
      ok: true,
      candidate: projectKnowledgeCandidate(updated),
      ...(updated.promoted_ref ? { promotedRef: updated.promoted_ref } : {}),
    });
  } catch (error) {
    if (error instanceof MemoryCandidateAmbiguityError)
      return NextResponse.json(
        { ok: false, outcome: 'not_applied', error: 'The candidate selection is ambiguous' },
        { status: 409 }
      );
    if (error instanceof Error && /\[(?:LEARNING|MEMORY_PROMOTION)_/.test(error.message))
      return NextResponse.json(
        {
          ok: false,
          error:
            'Learning action could not be confirmed; refresh the exact candidate before continuing',
        },
        { status: 409 }
      );
    throw error;
  }
};

export const MEMORY_ACTION_HANDLERS: Record<string, IntelligenceActionHandler> = Object.fromEntries(
  [
    'memory_curate_candidate',
    'memory_request_learning_approval',
    'memory_publish_learning',
    'memory_approve_candidate',
    'memory_reject_candidate',
    'memory_promote_candidate',
  ].map((action) => [action, memoryAction])
);
