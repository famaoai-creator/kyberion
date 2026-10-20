import type { MemoryCandidate } from '@agent/core/knowledge/memory-promotion-queue';
import { assertMemoryScope } from '@agent/core/knowledge/memory-scope';
import type { ConciergeViewerContext } from './viewer-context';
import { tenantVisibleToViewer } from './tenant-visibility';

/** Promotion destination tier never widens access to the source content. */
export function memoryCandidateVisibleToViewer(
  candidate: MemoryCandidate,
  viewer: ConciergeViewerContext
): boolean {
  let scope;
  try {
    scope = candidate.scope ? assertMemoryScope(candidate.scope) : undefined;
  } catch {
    return false;
  }
  const sourceTier = scope?.tier ?? candidate.sensitivity_tier;
  if (
    !viewer.tierAccess.includes(candidate.sensitivity_tier) ||
    !viewer.tierAccess.includes(sourceTier)
  )
    return false;
  if (!tenantVisibleToViewer(viewer, scope?.tenant_slug)) return false;
  if (
    viewer.organizationIds !== 'all' &&
    (!scope?.organization_id || !viewer.organizationIds.includes(scope.organization_id))
  )
    return false;
  if (
    viewer.projectIds !== 'all' &&
    (!scope?.project_id || !viewer.projectIds.includes(scope.project_id))
  )
    return false;
  const principals = [viewer.principal?.actor.id, viewer.principalId].filter(Boolean);
  const audience = scope?.allowed_audience ?? [];
  const audienceMatch = audience.some((id) => principals.includes(id));
  if (audience.length && !audienceMatch) return false;
  if (scope?.owner_nhi && !principals.includes(scope.owner_nhi) && !audienceMatch) return false;
  if (sourceTier === 'personal' && !scope?.owner_nhi && !audienceMatch) return false;
  return true;
}
