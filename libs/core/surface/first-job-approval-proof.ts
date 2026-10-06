/** Exact diagnostic effect and authenticated decision provenance. No authority grants. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { withExecutionContext } from '../authority.js';
import { assertBuiltinOnlyWorkerEventStream } from '../workforce/worker-event-stream.js';
import { browserSessionKey } from '../authn-browser-session-key.js';
import {
  computeApprovalPayloadHash,
  isApprovalRequestExpired,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import { assertFrontDeskDiagnosticDotCharter, type DotCharter } from '../dot/dot-charter.js';
import { resolveMemberByPrincipal, readMemberProfile } from '../organization/member-registry.js';
import {
  getFrontDeskExecutionMapping,
  type FrontDeskExecutionBinding,
} from './front-desk-execution-contract.js';
import { frontDeskExecutionArtifactPath } from './front-desk-execution-artifact.js';
export interface FirstJobDecisionProof {
  version: 1;
  decision: 'approved' | 'rejected';
  member_id: string;
  session_id: string;
  session_expires_at: string;
  identity_digest: string;
  issued_at: string;
  display_digest: string;
  signature: string;
}
export const FIRST_JOB_PROOF_DOMAIN = 'kyberion:first-job:verified-browser-decision:v1:';
/** Durable provenance survives charter reloads; malformed explicit markers fail closed too. */
export function hasFirstJobDiagnosticProvenance(
  binding: unknown,
  approval?: Pick<ApprovalRequestRecord, 'diagnosticDecision' | 'accountability'> | null
): boolean {
  return Boolean(
    (binding && typeof binding === 'object' && 'diagnostic_protocol' in binding) ||
    approval?.diagnosticDecision !== undefined ||
    (typeof approval?.accountability?.effectBinding === 'string' &&
      approval.accountability.effectBinding.startsWith('first-job:'))
  );
}
/** Resolve the actual request-owner member without relabelling its loopback principal. */
export function firstJobApprovalEffect(charter: DotCharter, binding: FrontDeskExecutionBinding) {
  assertBuiltinOnlyWorkerEventStream();
  assertFrontDeskDiagnosticDotCharter(charter);
  const mapping = getFrontDeskExecutionMapping(binding);
  if (!mapping || charter.status !== 'active' || mapping.dotId !== charter.dot_id)
    throw new Error('first_job_diagnostic_unavailable');
  const viewer = mapping.viewer;
  const tenant = viewer.tenantSlugs === 'all' ? undefined : viewer.tenantSlugs[0];
  const organization = viewer.organizationIds === 'all' ? undefined : viewer.organizationIds[0];
  const project = viewer.projectIds === 'all' ? undefined : viewer.projectIds[0];
  if (
    viewer.source !== 'loopback' ||
    viewer.role !== 'localadmin' ||
    !viewer.principalId ||
    !tenant ||
    viewer.tenantSlugs.length !== 1 ||
    viewer.tierAccess.length !== 1 ||
    viewer.tierAccess[0] !== 'public' ||
    charter.scope.tenant_slug !== tenant ||
    charter.scope.organization_id !== organization ||
    charter.scope.project_id !== project ||
    (organization ? viewer.organizationIds.length !== 1 : viewer.organizationIds !== 'all') ||
    (project ? viewer.projectIds.length !== 1 : viewer.projectIds !== 'all')
  )
    throw new Error('first_job_scope_changed');
  let owner: ReturnType<typeof resolveMemberByPrincipal>;
  try {
    owner = withExecutionContext('sovereign_concierge', () =>
      resolveMemberByPrincipal({
        principalId: viewer.principalId,
        source: 'loopback',
        memberId: viewer.memberId,
      })
    );
  } catch {
    throw new Error('first_job_owner_unavailable');
  }
  if (
    !owner ||
    owner.status !== 'active' ||
    !owner.memberships.some(
      (entry) => entry.tenant_slug === tenant && ['owner', 'approver'].includes(entry.role)
    )
  )
    throw new Error('first_job_owner_unavailable');
  const scope = {
    scope_kind: project ? 'project' : organization ? 'organization' : 'tenant',
    tier: 'public',
    tenant_slug: tenant,
    viewer_principal: viewer.principalId,
    ...(organization ? { organization_id: organization } : {}),
    ...(project ? { project_id: project } : {}),
  };
  const effect = {
    kind: 'first-job-local-receipt',
    operation: 'create-new-file',
    external_send: false,
    dot_id: charter.dot_id,
    charter_digest: computeApprovalPayloadHash({ charter }),
    owner_member_id: owner.member_id,
    scope,
    binding,
    artifact_path: frontDeskExecutionArtifactPath(binding, mapping),
    receipt_format: binding.receipt_format ?? 'pretty',
  };
  const payloadHash = computeApprovalPayloadHash(effect);
  return {
    mapping,
    ownerMemberId: owner.member_id,
    effect,
    payloadHash,
    effectBinding: 'first-job:' + payloadHash,
  };
}
export type FirstJobApprovalEffect = ReturnType<typeof firstJobApprovalEffect>;
/** Fixed review summary, including the effective execution deadline, bound to the request. */
export function firstJobApprovalDisplayDigest(
  record: ApprovalRequestRecord,
  effect: FirstJobApprovalEffect,
  executionDeadline: string
): string {
  return computeApprovalPayloadHash({
    approval_request_id: record.id,
    requested_by: record.requestedBy,
    requested_at: record.requestedAt,
    expires_at: record.expiresAt,
    execution_deadline_at: executionDeadline,
    correlation_id: record.correlationId,
    scope: record.scope,
    accountability: record.accountability,
    effect: effect.effect,
  });
}
export function firstJobProofMessage(
  record: ApprovalRequestRecord,
  proof: Omit<FirstJobDecisionProof, 'signature'>
): string {
  return (
    FIRST_JOB_PROOF_DOMAIN +
    computeApprovalPayloadHash({
      approval_request_id: record.id,
      scope: record.scope,
      accountability: record.accountability,
      requested_by: record.requestedBy,
      requested_at: record.requestedAt,
      expires_at: record.expiresAt,
      correlation_id: record.correlationId,
      proof,
    })
  );
}
/** Fail closed before settlement and again immediately before any diagnostic effect.
 * Protects HTTP adapter boundaries, not a compromised server or an actor with the signing key. */
