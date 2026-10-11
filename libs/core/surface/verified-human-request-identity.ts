/**
 * Strict human request ownership shared by opt-in transport adapters.
 *
 * This is a trusted in-process handoff, NOT token/session verification. The
 * caller must supply issuer + subject only after authenticating its transport.
 * Never construct these inputs from request identity/role fields, a bearer
 * token's unverified claims, or a legacy principalId. No token parser or remote
 * localadmin grant belongs here. Every call rereads the complete member registry.
 */
import { createHash } from 'node:crypto';
import { withExecutionContext } from '../authority.js';
import { isValidTenantSlug } from '../entity-scope.js';
import {
  listMemberIdsStrict,
  readMemberProfile,
  type MemberProfile,
  type MemberRegistryPathOptions,
  type MemberRole,
} from '../organization/member-registry.js';
import type { SurfacePermission } from './surface-authorization.js';
import { narrowSurfaceViewerScope } from './surface-mutation-guard.js';
import type {
  CanonicalHumanRequestIdentity,
  SurfaceViewerScope,
} from './surface-viewer-scope-contract.js';
import {
  canonicalHumanOwner,
  isValidHumanRequestAuthorityNamespace,
  denyVerifiedHumanIdentity,
  denyVerifiedHumanScope,
  isBoundedHumanRequestText,
  normalizeHumanRequestScopeList,
  normalizeHumanRequestScopeIds,
  normalizeHumanRequestTiers,
} from './verified-human-request-contract.js';
export { canonicalHumanOwner } from './verified-human-request-contract.js';

export const HUMAN_REQUEST_READ_SCOPE = 'kyberion:requests:read';
export const HUMAN_REQUEST_RECEIVE_SCOPE = 'kyberion:requests:receive';

export interface VerifiedHumanClaims {
  issuer: string;
  subject: string;
}
export interface HumanRequestServerPolicy {
  /** Stable, server-owned registry deployment namespace, never a client input. */
  authorityNamespace: string;
  tenantSlugs: readonly string[];
  organizationIds: readonly string[] | 'all';
  projectIds: readonly string[] | 'all';
  tierAccess: readonly ('public' | 'confidential')[];
}
export interface HumanRequestNarrowing {
  tenant?: string | null;
  organizationId?: string | null;
  projectId?: string | null;
  tier?: 'public' | 'confidential';
}
export interface VerifiedHumanRequestInput {
  identity: VerifiedHumanClaims;
  policy: HumanRequestServerPolicy;
  /** Verified OAuth operation grants; arbitrary other scopes confer no authority. */
  oauthScopes: readonly string[];
  transport: 'mcp-oauth' | 'browser-session';
  narrowing?: HumanRequestNarrowing;
  memberRegistry?: MemberRegistryPathOptions;
}
export interface VerifiedHumanRequestResolution {
  viewer: SurfaceViewerScope & { canonicalHuman: CanonicalHumanRequestIdentity };
  permissions: readonly SurfacePermission[];
  /** Audit provenance only; deliberately excluded from canonical ownership. */
  transportEvidence: Readonly<
    VerifiedHumanClaims & { transport: VerifiedHumanRequestInput['transport'] }
  >;
}

const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'operator', 'approver', 'viewer'];

function strictMember(
  identity: VerifiedHumanClaims,
  options: MemberRegistryPathOptions
): MemberProfile {
  try {
    // Reuse the governed member-reader context. This assumption authorizes the
    // registry read only; it never becomes the remote viewer's role.
    return withExecutionContext('sovereign_concierge', () => {
      const ids = listMemberIdsStrict(options);
      if (new Set(ids).size !== ids.length) denyVerifiedHumanIdentity();
      const matches: MemberProfile[] = [];
      for (const id of ids) {
        const member = readMemberProfile(id, options);
        // Missing after enumeration is unverifiable, even after a prior match.
        if (!member || member.member_id !== id) denyVerifiedHumanIdentity();
        if (
          member.external_identities?.some(
            (binding) => binding.issuer === identity.issuer && binding.subject === identity.subject
          )
        )
          matches.push(member);
      }
      // Count suspended bindings as matches: active + suspended is ambiguous.
      if (matches.length !== 1 || matches[0].status !== 'active') denyVerifiedHumanIdentity();
      return matches[0];
    });
  } catch {
    denyVerifiedHumanIdentity();
  }
}

function memberships(member: MemberProfile): Map<string, MemberRole> {
  const rows = new Map<string, MemberRole>();
  for (const row of member.memberships) {
    if (
      !isValidTenantSlug(row.tenant_slug) ||
      !MEMBER_ROLES.includes(row.role) ||
      (rows.has(row.tenant_slug) && rows.get(row.tenant_slug) !== row.role)
    )
      denyVerifiedHumanIdentity();
    rows.set(row.tenant_slug, row.role);
  }
  return rows;
}

