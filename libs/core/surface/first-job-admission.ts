/** Server-only diagnostic scope validation, shared by readiness and atomic reservation. */
import { findRepoDotCharter, assertFrontDeskDiagnosticDotCharter } from '../dot/dot-charter.js';
import type { FrontDeskExecutionMapping } from './front-desk-execution-contract.js';

export function isFirstJobDiagnosticMapping(
  mapping: FrontDeskExecutionMapping | undefined
): boolean {
  if (!mapping) return false;
  const viewer = mapping.viewer;
  const tenantOnly = viewer.organizationIds === 'all' && viewer.projectIds === 'all';
  if (
    viewer.source !== 'loopback' ||
    viewer.role !== 'localadmin' ||
    !viewer.principalId?.trim() ||
    viewer.tenantSlugs === 'all' ||
    viewer.tenantSlugs.length !== 1 ||
    viewer.tierAccess.length !== 1 ||
    viewer.tierAccess[0] !== 'public' ||
    (!tenantOnly &&
      [viewer.organizationIds, viewer.projectIds].some(
        (scope) => scope === 'all' || scope.length !== 1
      ))
  )
    return false;
  try {
    const charter = findRepoDotCharter(mapping.dotId)?.charter;
    if (!charter || charter.status !== 'active') return false;
    assertFrontDeskDiagnosticDotCharter(charter);
    // 'all' here represents no organization/project binding. It is accepted only
    // as a pair and must equal the charter's absent optional scope, never a wildcard.
    return (
      charter.dot_id === mapping.dotId &&
      charter.scope.tenant_slug === viewer.tenantSlugs[0] &&
      charter.scope.organization_id ===
        (viewer.organizationIds === 'all' ? undefined : viewer.organizationIds[0]) &&
      charter.scope.project_id === (viewer.projectIds === 'all' ? undefined : viewer.projectIds[0])
    );
  } catch {
    return false;
  }
}
