import type { MemoryCandidate } from '@agent/core/knowledge/memory-promotion-queue';
import { assertMemoryScope, type MemoryScopeEnvelope } from '@agent/core/knowledge/memory-scope';
import { admitsScopeAudience, viewerPersonIds } from '@agent/core/surface/surface-authorization';
import {
  strictViewerScopeTenantSlugs,
  viewerCanReadTier,
  withOpsViewerDefaults,
  type ViewerContext,
} from './ops/ops-viewer';

export interface MemoryCandidateVisibilityOptions {
  /** A tenant the request selected. It only narrows; outside the viewer's set it throws. */
  requestedTenant?: string;
  /**
   * The candidate's source scope when the caller resolved it itself (the
   * operations console derives it from the mission / artifact store for rows
   * recorded without one); `null` means unresolvable and hides the row.
   * Omitted: the scope recorded on the candidate.
   */
  sourceScope?: MemoryScopeEnvelope | null;
}

/** The scope recorded on the candidate; a row without one is system custody at its own tier. */
export function recordedMemoryCandidateScope(
  candidate: MemoryCandidate
): MemoryScopeEnvelope | null {
  try {
    return candidate.scope
      ? assertMemoryScope(candidate.scope)
      : { tier: candidate.sensitivity_tier };
  } catch {
    return null;
  }
}

/**
 * The one visibility rule for a memory candidate, for the inbox and the
 * operations console alike. Promotion destination tier never widens access
 * to the source content: the viewer must be able to read both the source
 * tier and the destination tier, and a personal-tier candidate is never
 * shown through this check — not to its owner either, because no Concierge
 * viewer holds the personal tier.
 */
export function memoryCandidateVisibleToViewer(
  candidate: MemoryCandidate,
  viewer: ViewerContext,
  options: MemoryCandidateVisibilityOptions = {}
): boolean {
  const { requestedTenant } = options;
  const tenants = strictViewerScopeTenantSlugs(viewer, requestedTenant);
  const { organizationIds, projectIds } = withOpsViewerDefaults(viewer);
  const scope =
    options.sourceScope === undefined
      ? recordedMemoryCandidateScope(candidate)
      : options.sourceScope;
  // Destination sensitivity is not authority to read the source material.
  if (
    !scope ||
    scope.tier === 'personal' ||
    candidate.sensitivity_tier === 'personal' ||
    !viewerCanReadTier(viewer, scope.tier) ||
    !viewerCanReadTier(viewer, candidate.sensitivity_tier)
  )
    return false;
  if (requestedTenant && scope.tenant_slug !== requestedTenant) return false;
  // Custody admission plus the record's own audience grant: person custody
  // stays identity-bound for every viewer, 'all' included; a listed audience
  // member is admitted by identity — never by scope.
  const principals = viewerPersonIds(viewer);
  if (
    !admitsScopeAudience(
      { tenantSlugs: tenants, includeUntenanted: viewer.includeUntenanted, personIds: principals },
      scope
    )
  )
    return false;
  if (
    organizationIds !== 'all' &&
    (!scope.organization_id || !organizationIds.includes(scope.organization_id))
  )
    return false;
  if (projectIds !== 'all' && (!scope.project_id || !projectIds.includes(scope.project_id)))
    return false;
  const audience = scope.allowed_audience ?? [];
  const audienceMatch = audience.some((id) => principals.includes(id));
  if (audience.length && !audienceMatch) return false;
  if (scope.owner_nhi && !principals.includes(scope.owner_nhi) && !audienceMatch) return false;
  return true;
}
