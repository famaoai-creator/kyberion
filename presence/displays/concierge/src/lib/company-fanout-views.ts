import type { ConciergeViewerContext } from './viewer-context';

/**
 * The per-company fan-out of the personal (all-company) view: one viewer per
 * company the viewer may select, each narrowed to exactly that tenant, plus —
 * for an all-company viewer only — the company-less (system) view. Pure; the
 * one enumeration `/api/personal-summary` and the personal needs-you queue
 * share, so the two can never read different company sets.
 *
 * Company views never carry `includeUntenanted` (a company card counts only
 * that company's records); only the system view sets it, and only for a viewer
 * whose server-resolved scope is already every tenant. Nothing here widens the
 * viewer: a company outside `viewer.tenantSlugs` is never read.
 */
export interface CompanyFanoutViews {
  companies: Array<{ tenantSlug: string; viewer: ConciergeViewerContext }>;
  system?: ConciergeViewerContext;
}

export function companyFanoutViews(
  viewer: ConciergeViewerContext,
  allowedTenants: readonly string[]
): CompanyFanoutViews {
  const base: ConciergeViewerContext = { ...viewer };
  delete base.includeUntenanted;
  const companies = allowedTenants
    .filter((slug) => viewer.tenantSlugs === 'all' || viewer.tenantSlugs.includes(slug))
    .map((tenantSlug) => ({ tenantSlug, viewer: { ...base, tenantSlugs: [tenantSlug] } }));
  if (viewer.tenantSlugs !== 'all') return { companies };
  return { companies, system: { ...base, tenantSlugs: [], includeUntenanted: true } };
}
