/**
 * Pure validation of a trusted in-process canonical-human ownership marker.
 * This contract does not authenticate a transport or read the member registry.
 */
import { isValidChronosScopeId, isValidMemberId, isValidTenantSlug } from '../foundation/scope.js';
import {
  SurfaceViewerScopeError,
  type CanonicalHumanRequestIdentity,
  type SurfaceViewerScope,
} from './surface-viewer-scope-contract.js';

const HUMAN_REQUEST_AUTHORITY_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

export function isValidHumanRequestAuthorityNamespace(value: unknown): value is string {
  return typeof value === 'string' && HUMAN_REQUEST_AUTHORITY_NAMESPACE_PATTERN.test(value);
}

export function denyVerifiedHumanIdentity(): never {
  // Never expose a registry path, member list, subject, or profile parse error.
  throw new SurfaceViewerScopeError(403, 'Verified human identity denied.');
}
export function denyVerifiedHumanScope(): never {
  throw new SurfaceViewerScopeError(403, 'Verified human request scope denied.');
}
export function isBoundedHumanRequestText(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length <= max && SAFE_TEXT.test(value);
}
export function normalizeHumanRequestScopeList(
  value: unknown,
  valid: (value: string) => boolean
): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((item) => !isBoundedHumanRequestText(item, 256) || !valid(item))
  )
    denyVerifiedHumanScope();
  return [...new Set(value as string[])].sort();
}
export function normalizeHumanRequestScopeIds(value: unknown): string[] | 'all' {
  return value === 'all' ? 'all' : normalizeHumanRequestScopeList(value, isValidChronosScopeId);
}
export function normalizeHumanRequestTiers(value: unknown): ('public' | 'confidential')[] {
  return normalizeHumanRequestScopeList(
    value,
    (tier) => tier === 'public' || tier === 'confidential'
  ) as ('public' | 'confidential')[];
}

/**
 * Validate an opt-in ownership marker, without claiming to authenticate it.
 * Absent markers preserve legacy behavior. Present but malformed markers must
 * never fall back to legacy ownership. Callers still authenticate every request.
 */
export function canonicalHumanOwner(
  viewer: SurfaceViewerScope
): CanonicalHumanRequestIdentity | undefined {
  if (!('canonicalHuman' in viewer)) return undefined;
  const identity = viewer.canonicalHuman;
  if (
    !identity ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    Object.keys(identity).sort().join(',') !==
      'authorityNamespace,memberId,membershipFingerprint,version' ||
    identity.version !== 1 ||
    !isValidHumanRequestAuthorityNamespace(identity.authorityNamespace) ||
    typeof identity.memberId !== 'string' ||
    !isValidMemberId(identity.memberId) ||
    identity.memberId.startsWith('ext-') ||
    typeof identity.membershipFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(identity.membershipFingerprint) ||
    viewer.memberId !== identity.memberId ||
    viewer.principalId !== `user:${identity.memberId}` ||
    viewer.source !== 'token' ||
    viewer.role !== 'readonly'
  )
    denyVerifiedHumanIdentity();
  normalizeHumanRequestScopeList(viewer.tenantSlugs, isValidTenantSlug);
  normalizeHumanRequestScopeIds(viewer.organizationIds);
  normalizeHumanRequestScopeIds(viewer.projectIds);
  normalizeHumanRequestTiers(viewer.tierAccess);
  return Object.freeze({
    version: 1,
    authorityNamespace: identity.authorityNamespace,
    memberId: identity.memberId,
    membershipFingerprint: identity.membershipFingerprint,
  });
}
