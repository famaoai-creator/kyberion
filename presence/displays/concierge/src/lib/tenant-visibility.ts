import type { ConciergeViewerContext } from './viewer-context';

/** Whether a record of `tenantSlug` (absent = company-less) is inside the selected scope. */
export function tenantVisibleToViewer(
  scope: Pick<ConciergeViewerContext, 'tenantSlugs' | 'includeUntenanted'>,
  tenantSlug: string | null | undefined
): boolean {
  if (scope.tenantSlugs === 'all') return true;
  if (!tenantSlug) return Boolean(scope.includeUntenanted);
  return scope.tenantSlugs.includes(tenantSlug);
}
