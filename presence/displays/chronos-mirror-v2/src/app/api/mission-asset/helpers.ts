import { findMissionPath, pathResolver } from '@agent/core/path-resolver';
import { loadState } from '@agent/core/mission/mission-state';
import { classifyStorageFloorPath } from '@agent/core/storage-layout';
import { inferDeliverableTier } from '../../../lib/deliverable-inbox';

export type AssetTier = 'personal' | 'confidential' | 'public';

function normalizeAssetPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, '/');
  const root = pathResolver.rootDir().replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

/**
 * Tier/tenant of a storage-layout floor path (artifacts, and the tmp floor the
 * route still serves): the system partition carries public, tenant-free data;
 * tier partitions carry their own tier and tenant, which then bind the request
 * like a project path does. Legacy unpartitioned paths return undefined.
 */
function floorPartition(
  normalized: string | undefined
): { tier: AssetTier; tenant?: string } | undefined {
  if (!normalized) return undefined;
  const floor = classifyStorageFloorPath(normalized);
  if (!floor) return undefined;
  if (floor.partition.kind === 'system') return { tier: 'public' };
  if (floor.partition.kind === 'tier') {
    return { tier: floor.partition.tier, tenant: floor.partition.tenant };
  }
  return undefined;
}

function tierFromPath(value: string | undefined): AssetTier | undefined {
  const normalized = normalizeAssetPath(value);
  const partition = floorPartition(normalized);
  if (partition) return partition.tier;
  const match = normalized?.match(
    /(?:^|\/)active\/(?:missions|projects)\/(personal|confidential|public)(?:\/|$)/
  );
  return match?.[1] as AssetTier | undefined;
}

export function tenantFromPath(value: string | undefined): string | undefined {
  const normalized = normalizeAssetPath(value);
  const partition = floorPartition(normalized);
  if (partition) return partition.tenant;
  const match = normalized?.match(
    /^active\/(?:missions|projects)\/(?:personal|confidential|public)\/([^/]+)\//
  );
  return match?.[1] && match[1] !== 'shared' ? match[1] : undefined;
}

function missionTier(missionId: string): AssetTier | undefined {
  const missionPath = findMissionPath(missionId);
  if (!missionPath) return undefined;
  try {
    const state = loadState(missionId);
    if (state?.tier === 'personal' || state?.tier === 'confidential' || state?.tier === 'public') {
      return state.tier;
    }
  } catch {
    // Fall back to the governed mission directory shape below.
  }
  return tierFromPath(missionPath);
}

export function artifactTenant(artifact: {
  tenant_slug?: string;
  mission_id?: string;
}): string | undefined {
  if (artifact.tenant_slug) return artifact.tenant_slug;
  if (!artifact.mission_id) return undefined;
  const missionPath = findMissionPath(artifact.mission_id);
  if (!missionPath) return undefined;
  try {
    const state = loadState(artifact.mission_id);
    return state?.tenant_slug || state?.tenant_id;
  } catch {
    return undefined;
  }
}

export function resolveMissionAssetTier(input: {
  artifact?: Parameters<typeof inferDeliverableTier>[0];
  assetPath?: string;
  missionId?: string;
}): AssetTier | undefined {
  const resolvedMissionTier = input.missionId ? missionTier(input.missionId) : undefined;
  const pathTier = tierFromPath(input.assetPath);
  if (resolvedMissionTier || pathTier) return resolvedMissionTier || pathTier;
  return inferDeliverableTier(
    input.artifact || { kind: '', storage_class: 'external_ref', artifact_id: '' },
    normalizeAssetPath(input.artifact?.path),
    undefined
  );
}

export function resolveMissionAssetTenant(input: {
  artifact?: Parameters<typeof inferDeliverableTier>[0];
  assetPath?: string;
  missionId?: string;
}): string | undefined {
  return (
    tenantFromPath(input.assetPath) ||
    (input.artifact ? artifactTenant(input.artifact) : undefined) ||
    (input.missionId ? artifactTenant({ mission_id: input.missionId }) : undefined)
  );
}
