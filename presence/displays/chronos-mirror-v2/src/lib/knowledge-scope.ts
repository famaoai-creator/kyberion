import { findMissionPath } from '@agent/core/path-resolver';
import { loadState } from '@agent/core/mission-state';
import { loadArtifactRecord } from '@agent/core/artifact-record';
import type { MemoryCandidate } from '@agent/core/memory-promotion-queue';
import type { ViewerContext } from './viewer-context';

function readTenantState(missionId: string): string | undefined {
  try {
    const state = loadState(missionId);
    return state?.tenant_slug || state?.tenant_id;
  } catch {
    return undefined;
  }
}

export function resolveMemoryCandidateTenant(candidate: MemoryCandidate): string | undefined {
  const sourceRef = String(candidate.source_ref || '').trim();
  const [, rawRef = ''] = sourceRef.split(':', 2);
  if (candidate.source_type === 'artifact') {
    return loadArtifactRecord(rawRef || sourceRef)?.tenant_slug;
  }
  if (candidate.source_type === 'mission') {
    const missionId = rawRef || sourceRef;
    if (!findMissionPath(missionId)) return undefined;
    return readTenantState(missionId);
  }
  return undefined;
}

export function memoryCandidateVisibleToViewer(
  candidate: MemoryCandidate,
  viewer: ViewerContext,
  requestedTenant?: string
): boolean {
  const tierAccess = viewer.tierAccess || [];
  if (!tierAccess.includes(candidate.sensitivity_tier)) return false;
  const tenant = resolveMemoryCandidateTenant(candidate);
  const allowedTenants = requestedTenant
    ? [requestedTenant]
    : viewer.tenantSlugs === 'all'
      ? 'all'
      : viewer.tenantSlugs;
  if (allowedTenants === 'all') return true;
  return Boolean(tenant && allowedTenants.includes(tenant));
}
