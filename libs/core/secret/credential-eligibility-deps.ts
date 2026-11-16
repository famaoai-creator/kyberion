/**
 * Registry-backed lookups of the credential lending eligibility rule
 * (credential-custody.ts `assessCredentialEligibility`, design §2.3, review B1/S1).
 *
 * - A tenant is a person's own tenant only through its explicit
 *   `personal_owner` (organization/tenant-personal-owner.ts, owner-approved
 *   and audited). Member-registry `owner` memberships and `assigned_role` are
 *   bootstrapped for every tenant and do NOT count.
 * - Person custody means the installation person who owns `knowledge/personal/`
 *   (the owner member, `ownerAccountableHumanId`).
 * - The borrower's data consent is its provider attestation, resolved with the
 *   egress gate's own expiry rule (`resolveTenantProviderAttestation`).
 * - `isTenantOwnerMember` (member registry) only decides who may approve
 *   lending of / register a TENANT-custody credential.
 *
 * Every lookup fails closed.
 */
import { withStoreGrant } from '../authority.js';
import { ownerAccountableHumanId, readMemberProfile } from '../organization/member-registry.js';
import { readTenantProfile } from '../organization/tenant-registry.js';
import { resolveTenantProviderAttestation } from '../provider/provider-egress-gate.js';
import { memberIdOfPrincipal, type CredentialEligibilityDeps } from './credential-custody.js';
import { verifyTenantPersonalOwnerBasis } from './credential-custody-approval.js';

/**
 * The member's role in one tenant, through the dedicated read-only store grant
 * `member_owner_reader` (security-policy store_grants). Only `{member, tenant,
 * role}` leaves this function — never the member record. Unreadable = no role
 * (fail closed).
 */
export function lookupMemberTenantRole(
  memberId: string,
  tenant: string
): { member: string; tenant: string; role: string } | undefined {
  try {
    const role = withStoreGrant('member_owner_reader', () => {
      const profile = readMemberProfile(memberId);
      if (!profile || profile.status !== 'active') return undefined;
      return profile.memberships.find((entry) => entry.tenant_slug === tenant)?.role;
    });
    return role ? { member: memberId, tenant, role } : undefined;
  } catch {
    return undefined;
  }
}

function membershipRole(memberId: string, tenant: string): string | undefined {
  return lookupMemberTenantRole(memberId, tenant)?.role;
}

function tenantProfile(tenant: string) {
  try {
    return withStoreGrant('workspace_tenant_registry_reader', () => readTenantProfile(tenant), {
      tenantSlug: tenant,
    });
  } catch {
    return null;
  }
}

/** Owner member of a tenant (approver of that tenant's credentials). */
export function isTenantOwnerMember(memberId: string, tenant: string): boolean {
  return membershipRole(memberId, tenant) === 'owner';
}

export const defaultCredentialEligibilityDeps: CredentialEligibilityDeps = {
  personalOwnerOf(tenant) {
    const profile = tenantProfile(tenant);
    if (profile?.status !== 'active' || !profile.personal_owner) return undefined;
    // Review 1: a hand-edited field without its consumed approval counts for nothing.
    return verifyTenantPersonalOwnerBasis(
      tenant,
      profile.personal_owner,
      profile.personal_owner_basis
    )
      ? profile.personal_owner
      : undefined;
  },
  installationPerson() {
    return memberIdOfPrincipal(ownerAccountableHumanId());
  },
  borrowerAttested(tenant, egressProvider, now) {
    const profile = tenantProfile(tenant);
    if (!profile || profile.status !== 'active') return false;
    return (
      resolveTenantProviderAttestation({ profile, provider: egressProvider, now }).status ===
      'valid'
    );
  },
};
