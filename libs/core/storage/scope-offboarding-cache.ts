/**
 * Service-preset cache subtrees of an offboarding scope (C-OFF-014). The
 * cache sits on the tier/tenant-partitioned cache floor, so ownership follows
 * from the path — no cache-floor entry is opened or attributed by its content.
 * The one content-based claim left is the LEGACY flat data vault (below).
 * Split out of scope-offboarding.ts (size gate).
 */

import * as path from 'node:path';
import * as pathResolver from '../path-resolver.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { safeExistsSync } from '../secure-io.js';
import {
  STORAGE_DATA_TIERS,
  STORAGE_FLOOR_ROOTS,
  SYSTEM_PARTITION_SEGMENT,
} from '../storage-layout.js';
import { repoRelativePosix } from './storage-janitor.js';
import {
  listDirEntries,
  readJsonRecord,
  safeOptionalRepositoryPath,
} from './scope-offboarding-files.js';
import {
  collectProjectWorkspaceTargets,
  listMissionDirs,
  missionScopeOf,
  projectRecordLineage,
} from './scope-offboarding-lineage.js';
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
 * Tenants under which a project id is known: project workspaces, active and
 * archived missions, and the project registry record (untenanted lineages
 * contribute nothing).
 */
function knownProjectTenants(projectId: string): Set<string> {
  const tenants = new Set<string>();
  const add = (tenant: string | undefined) => {
    if (tenant && isPartitionTenant(tenant)) tenants.add(tenant);
  };
  for (const { lineage } of collectProjectWorkspaceTargets(projectId, {})) add(lineage.tenantSlug);
  for (const archived of [false, true]) {
    for (const { missionDir, tenantPartition } of listMissionDirs({ archived })) {
      const scope = missionScopeOf(missionDir, tenantPartition);
      if (scope.projectId === projectId) add(scope.tenantSlug);
    }
  }
  add(projectRecordLineage(projectId)?.tenantSlug);
  return tenants;
}

/** Tenant partitions (any tier) that hold a service-preset subtree of the project. */
function tenantPartitionsHoldingProject(projectId: string): string[] {
  const tenants = new Set<string>();
  for (const tier of STORAGE_DATA_TIERS) {
    const tierDir = pathResolver.rootResolve(`${STORAGE_FLOOR_ROOTS.cache}/${tier}`);
    for (const name of listDirEntries(tierDir)) {
      if (!isPartitionTenant(name)) continue;
      if (present(servicePresetCacheProjectRoot(tier, name, projectId))) tenants.add(name);
    }
  }
  return [...tenants];
}

/**
 * Tenant whose data an UNFILTERED project offboarding claims: the single
 * tenant the project's lineage resolves to. When `holding` (tenants that hold
 * data of the project) is non-empty but the lineage is not exactly one tenant,
 * refuse rather than leave (or guess) another tenant's data.
 */
function unfilteredProjectTenant(
  projectId: string,
  holding: readonly string[],
  evidence: string
): string | undefined {
  if (holding.length === 0) return undefined;
  const known = [...knownProjectTenants(projectId)];
  if (known.length === 1) return known[0];
  const lineage = known.length === 0 ? 'no tenant' : `several tenants (${known.join(', ')})`;
  throw new Error(
    `[PROJECT_SERVICE_PRESET_CACHE_AMBIGUOUS] project '${projectId}' has service-preset cache data of tenant(s) ${holding.join(', ')} but its lineage resolves to ${lineage} | next: rerun the project offboarding with tenantSlug and organizationId | evidence: ${evidence}`
  );
}

/**
 * - Tenant: `active/shared/cache/<tier>/<tenant>/service-preset/` of every tier.
 * - Project with a tenant filter: `…/<tier>/<tenant>/service-preset/project/<id>/`
 *   — only that tenant's partition, never another tenant's.
 * - Project without a filter: the untenanted `…/<tier>/shared/…/project/<id>/`,
 *   plus the single lineage tenant's subtree (see {@link unfilteredProjectTenant}).
 */
