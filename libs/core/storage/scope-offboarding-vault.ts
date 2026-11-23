/**
 * Data-vault attribution for offboarding (C-OFF-014): which
 * `active/shared/data-vault/*.json` entries belong to a tenant or project.
 * Split out of scope-offboarding.ts (size gate).
 */

import * as path from 'node:path';
import * as pathResolver from '../path-resolver.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { repoRelativePosix } from './storage-janitor.js';
import { listDirEntries, readJsonRecord } from './scope-offboarding-files.js';
import {
  collectProjectWorkspaceTargets,
  listMissionDirs,
  missionScopeOf,
  projectRecordLineage,
} from './scope-offboarding-lineage.js';
import type {
  OffboardScopeType,
  OffboardTarget,
  PhysicalNamespaceFilter,
} from './scope-offboarding.js';

/**
 * Tenant a data-vault entry was cached for, read from what the entry model
 * carries. `VaultEntry` has no tenant/org field (data-vault.ts rejects
 * unknown fields); the only tenant attribution is the key a tenant-admitted
 * service call writes (service-engine `executeServicePresetCached`:
 * `<tenant>:<projectId>:<bindingId>:<cacheKey>`). Any other key is unscoped.
 */
function dataVaultEntryTenant(record: Record<string, unknown>): string | undefined {
  if (typeof record.key !== 'string' || typeof record.projectId !== 'string') return undefined;
  const segments = record.key.split(':');
  if (segments.length < 4 || segments[1] !== record.projectId) return undefined;
  return isValidTenantSlug(segments[0]) ? segments[0] : undefined;
}

const lineageKey = (lineage: { tenantSlug?: string; organizationId?: string }): string =>
  `${lineage.tenantSlug || 'unknown'}/${lineage.organizationId || 'unknown'}`;

/**
 * Every tenant/org lineage under which a project id is known: project
 * workspaces, active and archived missions, and the project registry record.
 */
function knownProjectLineages(projectId: string): Set<string> {
  const lineages = new Set(
    collectProjectWorkspaceTargets(projectId, {}).map(({ lineage }) => lineageKey(lineage))
  );
  for (const archived of [false, true]) {
    for (const { missionDir, tenantPartition } of listMissionDirs({ archived })) {
      const scope = missionScopeOf(missionDir, tenantPartition);
      if (scope.projectId === projectId) lineages.add(lineageKey(scope));
    }
  }
  const record = projectRecordLineage(projectId);
  if (record) lineages.add(lineageKey(record));
  return lineages;
}

function ambiguousVaultEntry(name: string, why: string): Error {
  return new Error(
    `[PROJECT_DATA_VAULT_AMBIGUOUS] data-vault entry '${name}' ${why} — refusing to attribute it | next: run with tenantSlug and organizationId, or invalidate the entry (invalidateVaultEntry) / let it expire, then rerun the offboarding | evidence: active/shared/data-vault/${name}`
  );
}

/**
 * Data-vault entry files (`active/shared/data-vault/*.json`) of the scope.
 *
 * - Tenant: entries whose projectId is the tenant slug, plus entries the
 *   tenant cached under its project ids through an admitted binding (key
 *   prefix, see {@link dataVaultEntryTenant}).
 * - Project with a tenant/org filter: an admitted entry is claimed when its
 *   key tenant is the filter's (a project id is unique inside a tenant, so
 *   tenant + projectId identifies the project). An unscoped entry is claimed
 *   only when the filter's lineage is POSITIVELY known for the project id
 *   (workspace, active/archived mission, or registry record) and is the only
 *   known lineage; otherwise it fails closed rather than exporting and
 *   deleting a cache entry that may be another tenant's.
 * - Project without a filter: refused when the admitted entries' key tenants
 *   name more than one tenant, or a tenant other than a known lineage's.
 */
export function collectDataVaultEntryTargets(
  scopeType: OffboardScopeType,
  scopeId: string,
  filter: PhysicalNamespaceFilter
): OffboardTarget[] {
  const targets: OffboardTarget[] = [];
  const vaultDir = pathResolver.shared('data-vault');
  const filtered = Boolean(filter.tenantSlug || filter.organizationId);
  const entryTenants = new Map<string, string>();
  let known: Set<string> | undefined;
  const knownLineages = (): Set<string> => (known ??= knownProjectLineages(scopeId));
  for (const name of listDirEntries(vaultDir)) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(vaultDir, name);
    const record = readJsonRecord(filePath);
    if (!record) continue;
    const entryTenant = dataVaultEntryTenant(record);
    if (scopeType === 'tenant') {
      if (record.projectId !== scopeId && entryTenant !== scopeId) continue;
    } else {
      if (record.projectId !== scopeId) continue;
      if (filtered) {
        if (entryTenant) {
          if (entryTenant !== filter.tenantSlug) continue;
        } else {
          const lineages = knownLineages();
          const wanted = lineageKey(filter);
          if (lineages.size !== 1 || !lineages.has(wanted)) {
            const others = [...lineages].filter((lineage) => lineage !== wanted);
            throw ambiguousVaultEntry(
              name,
              others.length > 0
                ? `carries no tenant and project '${scopeId}' is also known under ${others.join(', ')}`
                : `carries no tenant and project '${scopeId}' has no known ${wanted} lineage`
            );
          }
        }
      } else if (entryTenant) {
        entryTenants.set(entryTenant, name);
      }
    }
    targets.push({ path: repoRelativePosix(filePath), kind: 'data_vault_entry' });
  }
  if (scopeType === 'project' && !filtered && entryTenants.size > 0) {
    const [[firstTenant, firstName]] = [...entryTenants];
    if (entryTenants.size > 1) {
      throw ambiguousVaultEntry(
        firstName,
        `is one of project '${scopeId}' entries cached for several tenants (${[...entryTenants.keys()].join(', ')})`
      );
    }
    const knownTenants = [...knownLineages()]
      .map((lineage) => lineage.split('/')[0])
      .filter((tenant) => tenant !== 'unknown' && tenant !== firstTenant);
    if (knownTenants.length > 0) {
      throw ambiguousVaultEntry(
        firstName,
        `was cached for tenant '${firstTenant}' but project '${scopeId}' is known under ${knownTenants.join(', ')}`
      );
    }
  }
  return targets;
}
