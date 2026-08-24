import { findMissionPath } from '@agent/core/path-resolver';
import { loadArtifactRecord } from '@agent/core/artifact-record';
import type { MemoryCandidate } from '@agent/core/memory-promotion-queue';
import { loadJson, safeExistsSync } from '@agent/core/secure-io';
import type { ViewerContext } from './viewer-context';

type TenantState = { tenant_slug?: string; tenant_id?: string };

function readTenantState(path: string): string | undefined {
  if (!safeExistsSync(path)) return undefined;
  try {
    const state = loadJson<TenantState>(path);
    return state.tenant_slug || state.tenant_id;
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
    const missionPath = findMissionPath(rawRef || sourceRef);
    if (!missionPath) return undefined;
    return readTenantState(`${missionPath}/mission-state.json`);
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