export function hasVerifiedFirstJobDecision(
  record: ApprovalRequestRecord,
  charter: DotCharter,
  binding: FrontDeskExecutionBinding,
  now = Date.now()
): boolean {
  try {
    const proof = record.diagnosticDecision;
    if (
      !proof ||
      proof.version !== 1 ||
      proof.decision !== 'approved' ||
      !['approved', 'applied'].includes(record.status) ||
      record.decidedByType !== 'human' ||
      record.authenticated !== true ||
      record.decidedAuthMethod !== 'surface_session' ||
      record.decidedBy !== 'user:' + proof.member_id ||
      !/^[a-f0-9]{24}$/.test(proof.session_id) ||
      !/^[a-f0-9]{64}$/.test(proof.signature) ||
      !Number.isFinite(Date.parse(proof.issued_at)) ||
      Date.parse(proof.issued_at) > now ||
      !Number.isFinite(Date.parse(proof.session_expires_at)) ||
      Date.parse(proof.session_expires_at) <= now ||
      !record.expiresAt ||
      !Number.isFinite(Date.parse(record.expiresAt)) ||
      isApprovalRequestExpired(record, now)
    )
      return false;
    const key = browserSessionKey();
    if (!key) return false;
    const { signature, ...unsigned } = proof;
    const expected = createHmac('sha256', key)
      .update(firstJobProofMessage(record, unsigned))
      .digest('hex');
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
    const effect = firstJobApprovalEffect(charter, binding);
    const deadline = new Date(
      Math.min(Date.parse(record.expiresAt), Date.parse(proof.session_expires_at))
    ).toISOString();
    if (
      record.accountability?.finalDecision !== 'human_only' ||
      record.accountability.payloadHash !== effect.payloadHash ||
      record.accountability.effectBinding !== effect.effectBinding ||
      proof.member_id !== effect.ownerMemberId ||
      record.requestedBy !== 'dot:' + charter.dot_id ||
      record.kind !== 'channel-approval' ||
      record.storageChannel !== 'autonomy' ||
      computeApprovalPayloadHash({ scope: record.scope }) !==
        computeApprovalPayloadHash({ scope: effect.effect.scope }) ||
      proof.display_digest !== firstJobApprovalDisplayDigest(record, effect, deadline) ||
      record.target ||
      record.steering ||
      record.workflow ||
      record.veto
    )
      return false;
    const member = withExecutionContext('sovereign_concierge', () =>
      readMemberProfile(proof.member_id)
    );
    if (
      !member ||
      member.status !== 'active' ||
      !member.memberships.some(
        (entry) =>
          entry.tenant_slug === effect.effect.scope.tenant_slug &&
          ['owner', 'approver'].includes(entry.role)
      )
    )
      return false;
    return Boolean(
      member.external_identities?.some(
        (identity) =>
          computeApprovalPayloadHash({ issuer: identity.issuer, subject: identity.subject }) ===
          proof.identity_digest
      )
    );
  } catch {
    return false;
  }
}
