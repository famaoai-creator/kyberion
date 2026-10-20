/** Opens exact scoped human reviews in the canonical shared approval store. */
import { withExecutionContext } from '../authority.js';
import { withLockSync } from '../lock-utils.js';
import {
  createApprovalRequest,
  loadApprovalRequest,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import { markApprovalConsumed } from '../governance/approval-revocation.js';
import {
  resolveApprovalRequesterInput,
  approvalRequesterActorId,
  type ApprovalRequesterInput,
} from '../governance/approval-requester.js';
import {
  scopedLearningApprovalBinding as binding,
  assertScopedLearningApprovalBinding as exact,
  verifyScopedLearningApprovalRef,
  findScopedLearningApprovalRequest,
} from './scoped-learning-approval-verifier.js';
import { inspectScopedLearningPublication } from './scoped-learning-publication.js';
import type { ScopedLearningPublicationIdentity } from './scoped-learning-contract.js';
import {
  withScopedLearningCandidateReview,
  type MemoryCandidate,
} from './memory-promotion-queue.js';
export { verifyScopedLearningApprovalRef } from './scoped-learning-approval-verifier.js';
const ROLE = 'infrastructure_sentinel';
const CHANNEL = 'terminal';
/** Opens once per exact payload, retaining terminal decisions rather than re-requesting. */
export function requestScopedLearningApproval(input: {
  candidate: MemoryCandidate;
  requester: ApprovalRequesterInput;
  expectedPayloadDigest?: string;
}): { ref: string; status: ApprovalRequestRecord['status'] } {
  return withScopedLearningCandidateReview(
    {
      candidateId: input.candidate.candidate_id,
      scope: input.candidate.scope!,
      expectedCandidate: input.candidate,
      expectedPayloadDigest: input.expectedPayloadDigest,
      ...(input.candidate.curation ? { curation: input.candidate.curation } : {}),
    },
    (candidate) => requestScopedLearningApprovalLocked({ ...input, candidate })
  );
}

/** Caller holds publication and queue locks; never exposed as a detached writer. */
function requestScopedLearningApprovalLocked(input: {
  candidate: MemoryCandidate;
  requester: ApprovalRequesterInput;
}): { ref: string; status: ApprovalRequestRecord['status'] } {
  const b = binding(input.candidate);
  if (!input.candidate.curation)
    throw new Error(
      '[LEARNING_CURATION_REQUIRED] Curated SOP text must be presented before review'
    );
  return withExecutionContext(ROLE, () =>
    withLockSync('scoped-learning-approval:' + b.digest, () => {
      const existing = findScopedLearningApprovalRequest(input.candidate);
      if (existing) {
        exact(existing, input.candidate);
        return { ref: CHANNEL + ':' + existing.id, status: existing.status };
      }
      if (input.candidate.status !== 'queued')
        throw new Error('[LEARNING_REVIEW_REQUIRED] Only a queued candidate can request review');
      const requester = resolveApprovalRequesterInput(input.requester);
      const record = createApprovalRequest(ROLE, {
        channel: CHANNEL,
        threadTs: 'scoped-learning-' + b.digest,
        correlationId: 'scoped-learning:' + b.digest,
        requestedBy: requester.requestedBy,
        ...(requester.displayName ? { requestedByDisplayName: requester.displayName } : {}),
        kind: 'mission_gate',
        expiresAt: new Date(Date.now() + 72 * 3600000).toISOString(),
        source: { taskId: input.candidate.candidate_id },
        scope: b.scope,
        requestedByContext: {
          surface: 'terminal',
          actorId: approvalRequesterActorId(requester),
          actorRole: 'memory_reviewer',
        },
        draft: {
          title: 'Review reusable SOP: ' + input.candidate.curation.title,
          summary:
            'Approve this exact SOP for automatic retrieval by later work in the same or narrower scope. This grants no execution authority.',
          details: [
            'Destination: ' + b.destination,
            'Scope: ' + JSON.stringify(b.scope),
            'Summary: ' + input.candidate.curation.summary,
            input.candidate.curation.content,
            'Evidence: ' + input.candidate.curation.evidence_refs.join(', '),
            'Decide in an authenticated approval surface; a CLI human label is not proof.',
          ].join('\n\n'),
          severity: 'medium',
        },
        justification: {
          reason: 'Human-reviewed same-scope reusable knowledge',
          impactSummary: 'Publishes only the displayed SOP at the exact scoped destination',
          requestedEffects: [b.effect],
        },
        accountability: {
          finalDecision: 'human_only',
          payloadHash: b.digest,
          effectBinding: b.effect,
        },
      });
      return { ref: record.storageChannel + ':' + record.id, status: record.status };
    })
  );
}

/** Record the exact completed publication, never a mere promoted status label. */
export function recordScopedLearningPublicationConsumption(
  candidate: MemoryCandidate,
  publication: ScopedLearningPublicationIdentity
): void {
  const proof = verifyScopedLearningApprovalRef(
    { ...candidate, status: 'approved' },
    candidate.learning_approval!.approval_ref
  );
  const observed = inspectScopedLearningPublication({ ...candidate, status: 'approved' });
  if (JSON.stringify(observed) !== JSON.stringify(publication))
    throw new Error('[LEARNING_PUBLICATION_INVALID] Consumption differs from verified files');
  withExecutionContext(ROLE, () => {
    const [channel, id] = proof.approval_ref.split(':');
    const record = loadApprovalRequest(channel!, id!)!;
    const effectRef = 'scoped-learning:' + proof.payload_digest + ':' + publication.markdown_sha256;
    if (record.consumption) {
      if (
        record.consumption.consumer !== 'scoped_learning_publication' ||
        record.consumption.effectRef !== effectRef
      )
        throw new Error('[LEARNING_APPROVAL_CONFLICT] Approval consumed by another publication');
      return;
    }
    markApprovalConsumed(ROLE, {
      channel: channel!,
      requestId: id!,
      consumer: 'scoped_learning_publication',
      consumedBy: 'memory-promotion',
      effectRef,
    });
  });
}
