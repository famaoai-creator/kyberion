/**
 * Service recording review through the shared approval store.
 *
 * A recording's review (`service_recording review --approve|--reject`) is an
 * approval request in the `service-recording-review` channel, bound to the
 * recording's content hash (`serviceRecordingContentHash`) and its id — the
 * same hash-bound shape as project trust and provider attestation. The request
 * is opened when the recording is captured (or with `request-review`), so its
 * requester is whoever asked for the review; the decision is recorded by the
 * store, which enforces separation of duties and audits it. The recording's
 * `review.approval_request_id` points at the request, and promotion re-checks
 * it (`service_recording_promotion`), so a revoked or unusable approval never
 * promotes.
 */
import {
  assertApprovalUsable,
  computeApprovalPayloadHash,
  createApprovalRequest,
  evaluateApprovalUsability,
  isApprovalRequestExpired,
  isSeparationOfDutiesEnabled,
  listApprovalRequests,
  loadApprovalRequest,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import { serviceRecordingContentHash, type ServiceRecording } from './service-recording.js';
import { markApprovalConsumed } from '../governance/approval-revocation.js';
import {
  approvalRequesterActorId,
  resolveApprovalRequesterInput,
  type ApprovalRequesterInput,
} from '../governance/approval-requester.js';

export const SERVICE_RECORDING_REVIEW_CHANNEL = 'service-recording-review';

export function serviceRecordingReviewBinding(recording: Pick<ServiceRecording, 'recording_id'>) {
  return `service-recording-review:${recording.recording_id}`;
}

function payloadHashFor(recording: ServiceRecording): string {
  return computeApprovalPayloadHash({
    recording_id: recording.recording_id,
    content_hash: serviceRecordingContentHash(recording),
  });
}

/**
 * The open review request for this exact recording content: pending, or
 * approved and still usable. Rejected, expired, revoked or otherwise unusable
 * requests are never handed back, so a fresh review is opened instead.
 */
export function findServiceRecordingReviewRequest(
  recording: ServiceRecording
): ApprovalRequestRecord | undefined {
  const payloadHash = payloadHashFor(recording);
  const binding = serviceRecordingReviewBinding(recording);
  return listApprovalRequests({
    storageChannels: [SERVICE_RECORDING_REVIEW_CHANNEL],
    status: ['pending', 'approved'],
  }).find(
    (record) =>
      record.accountability?.payloadHash === payloadHash &&
      record.accountability?.effectBinding === binding &&
      !record.applyClaim &&
      !isApprovalRequestExpired(record) &&
      (record.status !== 'approved' || !evaluateApprovalUsability(record))
  );
}

/** Open (or reuse) the review request for a recording. */
export function requestServiceRecordingReview(params: {
  recording: ServiceRecording;
  recordingRef: string;
  /** Resolved by the entry point; resolved only when a request is opened. */
  requester: ApprovalRequesterInput;
}): ApprovalRequestRecord {
  const existing = findServiceRecordingReviewRequest(params.recording);
  if (existing) return existing;
  const { recording } = params;
  const requester = resolveApprovalRequesterInput(params.requester);
  const binding = serviceRecordingReviewBinding(recording);
  const highRisk = recording.steps.filter((step) => step.risk_class === 'high').length;
  return createApprovalRequest('mission_controller', {
    channel: SERVICE_RECORDING_REVIEW_CHANNEL,
    storageChannel: SERVICE_RECORDING_REVIEW_CHANNEL,
    threadTs: recording.recording_id,
    correlationId: binding,
    requestedBy: requester.requestedBy,
    ...(requester.displayName ? { requestedByDisplayName: requester.displayName } : {}),
    kind: 'channel-approval',
    draft: {
      title: `Service recording review: ${recording.target.name}`,
      summary: `Approve recording ${recording.recording_id} (${recording.steps.length} step(s), ${highRisk} with external effects) for promotion to a service procedure.`,
      details: [
        `Recording: ${params.recordingRef}`,
        `Services: ${recording.target.services.join(', ')}`,
        ...recording.steps.map(
          (step) => `- ${step.step_id} [${step.risk_class}] ${step.service_id}.${step.action}`
        ),
      ].join('\n'),
      severity: highRisk > 0 ? 'high' : 'medium',
    },
    requestedByContext: {
      surface: 'terminal',
      actorId: approvalRequesterActorId(requester),
      actorRole: 'service-recording',
    },
    justification: { reason: 'service recording review', requestedEffects: [binding] },
    accountability: {
      finalDecision: 'human_only',
      payloadHash: payloadHashFor(recording),
      effectBinding: binding,
    },
  });
}

/**
 * Re-check, before an effect, the approval a recording's review points at:
 * approved, bound to this exact content, and usable for `consumer`. A review
 * written before reviews went through the store (no `approval_request_id`)
 * is accepted only while separation of duties is off.
 */
export function assertServiceRecordingReviewApproval(
  recording: ServiceRecording,
  recordingRef: string
): void {
  const requestId = recording.review?.approval_request_id;
  if (!requestId) {
    if (!isSeparationOfDutiesEnabled()) return;
    throw new Error(
      `[POLICY_VIOLATION] Separation of duties: the review of ${recordingRef} was not recorded in the approval store, ` +
        'so who approved it cannot be checked. Open a review request with ' +
        `\`service_recording request-review --recording ${recordingRef}\`. ` +
        reviewSeparationHint(recordingRef)
    );
  }
  const approval = loadApprovalRequest(SERVICE_RECORDING_REVIEW_CHANNEL, requestId);
  if (!approval || approval.status !== 'approved') {
    throw new Error(
      `[POLICY_VIOLATION] Recording review approval ${requestId} is ${approval?.status ?? 'missing'}, not approved`
    );
  }
  if (
    approval.accountability?.payloadHash !== payloadHashFor(recording) ||
    approval.accountability?.effectBinding !== serviceRecordingReviewBinding(recording)
  ) {
    throw new Error(
      `[POLICY_VIOLATION] Recording review approval ${requestId} was given for different recording content`
    );
  }
  assertApprovalUsable(approval, {
    consumer: 'service_recording_promotion',
    rerequestHint: `open a new review request with \`service_recording request-review --recording ${recordingRef}\` (${reviewSeparationHint(recordingRef)})`,
  });
}

/** How a separated review approval can be obtained (no dead end). */
export function reviewSeparationHint(recordingRef: string): string {
  return (
    'Under separation of duties the approval must come from a principal other than the one who ' +
    'requested the review: a different member deciding on an authenticated surface (Chronos or ' +
    'presence-studio), or — on a review request someone else opened — ' +
    `\`service_recording review --recording ${recordingRef} --approve\` in an interactive terminal, ` +
    'answering its challenge.'
  );
}

/**
 * Promotion is a one-shot effect: record that it used the review approval
 * (`markApprovalConsumed`), so the approval cannot promote twice and a later
 * revoke reports it as consumed. A legacy review (no approval id, allowed only
 * while separation of duties is off) has nothing to consume.
 */
export function consumeServiceRecordingReviewApproval(
  recording: ServiceRecording,
  consumedBy: string
): void {
  const requestId = recording.review?.approval_request_id;
  if (!requestId) return;
  markApprovalConsumed('mission_controller', {
    channel: SERVICE_RECORDING_REVIEW_CHANNEL,
    requestId,
    consumer: 'service_recording_promotion',
    consumedBy,
  });
}
