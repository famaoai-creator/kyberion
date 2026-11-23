/**
 * Scope lineage for offboarding: which tenant / organization / project a
 * mission tree or project workspace belongs to. Split out of
 * scope-offboarding.ts (size gate); pure reads, no deletion.
 */

import * as path from 'node:path';
import * as pathResolver from '../path-resolver.js';
import { safeExistsSync, safeStat } from '../secure-io.js';
import { STORAGE_DATA_TIERS } from '../storage-layout.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { loadMissionStateAtPath } from '../mission/mission-state-reader.js';
import type { MissionState } from '../mission/mission-types.js';
import { repoRelativePosix } from './storage-janitor.js';
import {
  listDirEntries,
  readJsonRecord,
  safeOptionalRepositoryPath,
} from './scope-offboarding-files.js';
import type { OffboardTarget, PhysicalNamespaceFilter } from './scope-offboarding.js';

export function missionStateScope(missionDir: string): {
  tenantSlug?: string;
  organizationId?: string;
  projectId?: string;
} {
  const record = loadMissionStateAtPath(path.join(missionDir, 'mission-state.json')) as
    | (MissionState & {
        organization_profile?: { organization_id?: unknown };
      })
    | null;
  if (!record) return {};
  const organizationProfile = record.organization_profile;
  return {
    tenantSlug: record.tenant_slug,
    organizationId:
      record.organization_id ||
      record.relationships?.organization?.organization_id ||
      (typeof organizationProfile?.organization_id === 'string'
        ? organizationProfile.organization_id
        : undefined),
    projectId: record.relationships?.project?.project_id,
  };
}

/**
 * Every mission directory under `active/missions` (or, with `archived`,
 * `active/archive/missions`): the flat `<tier>/<id>` form and the
 * tenant-partitioned `<tier>/<tenant>/<id>` form (path-resolver
 * `tenantMissionDir`). A tier entry holding its own `mission-state.json` is a
 * flat mission; otherwise an entry named like a tenant slug is a tenant
 * partition whose children are missions. `isValidTenantSlug` rejects every
 * `RESERVED_SCOPE_NAMES` entry (`shared`, the tier names), so a reserved
 * directory is never read as a tenant partition.
 */
export function listMissionDirs(
  options: { archived?: boolean } = {}
): Array<{ missionDir: string; tenantPartition?: string }> {
  const found: Array<{ missionDir: string; tenantPartition?: string }> = [];
  const isDirectory = (candidate: string): boolean => {
    try {
      return safeStat(candidate).isDirectory();
    } catch {
      return false;
    }
  };
  const missionsRoot = path.join(
    pathResolver.rootDir(),
    ...(options.archived ? ['active', 'archive', 'missions'] : ['active', 'missions'])
  );
  for (const tier of STORAGE_DATA_TIERS) {
    const tierDir = path.join(missionsRoot, tier);
    for (const name of listDirEntries(tierDir)) {
      const entryDir = safeOptionalRepositoryPath(path.join(tierDir, name));
      if (!entryDir || !isDirectory(entryDir)) continue;
      if (safeExistsSync(path.join(entryDir, 'mission-state.json')) || !isValidTenantSlug(name)) {
        found.push({ missionDir: entryDir });
        continue;
      }
      for (const child of listDirEntries(entryDir)) {
        const missionDir = safeOptionalRepositoryPath(path.join(entryDir, child));
        if (missionDir && isDirectory(missionDir)) {
          found.push({ missionDir, tenantPartition: name });
        }
      }
    }
  }
  return found;
}

/** Mission lineage; a tenant-nested mission's partition is its tenant when the state omits it. */
export function missionScopeOf(
  missionDir: string,
  tenantPartition?: string
): ReturnType<typeof missionStateScope> {
  const scope = missionStateScope(missionDir);
  return tenantPartition && !scope.tenantSlug ? { ...scope, tenantSlug: tenantPartition } : scope;
}

/** The project registry record's lineage, or undefined when no record exists. */
export function projectRecordLineage(
  projectId: string
): { tenantSlug?: string; organizationId?: string } | undefined {
  const record = readJsonRecord(
    pathResolver.rootResolve(`active/shared/runtime/projects/${projectId}.json`)
  );
  if (!record) return undefined;
  return {
    tenantSlug: typeof record?.tenant_slug === 'string' ? record.tenant_slug : undefined,
    organizationId:
      typeof record?.organization_id === 'string' ? record.organization_id : undefined,
  };
}

function projectRecordScope(projectId: string): {
  tenantSlug?: string;
  organizationId?: string;
} {
  return projectRecordLineage(projectId) ?? {};
}

export function lineageMatches(
  lineage: { tenantSlug?: string; organizationId?: string },
  filter: PhysicalNamespaceFilter
): boolean {
  if (filter.tenantSlug && lineage.tenantSlug !== filter.tenantSlug) return false;
  if (filter.organizationId && lineage.organizationId !== filter.organizationId) return false;
  return true;
}

/**
 * Resolve the lineage of a project workspace.
 *
 * New workspaces use `active/projects/{tier}/{tenant}/{project}`. The direct
 * `active/projects/{tier}/{project}` form is legacy and can only be scoped by
 * the project registry record; when that record is absent, a tenant/org
 * filtered offboarding must leave the directory untouched.
 */
function projectWorkspaceLineage(
  workspace: string,
  projectId: string,
  tierDir: string
): { tenantSlug?: string; organizationId?: string } {
  const segments = path.relative(tierDir, workspace).split(path.sep).filter(Boolean);
  const recordScope = projectRecordScope(projectId);
  const operationalState = readJsonRecord(path.join(workspace, 'state', 'project-state.json'));
  const tenantSlug =
    typeof operationalState?.tenant_slug === 'string'
      ? operationalState.tenant_slug
      : segments.length >= 2 && segments[0] !== 'shared'
        ? segments[0]
        : recordScope.tenantSlug;
  const organizationId =
    typeof operationalState?.organization_id === 'string'
      ? operationalState.organization_id
      : recordScope.organizationId;
  if (segments.length < 2) return { tenantSlug, organizationId };
  return {
    tenantSlug,
    organizationId,
  };
}

export function collectProjectWorkspaceTargets(
  projectId: string,
  filter: PhysicalNamespaceFilter
): Array<{ target: OffboardTarget; lineage: { tenantSlug?: string; organizationId?: string } }> {
  const candidates: Array<{
    target: OffboardTarget;
    lineage: { tenantSlug?: string; organizationId?: string };
  }> = [];
  for (const tier of STORAGE_DATA_TIERS) {
    const tierDir = path.join(pathResolver.rootDir(), 'active', 'projects', tier);
    for (const owner of listDirEntries(tierDir)) {
      const ownerDir = safeOptionalRepositoryPath(path.join(tierDir, owner));
      if (!ownerDir) continue;
      try {
        if (!safeStat(ownerDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const candidate = safeOptionalRepositoryPath(
        owner === projectId ? ownerDir : path.join(ownerDir, projectId)
      );
      if (!candidate || !safeExistsSync(candidate)) continue;
      try {
        if (!safeStat(candidate).isDirectory()) continue;
      } catch {
        continue;
      }
      const lineage = projectWorkspaceLineage(candidate, projectId, tierDir);
      if (lineageMatches(lineage, filter)) {
        candidates.push({
          target: { path: repoRelativePosix(candidate), kind: 'project_tree' },
          lineage,
        });
      }
    }
  }
  return candidates;
}
