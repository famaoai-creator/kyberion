/** Lightweight read-only proof checks; avoids loading approval writers from the memory queue. */
import { withExecutionContext } from '../authority.js';
import { resolveAccountableHuman } from '../organization/member-registry.js';
import {
  assuranceMeets,
  assuranceOfAuthMethod,
  DEFAULT_HUMAN_ONLY_MIN_ASSURANCE,
} from '../governance/approval-assurance.js';
import {
  loadApprovalRequest,
  listApprovalRequests,
  isApprovalRequestExpired,
} from '../governance/approval-store-reader.js';
import { assertApprovalUsable } from '../governance/approval-separation-of-duties.js';
import { computeApprovalPresentedDigest } from '../governance/approval-presentation.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import {
  approvedLearningPayloadDigest,
  assertScopedLearningScope,
  assertScopedLearningPublicationReferences,
  scopedLearningMarkdownPath,
  learningSha256,
  type ScopedLearningApproval,
} from './scoped-learning-domain.js';
import type { MemoryCandidate } from './memory-promotion-queue.js';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile, safeLstat, assertSafeRepositoryPath } from '../secure-io.js';
const ROLE = 'infrastructure_sentinel';
const CHANNEL = 'terminal';
export function scopedLearningApprovalBinding(candidate: MemoryCandidate) {
  const scope = assertScopedLearningScope(candidate.scope!);
  const digest = approvedLearningPayloadDigest(candidate);
  const destination = scopedLearningMarkdownPath(scope, candidate.candidate_id);
  return { scope, digest, destination, effect: 'scoped-learning:' + digest + ':' + destination };
}
export function assertScopedLearningApprovalBinding(
  record: ApprovalRequestRecord,
  candidate: MemoryCandidate
): void {
  const b = scopedLearningApprovalBinding(candidate);
  if (
    record.accountability?.finalDecision !== 'human_only' ||
    record.accountability.payloadHash !== b.digest ||
    record.accountability.effectBinding !== b.effect ||
    record.source?.taskId !== candidate.candidate_id ||
    record.scope?.tier !== b.scope.tier ||
    record.scope.tenant_slug !== b.scope.tenant_slug ||
    record.scope.organization_id !== b.scope.organization_id ||
    record.scope.project_id !== b.scope.project_id ||
    record.scope.mission_id !== undefined ||
    record.scope.task_id !== undefined ||
    record.justification?.requestedEffects?.length !== 1 ||
    record.justification.requestedEffects[0] !== b.effect
  )
    throw new Error(
      '[LEARNING_APPROVAL_BINDING] Approval does not bind this exact content and publication destination'
    );
}
/** Exact identity lookup, including terminal decisions. A changed digest is not a new review. */
export function findScopedLearningApprovalRequest(
  candidate: MemoryCandidate
): ApprovalRequestRecord | undefined {
  const scope = assertScopedLearningScope(candidate.scope!);
  const rows = withExecutionContext(ROLE, () =>
    listApprovalRequests({ storageChannels: [CHANNEL] }).filter(
      (record) =>
        record.source?.taskId === candidate.candidate_id &&
        record.scope?.tier === scope.tier &&
        record.scope.tenant_slug === scope.tenant_slug &&
        record.scope.organization_id === scope.organization_id &&
        record.scope.project_id === scope.project_id &&
        record.scope.mission_id === undefined &&
        record.scope.task_id === undefined &&
        (record.accountability?.effectBinding?.startsWith('scoped-learning:') ||
          record.correlationId?.startsWith('scoped-learning:'))
    )
  );
  if (rows.length > 1)
    throw new Error(
      '[LEARNING_APPROVAL_CONFLICT] Multiple scoped decisions require reconciliation'
    );
  return rows[0];
}

/** Queue writers call under the queue mutex: a canonical request freezes its payload. */
export function assertScopedLearningReviewUnchanged(
  current: MemoryCandidate,
  next: MemoryCandidate
): void {
  if (!current.scope) return;
  try {
    assertScopedLearningScope(current.scope);
  } catch {
    return; // Restricted envelopes are review-only and cannot have a scoped publication request.
  }
  const record = findScopedLearningApprovalRequest(current);
  if (!record) return;
  try {
    assertScopedLearningApprovalBinding(record, current);
    if (approvedLearningPayloadDigest(next) !== record.accountability?.payloadHash)
      throw new Error('payload changed');
  } catch {
    throw new Error(
      '[LEARNING_APPROVAL_IMMUTABLE] Requested content and scope are frozen; use a new candidate'
    );
  }
}

