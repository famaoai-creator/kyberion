import type {
  AssetAddressResolution,
  AssetCustody,
  AssetReadCeiling,
  AssetScopeObservation,
  AssetStoreDeclaration,
} from '../contracts/asset-scope.js';
import { KNOWLEDGE_TIERS, type KnowledgeTier } from './knowledge-tier.js';
import { isValidTenantSlug } from './scope.js';

/** No normalization here: callers must provide the policy layer's canonical relative path. */
function canonicalPath(value: string): boolean {
  return (
    value.length > 0 &&
    !/[\\\u0000-\u001f\u007f:%*?<>$]/u.test(value) &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

function matchTemplate(template: string, target: string): Record<string, string> | undefined {
  const pattern = template.split('/');
  const actual = target.split('/');
  if (actual.length < pattern.length) return;
  const captures: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const part = pattern[index];
    if (/^<[a-z]+>$/u.test(part)) {
      if (captures[part] !== undefined && captures[part] !== actual[index]) return;
      captures[part] = actual[index];
    } else if (part !== actual[index]) return;
  }
  return captures;
}

/**
 * Observe asset scope without reading files, env, identity or issuing permissions.
 * Planned locations may be inspected before a migration, but stay marked planned.
 * Mixed legacy roots are intentionally unresolved until a precise binding exists.
 */
export function resolveAssetAddress(
  relativePath: string,
  stores: readonly AssetStoreDeclaration[]
): AssetAddressResolution {
  const unresolved = (
    reason: Extract<AssetAddressResolution, { status: 'unresolved' }>['reason'],
    ids: readonly string[] = []
  ): AssetAddressResolution => ({ status: 'unresolved', reason, stores: [...ids].sort() });
  if (!canonicalPath(relativePath)) return unresolved('invalid_path');
  const matches = stores.flatMap((store) => {
    const captures = matchTemplate(store.path, relativePath);
    return captures ? [{ store, captures, depth: store.path.split('/').length }] : [];
  });
  if (matches.length === 0) return unresolved('unknown_store');
  const depth = Math.max(...matches.map((match) => match.depth));
  const best = matches.filter((match) => match.depth === depth);
  if (best.length !== 1)
    return unresolved(
      'ambiguous_store',
      best.map(({ store }) => store.id)
    );
  const { store, captures } = best[0];
  const ids = [store.id];
  const tenant = captures['<tenant>'];
  if (tenant && tenant !== 'shared' && !isValidTenantSlug(tenant))
    return unresolved('invalid_partition', ids);

  let custody: AssetCustody;
  if (store.custody.kind === 'tenant') {
    if (tenant === 'shared' && store.custody.shared_segment === 'system')
      custody = { kind: 'system', ref: 'installation' };
    else if (tenant && isValidTenantSlug(tenant) && store.custody.ref === '<tenant>')
      custody = { kind: 'tenant', ref: tenant };
    else return unresolved('custody_unresolved', ids);
  } else if (store.custody.kind === 'person' || store.custody.kind === 'system') {
    const ref = store.custody.ref;
    if (ref && /^<[a-z]+>$/u.test(ref)) return unresolved('custody_unresolved', ids);
    if (store.custody.kind === 'person' && !ref) return unresolved('custody_unresolved', ids);
    custody = { kind: store.custody.kind, ref: ref ?? 'installation' };
  } else return unresolved('custody_unresolved', ids);

  const capturedTier = captures['<tier>'];
  const pathTier = relativePath.startsWith('knowledge/') ? relativePath.split('/')[1] : undefined;
  const tier =
    capturedTier ??
    (KNOWLEDGE_TIERS.includes(pathTier as KnowledgeTier)
      ? pathTier
      : store.tiers?.length === 1
        ? store.tiers[0]
        : undefined);
  if (
    !KNOWLEDGE_TIERS.includes(tier as KnowledgeTier) ||
    (store.tiers && !store.tiers.includes(tier as KnowledgeTier))
  )
    return unresolved('tier_unresolved', ids);
  return {
    status: 'resolved',
    address: {
      path: relativePath,
      store: store.id,
      location: store.status,
      ...(store.moves_to ? { movesTo: store.moves_to } : {}),
      custody,
      tier: tier as KnowledgeTier,
    },
  };
}

/** Scope ceiling only: an allow here is never an authorization decision. */
export function observeAssetReadCeiling(
  address: Extract<AssetAddressResolution, { status: 'resolved' }>['address'],
  ceiling: AssetReadCeiling
): AssetScopeObservation {
  if (address.location === 'planned') return { allowed: false, reason: 'planned_location' };
  if (
    !ceiling.custodians.some(
      ({ kind, ref }) => kind === address.custody.kind && ref === address.custody.ref
    )
  )
    return { allowed: false, reason: 'custody_denied' };
  if (!ceiling.readTiers.includes(address.tier)) return { allowed: false, reason: 'tier_denied' };
  return { allowed: true, reason: 'within_ceiling' };
}
