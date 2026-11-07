import type { MemoryCandidate } from '@agent/core/knowledge/memory-promotion-queue';
import { assertMemoryScope } from '@agent/core/knowledge/memory-scope';
import { admitsScopeAudience, viewerPersonIds } from '@agent/core/surface/surface-authorization';
import type { ConciergeViewerContext } from './viewer-context';

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
  // Custody admission (P4): tenant rows by scope, untenanted rows by the
  // system selection, owner-bound rows to the owner — plus the record's own
  // audience grant on person custody, admitted by identity, never by scope.
  if (!admitsScopeAudience(viewer, scope)) return false;
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
  const principals = viewerPersonIds(viewer);
  const audience = scope?.allowed_audience ?? [];
  const audienceMatch = audience.some((id) => principals.includes(id));
  if (audience.length && !audienceMatch) return false;
  if (scope?.owner_nhi && !principals.includes(scope.owner_nhi) && !audienceMatch) return false;
  if (sourceTier === 'personal' && !scope?.owner_nhi && !audienceMatch) return false;
  return true;
}