export function resolveVerifiedHumanRequestIdentity(
  input: VerifiedHumanRequestInput
): VerifiedHumanRequestResolution {
  if (
    !input.identity ||
    !isBoundedHumanRequestText(input.identity.issuer) ||
    !isBoundedHumanRequestText(input.identity.subject) ||
    (input.transport !== 'mcp-oauth' && input.transport !== 'browser-session')
  )
    denyVerifiedHumanIdentity();
  if (!input.policy || !isValidHumanRequestAuthorityNamespace(input.policy.authorityNamespace))
    denyVerifiedHumanScope();
  const serverTenants = normalizeHumanRequestScopeList(input.policy.tenantSlugs, isValidTenantSlug);
  const organizationIds = normalizeHumanRequestScopeIds(input.policy.organizationIds);
  const projectIds = normalizeHumanRequestScopeIds(input.policy.projectIds);
  let tierAccess = normalizeHumanRequestTiers(input.policy.tierAccess);
  if (
    !Array.isArray(input.oauthScopes) ||
    input.oauthScopes.some((scope) => !isBoundedHumanRequestText(scope))
  )
    denyVerifiedHumanScope();

  const member = strictMember(input.identity, input.memberRegistry ?? {});
  const memberRoles = memberships(member);
  const tenantSlugs = serverTenants.filter((tenant) => memberRoles.has(tenant));
  if (!tenantSlugs.length) denyVerifiedHumanScope();
  const narrowed = narrowSurfaceViewerScope(
    { tenantSlugs, organizationIds, projectIds },
    input.narrowing ?? {}
  );
  if (input.narrowing?.tier !== undefined) {
    if (!tierAccess.includes(input.narrowing.tier)) denyVerifiedHumanScope();
    tierAccess = [input.narrowing.tier];
  }
  const canonicalHuman: CanonicalHumanRequestIdentity = Object.freeze({
    version: 1,
    authorityNamespace: input.policy.authorityNamespace,
    memberId: member.member_id,
    membershipFingerprint: createHash('sha256')
      .update(
        JSON.stringify({
          version: 1,
          memberships: [...memberRoles.keys()]
            .sort()
            .map((tenant) => [tenant, memberRoles.get(tenant)]),
        })
      )
      .digest('hex'),
  });
  const viewer: VerifiedHumanRequestResolution['viewer'] = {
    role: 'readonly',
    ...narrowed,
    tierAccess,
    source: 'token',
    principalId: `user:${member.member_id}`,
    memberId: member.member_id,
    canonicalHuman,
  };
  canonicalHumanOwner(viewer);
  const selectedRole =
    narrowed.tenantSlugs !== 'all' && narrowed.tenantSlugs.length === 1
      ? memberRoles.get(narrowed.tenantSlugs[0])
      : undefined;
  const permissions: SurfacePermission[] = [];
  if (input.oauthScopes.includes(HUMAN_REQUEST_READ_SCOPE))
    permissions.push('surface.headless.read');
  if (
    input.oauthScopes.includes(HUMAN_REQUEST_RECEIVE_SCOPE) &&
    (selectedRole === 'owner' || selectedRole === 'operator')
  )
    permissions.push('surface.headless.write');
  for (const values of [
    viewer.tenantSlugs,
    viewer.organizationIds,
    viewer.projectIds,
    viewer.tierAccess,
  ])
    if (Array.isArray(values)) Object.freeze(values);
  return Object.freeze({
    viewer: Object.freeze(viewer),
    permissions: Object.freeze(permissions),
    transportEvidence: Object.freeze({
      transport: input.transport,
      issuer: input.identity.issuer,
      subject: input.identity.subject,
    }),
  });
}

/**
 * Future browser adapters must construct this proof only from a verified
 * browser session. These structural fields are not cryptographic evidence.
 * Existing browser principals do not retain claims.sub, so this slice does not
 * wire the helper into live UI routes or fall back to their raw principalId.
 */
export interface VerifiedBrowserHumanProof extends VerifiedHumanClaims {
  provider: 'browser-session';
  source: 'oidc';
  expiresAt: string;
}
export function resolveVerifiedBrowserHumanRequestIdentity(
  input: Omit<VerifiedHumanRequestInput, 'identity' | 'transport'> & {
    enabled?: boolean;
    proof: VerifiedBrowserHumanProof;
    /** Trusted clock injection for deterministic tests, never a request value. */
    now?: number;
  }
): VerifiedHumanRequestResolution {
  const now = input.now ?? Date.now();
  if (
    input.enabled !== true ||
    input.proof?.provider !== 'browser-session' ||
    input.proof?.source !== 'oidc' ||
    typeof input.proof?.expiresAt !== 'string' ||
    !Number.isFinite(now) ||
    !Number.isFinite(Date.parse(input.proof.expiresAt)) ||
    Date.parse(input.proof.expiresAt) <= now
  )
    denyVerifiedHumanIdentity();
  // oauthScopes here are explicit trusted browser-adapter operation policy,
  // never OAuth grants inferred from browser login scopes or request fields.
  return resolveVerifiedHumanRequestIdentity({
    identity: { issuer: input.proof.issuer, subject: input.proof.subject },
    transport: 'browser-session',
    policy: input.policy,
    oauthScopes: input.oauthScopes,
    narrowing: input.narrowing,
    memberRegistry: input.memberRegistry,
  });
}
