/**
 * Verify that a stored project-trust record is a human decision that may
 * issue a run-manifest charter (pipeline-run-manifest-model.md §3.1).
 *
 * The record is always loaded from the approval store by id — a caller can
 * never hand in a record object. Both the charter issuer and the charter
 * registry's writer run this check, so no in-process caller can persist a
 * run-manifest charter without an approved, authenticated, digest-verified
 * human decision by a tenant owner on exactly this manifest.
 */
import { NON_HUMAN_PROOF_AUTH_METHODS } from './approval-assurance.js';
import {
  computeApprovalPayloadHash,
  computeApprovalPresentedDigest,
} from './approval-presentation.js';
import { isApprovalRequestExpired, loadApprovalRequest } from './approval-store-reader.js';
import { parseActorRef } from '../contracts/actor.js';
import {
  resolveAccountableHuman,
  type MemberRegistryPathOptions,
} from '../organization/member-registry.js';
import { computeRunManifestHash, type RunManifest } from '../pipeline/run-manifest.js';
import {
  PROJECT_TRUST_APPROVAL_CHANNEL,
  projectTrustBindingOf,
  projectTrustBindingPayloadV2,
  projectTrustEffectBinding,
} from '../project/project-trust-binding.js';
import type { RunPrincipalMode } from './run-manifest-grant.js';

/** A run-manifest charter never outlives this, even when the approval itself has no expiry. */
export const RUN_MANIFEST_CHARTER_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface VerifiedRunManifestApproval {
  requestId: string;
  /** `user:<member_id>` of the deciding tenant owner. */
  accountable: string;
  tenantSlug: string;
  manifestHash: string;
  principalModes: RunPrincipalMode[];
  /** Daily run cap bound by the approval; absent on v2 records from before the cap. */
  runsPerDay?: number;
  /** The verified digest of the card the owner was shown. */
  presentedDigest: string;
  decidedAt: string;
  /** min(decidedAt + 90 days, approval expiry). */
  expiresAt: string;
}

export interface VerifyRunManifestApprovalOptions {
  now?: Date;
  memberOptions?: MemberRegistryPathOptions;
}

function refuse(reason: string): never {
  throw new Error(
    `[RUN_MANIFEST_CHARTER_REFUSED] ${reason} | next: approve the pipeline again from an authenticated owner session (pnpm kyberion approvals --approve <id>) and rerun`
  );
}

export function verifyRunManifestTrustApproval(
  requestId: string,
  manifest: RunManifest,
  options: VerifyRunManifestApprovalOptions = {}
): VerifiedRunManifestApproval {
  const now = options.now ?? new Date();
  if (typeof requestId !== 'string' || !requestId.trim()) refuse('approval request id is required');
  if (computeRunManifestHash(manifest) !== manifest.manifest_hash)
    refuse('run manifest body does not match its hash');
  const tenantSlug = manifest.scope.tenant_slug;
  if (manifest.scope.tier !== 'confidential' || !tenantSlug)
    refuse('a run-manifest charter needs a tenant-scoped (confidential) pipeline');

  const record = loadApprovalRequest(PROJECT_TRUST_APPROVAL_CHANNEL, requestId);
  if (
    !record ||
    record.storageChannel !== PROJECT_TRUST_APPROVAL_CHANNEL ||
    record.requestedByContext?.actorRole !== 'project-trust' ||
    record.accountability?.effectBinding !== projectTrustEffectBinding(manifest.source.input_path)
  )
    refuse(`project-trust request ${requestId} not found for ${manifest.source.input_path}`);
  if (record.status !== 'approved') refuse(`request ${record.id} is ${record.status}`);
  if (record.revocation) refuse(`request ${record.id} was revoked`);
  if (isApprovalRequestExpired(record, now.getTime())) refuse(`request ${record.id} has expired`);
  if (
    record.accountability.finalDecision !== 'human_only' ||
    record.decidedByType !== 'human' ||
    record.authenticated !== true ||
    !record.decidedAuthMethod ||
    NON_HUMAN_PROOF_AUTH_METHODS.has(record.decidedAuthMethod)
  )
    refuse(`request ${record.id} lacks an authenticated human decision`);
  if (
    !record.verifiedPresentedDigest ||
    record.verifiedPresentedDigest !== computeApprovalPresentedDigest(record)
  )
    refuse(`request ${record.id} was not decided on a verified presentation of its card`);

  const binding = projectTrustBindingOf(record);
  if (binding.version !== 2)
    refuse(
      binding.version === 1
        ? `request ${record.id} trusts the file only (v1); it carries no run manifest`
        : `request ${record.id} has a ${binding.reason}`
    );
  if (binding.manifest_hash !== manifest.manifest_hash)
    refuse(`request ${record.id} approved another run manifest`);
  const expectedPayload = computeApprovalPayloadHash(
    projectTrustBindingPayloadV2(
      manifest.source.input_path,
      manifest.source.content_sha256,
      binding
    )
  );
  if (record.accountability.payloadHash !== expectedPayload)
    refuse(`request ${record.id} payload does not bind this file content and manifest`);

  const member = resolveAccountableHuman(record.decidedBy ?? '', options.memberOptions);
  const accountable = member ? `user:${member.member_id}` : '';
  if (
    !member ||
    member.status !== 'active' ||
    !parseActorRef({ kind: 'human', id: accountable }) ||
    !member.memberships.some(
      (membership) => membership.tenant_slug === tenantSlug && membership.role === 'owner'
    )
  )
    refuse(`decider of request ${record.id} is not an active owner of tenant ${tenantSlug}`);

  const decidedAt = Date.parse(record.decidedAt ?? '');
  if (!Number.isFinite(decidedAt) || decidedAt > now.getTime())
    refuse(`request ${record.id} has no valid decision time`);
  const approvalExpiry = record.expiresAt ? Date.parse(record.expiresAt) : Number.POSITIVE_INFINITY;
  const expiresAt = Math.min(decidedAt + RUN_MANIFEST_CHARTER_MAX_AGE_MS, approvalExpiry);
  if (!(expiresAt > now.getTime())) refuse(`request ${record.id} is older than 90 days`);

  return {
    requestId: record.id,
    accountable,
    tenantSlug,
    manifestHash: manifest.manifest_hash,
    principalModes: [...binding.principal_modes],
    ...(binding.runs_per_day !== undefined ? { runsPerDay: binding.runs_per_day } : {}),
    presentedDigest: record.verifiedPresentedDigest,
    decidedAt: new Date(decidedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}
