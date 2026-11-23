/**
 * Service-preset cache subtrees of an offboarding scope (C-OFF-014). The
 * cache sits on the tier/tenant-partitioned cache floor, so ownership follows
 * from the path — no entry is opened or attributed by its content.
 * Split out of scope-offboarding.ts (size gate).
 */

import * as pathResolver from '../path-resolver.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { safeExistsSync } from '../secure-io.js';
import { safeOptionalRepositoryPath } from './scope-offboarding-files.js';
import { STORAGE_DATA_TIERS, SYSTEM_PARTITION_SEGMENT } from '../storage-layout.js';
import {
  servicePresetCachePartitionRoot,
  servicePresetCacheProjectRoot,
} from './service-preset-cache.js';
import type {
  OffboardScopeType,
  OffboardTarget,
  PhysicalNamespaceFilter,
} from './scope-offboarding.js';

/** A tenant segment of a floor partition (never `shared`, `system` or a tier name). */
function isPartitionTenant(value: string): boolean {
  return isValidTenantSlug(value) && value !== SYSTEM_PARTITION_SEGMENT;
}

function present(subtree: string): boolean {
  const subtreePath = safeOptionalRepositoryPath(pathResolver.rootResolve(subtree));
  if (!subtreePath) return false;
  try {
    return safeExistsSync(subtreePath);
  } catch {
    // A subtree this process cannot even probe is listed (fail loud: its
    // removal then fails visibly) rather than silently skipped.
    return true;
  }
}

/**
 * - Tenant: `active/shared/cache/<tier>/<tenant>/service-preset/` of every tier.
 * - Project with a tenant filter: `…/<tier>/<tenant>/service-preset/project/<id>/`
 *   — only that tenant's partition, never another tenant's.
 * - Project without a filter: the untenanted `…/<tier>/shared/service-preset/project/<id>/`.
 */
export function collectServicePresetCacheTargets(
  scopeType: OffboardScopeType,
  scopeId: string,
  filter: PhysicalNamespaceFilter
): OffboardTarget[] {
  const tenant = scopeType === 'tenant' ? scopeId : filter.tenantSlug;
  if (tenant !== undefined && !isPartitionTenant(tenant)) return [];
  const targets: OffboardTarget[] = [];
  for (const tier of STORAGE_DATA_TIERS) {
    let subtree: string;
    try {
      subtree =
        scopeType === 'tenant'
          ? servicePresetCachePartitionRoot(tier, tenant)
          : servicePresetCacheProjectRoot(tier, tenant, scopeId);
    } catch {
      // Not a valid floor segment, so the cache can never have written it.
      continue;
    }
    if (present(subtree)) targets.push({ path: subtree, kind: 'service_preset_cache_tree' });
  }
  return targets;
}
