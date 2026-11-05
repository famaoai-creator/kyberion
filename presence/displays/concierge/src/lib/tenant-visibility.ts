import { admitsTenant } from '@agent/core/surface/surface-authorization';
import type { ConciergeViewerContext } from './viewer-context';

/**
 * Whether a record of `tenantSlug` (absent = company-less) is inside the
 * selected scope. One rule for every surface: delegates to `admitsTenant`.
 */
export function tenantVisibleToViewer(
  scope: Pick<ConciergeViewerContext, 'tenantSlugs' | 'includeUntenanted'>,
  tenantSlug: string | null | undefined
): boolean {
  return admitsTenant(scope, tenantSlug);
}
