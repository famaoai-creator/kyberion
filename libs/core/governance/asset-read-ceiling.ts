import type { AssetCustody, AssetReadCeiling } from '../contracts/asset-scope.js';
import { KNOWLEDGE_TIERS } from '../foundation/knowledge-tier.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { resolvePolicyIdentityContext } from '../identity-context-bridge.js';

/**
 * G1 (step 1 of `decide`): the custody part of a read ceiling, built from the
 * server-resolved identity — never from request input. A tenant-bound identity
 * may reach its own tenant, the tenants its approved broker scope names, and
 * the installation's own system and owner assets. An identity bound to no
 * tenant has no custody restriction tier-guard can express today, so it gets
 * no ceiling (the comparison reports the address only).
 *
 * Tiers are not narrowed here: the tier ceiling (step 2) is compared separately.
 * The ceiling is an upper bound for observation, never a grant.
 */
export function assetReadCeilingFor(
  identity: Pick<
    ReturnType<typeof resolvePolicyIdentityContext>,
    'tenantSlug' | 'brokeredTenants'
  > = resolvePolicyIdentityContext()
): AssetReadCeiling | undefined {
  const tenant = identity.tenantSlug?.trim();
  if (!tenant || !isValidTenantSlug(tenant)) return undefined;
  const tenants = [tenant, ...(identity.brokeredTenants ?? []).filter(isValidTenantSlug)];
  const custodians: AssetCustody[] = [
    ...[...new Set(tenants)].map((ref) => ({ kind: 'tenant' as const, ref })),
    { kind: 'system', ref: 'installation' },
    { kind: 'person', ref: 'installation-owner' },
  ];
  return { custodians, readTiers: [...KNOWLEDGE_TIERS] };
}
