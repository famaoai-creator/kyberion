import type { AssetCustody, AssetReadCeiling } from '../contracts/asset-scope.js';
import { KNOWLEDGE_TIERS, type KnowledgeTier } from '../foundation/knowledge-tier.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { resolvePolicyIdentityContext } from '../identity-context-bridge.js';
import { loadAuthorityRoleIndex } from '../organization/authority-role-registry.js';

type CeilingIdentity = Pick<
  ReturnType<typeof resolvePolicyIdentityContext>,
  'tenantSlug' | 'brokeredTenants' | 'role'
>;

/**
 * The tiers a role declares it reads (`tier_access` in the authority role
 * index) plus `public`, which is disclosed to everyone; every tier when the
 * role declares none — tier-guard has no other tier statement for it.
 */
export function declaredReadTiers(
  role: string | undefined,
  roles: () => Record<string, { tier_access?: string[] }> = () => loadAuthorityRoleIndex()
): KnowledgeTier[] {
  const declared = role ? roles()[role]?.tier_access : undefined;
  const tiers = (declared ?? []).filter((tier): tier is KnowledgeTier =>
    (KNOWLEDGE_TIERS as readonly string[]).includes(tier)
  );
  if (tiers.length === 0) return [...KNOWLEDGE_TIERS];
  return KNOWLEDGE_TIERS.filter((tier) => tier === 'public' || tiers.includes(tier));
}

/**
 * G1 (steps 1-2 of `decide`): a read ceiling built from the server-resolved
 * identity — never from request input.
 *
 * 1. Custody: a tenant-bound identity may reach its own tenant, the tenants its
 *    approved broker scope names, and the installation's own system and owner
 *    assets. An identity bound to no tenant has no custody restriction
 *    tier-guard can express today, so it gets no ceiling.
 * 2. Tier: the tiers its authority role declares (`declaredReadTiers`).
 *
 * The ceiling is an upper bound for observation, never a grant.
 */
export function assetReadCeilingFor(
  identity: CeilingIdentity = resolvePolicyIdentityContext(),
  roles?: () => Record<string, { tier_access?: string[] }>
): AssetReadCeiling | undefined {
  const tenant = identity.tenantSlug?.trim();
  if (!tenant || !isValidTenantSlug(tenant)) return undefined;
  const tenants = [tenant, ...(identity.brokeredTenants ?? []).filter(isValidTenantSlug)];
  const custodians: AssetCustody[] = [
    ...[...new Set(tenants)].map((ref) => ({ kind: 'tenant' as const, ref })),
    { kind: 'system', ref: 'installation' },
    { kind: 'person', ref: 'installation-owner' },
  ];
  return { custodians, readTiers: declaredReadTiers(identity.role, roles) };
}