/** Verifies real server-resolved human proof; caller-supplied labels never ratify knowledge. */
export function verifyScopedLearningApprovalRef(
  candidate: MemoryCandidate,
  approvalRef: string
): ScopedLearningApproval {
  assertScopedLearningPublicationReferences(candidate);
  const [channel, id, extra] = approvalRef.split(':');
  if (channel !== CHANNEL || !id || extra)
    throw new Error('[LEARNING_APPROVAL_REQUIRED] Expected terminal:request-id');
  const record = withExecutionContext(ROLE, () => loadApprovalRequest(channel, id));
  if (!record) throw new Error('[LEARNING_APPROVAL_REQUIRED] Shared approval record is missing');
  assertScopedLearningApprovalBinding(record, candidate);
  if (
    record.status !== 'approved' ||
    record.decidedByType !== 'human' ||
    record.authenticated !== true ||
    record.decidedByIdentitySource === 'caller_supplied' ||
    record.decidedInAgentSession ||
    !assuranceMeets(
      assuranceOfAuthMethod(record.decidedAuthMethod),
      DEFAULT_HUMAN_ONLY_MIN_ASSURANCE
    ) ||
    record.assuranceShortfall ||
    !record.decidedAt ||
    !Number.isFinite(Date.parse(record.decidedAt)) ||
    !record.decidedBy?.startsWith('user:') ||
    !record.verifiedPresentedDigest ||
    record.verifiedPresentedDigest !== computeApprovalPresentedDigest(record)
  )
    throw new Error(
      '[LEARNING_APPROVAL_REQUIRED] An authenticated human must approve the exact presented SOP'
    );
  withExecutionContext(ROLE, () =>
    assertApprovalUsable(record, { consumer: 'scoped_learning_publication' })
  );
  const member = withExecutionContext('sovereign_concierge', () =>
    resolveAccountableHuman(record.decidedBy!)
  );
  const membership = member?.memberships.find(
    (row) => row.tenant_slug === candidate.scope?.tenant_slug
  );
  if (
    member?.status !== 'active' ||
    !membership ||
    !['owner', 'approver'].includes(membership.role)
  )
    throw new Error(
      '[LEARNING_APPROVAL_AUTHORITY] Reviewing member no longer has tenant approval authority'
    );
  // Expiry fences a new publication, not ordinary reuse of a previously verified artifact.
  // Historical approval must itself precede the expiry; revocation is checked on every read.
  if (
    isApprovalRequestExpired(record, Date.parse(record.decidedAt)) ||
    (!hasCompletedPublication(record, candidate) && isApprovalRequestExpired(record))
  )
    throw new Error('[LEARNING_APPROVAL_EXPIRED] Review expired before publication');
  return {
    version: 1,
    payload_digest: approvedLearningPayloadDigest(candidate),
    approval_ref: approvalRef,
    decided_by: { kind: 'human', id: record.decidedBy },
    approved_at: record.decidedAt,
    channel: 'steward',
  };
}

function hasCompletedPublication(
  record: ApprovalRequestRecord,
  candidate: MemoryCandidate
): boolean {
  const publication = candidate.learning_publication;
  if (
    !publication ||
    candidate.status !== 'promoted' ||
    publication.candidate_id !== candidate.candidate_id ||
    publication.approved_payload_digest !== approvedLearningPayloadDigest(candidate) ||
    publication.markdown_path !==
      scopedLearningMarkdownPath(candidate.scope!, candidate.candidate_id) ||
    publication.record_path !== publication.markdown_path.replace(/\.md$/, '.json') ||
    record.consumption?.consumer !== 'scoped_learning_publication' ||
    record.consumption.effectRef !==
      'scoped-learning:' +
        publication.approved_payload_digest +
        ':' +
        publication.markdown_sha256 ||
    !Number.isFinite(Date.parse(record.consumption.consumedAt)) ||
    isApprovalRequestExpired(record, Date.parse(record.consumption.consumedAt))
  )
    return false;
  try {
    return withExecutionContext(
      'mission_controller',
      () =>
        [
          [publication.markdown_path, publication.markdown_sha256],
          [publication.record_path, publication.record_sha256],
        ].every(([file, hash]) => {
          const absolute = assertSafeRepositoryPath(pathResolver.rootResolve(file!));
          const stat = safeLstat(absolute);
          return (
            stat.isFile() &&
            !stat.isSymbolicLink() &&
            learningSha256(String(safeReadFile(absolute, { encoding: 'utf8' }))) === hash
          );
        }),
      undefined,
      candidate.scope!.tenant_slug,
      candidate.scope!.organization_id
    );
  } catch {
    return false;
  }
}