export function collectServicePresetCacheTargets(
  scopeType: OffboardScopeType,
  scopeId: string,
  filter: PhysicalNamespaceFilter
): OffboardTarget[] {
  let subtrees: string[];
  if (scopeType === 'tenant') {
    if (!isPartitionTenant(scopeId)) return [];
    subtrees = STORAGE_DATA_TIERS.map((tier) => servicePresetCachePartitionRoot(tier, scopeId));
  } else if (filter.tenantSlug) {
    if (!isPartitionTenant(filter.tenantSlug)) return [];
    const tenant = filter.tenantSlug;
    subtrees = STORAGE_DATA_TIERS.map((tier) =>
      servicePresetCacheProjectRoot(tier, tenant, scopeId)
    );
  } else {
    const tenant = unfilteredProjectTenant(
      scopeId,
      tenantPartitionsHoldingProject(scopeId),
      `${STORAGE_FLOOR_ROOTS.cache}/<tier>/<tenant>/service-preset/project/`
    );
    subtrees = [...(tenant ? [tenant] : []), undefined].flatMap((partition) =>
      STORAGE_DATA_TIERS.map((tier) => servicePresetCacheProjectRoot(tier, partition, scopeId))
    );
  }
  return subtrees
    .filter(present)
    .map((subtree) => ({ path: subtree, kind: 'service_preset_cache_tree' as const }));
}

/**
 * LEGACY — remove with the `active/shared/data-vault` retention entry and the
 * janitor's `scanLegacyDataVault`. Until the flat vault's leftovers expire,
 * offboarding still claims the entries a tenant-admitted service call wrote
 * there: their key is `<tenant>:<projectId>:<bindingId>:<cacheKey>` with
 * `<projectId>` equal to the entry's projectId. Unadmitted entries are shared
 * by definition and never claimed (the earlier projectId == tenant heuristic
 * is dropped deliberately).
 *
 * - Tenant: the tenant's admitted entries.
 * - Project with a tenant filter: the filter tenant's entries of the project.
 * - Project without a filter: the single lineage tenant's entries of the
 *   project; fails closed like the cache when that tenant is not unique.
 */
export function collectLegacyDataVaultTargets(
  scopeType: OffboardScopeType,
  scopeId: string,
  filter: PhysicalNamespaceFilter = {}
): OffboardTarget[] {
  const vaultDir = pathResolver.rootResolve('active/shared/data-vault');
  const admitted: Array<{ tenant: string; projectId: string; path: string }> = [];
  for (const name of listDirEntries(vaultDir)) {
    if (!name.endsWith('.json')) continue;
    const filePath = safeOptionalRepositoryPath(path.join(vaultDir, name));
    if (!filePath) continue;
    const record = readJsonRecord(filePath);
    if (typeof record?.key !== 'string' || typeof record.projectId !== 'string') continue;
    const [tenant, projectId, ...rest] = record.key.split(':');
    if (rest.length < 2 || projectId !== record.projectId || !isPartitionTenant(tenant ?? '')) {
      continue;
    }
    admitted.push({ tenant: tenant!, projectId, path: repoRelativePosix(filePath) });
  }
  let wanted: (entry: { tenant: string; projectId: string }) => boolean;
  if (scopeType === 'tenant') {
    wanted = (entry) => entry.tenant === scopeId;
  } else {
    const ofProject = admitted.filter((entry) => entry.projectId === scopeId);
    const tenant =
      filter.tenantSlug ??
      unfilteredProjectTenant(
        scopeId,
        [...new Set(ofProject.map((entry) => entry.tenant))],
        'active/shared/data-vault/'
      );
    wanted = (entry) => entry.projectId === scopeId && entry.tenant === tenant;
  }
  return admitted
    .filter(wanted)
    .map((entry) => ({ path: entry.path, kind: 'legacy_data_vault_entry' as const }));
}
