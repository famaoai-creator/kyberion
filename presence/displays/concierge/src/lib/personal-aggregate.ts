import type { CeoSurfaceSummary } from '@agent/core/ceo-surface-summary';
import { companyFanoutViews } from './company-fanout-views';
import type { ConciergeViewerContext } from './viewer-context';

/**
 * Counts, one headline and the pending decisions of one scope. The decisions
 * are what the person must act on, so the personal view lists them (with
 * their tenant) instead of making the person switch company first; every
 * other item list stays behind the company switch.
 */
export interface PersonalScopeCard {
  counts: CeoSurfaceSummary['briefing']['counts'];
  /** Title of the most urgent approval, when one is waiting. */
  headline?: string;
  /** Pending approvals read through the viewer narrowed to this scope (omitted when none). */
  approvals?: CeoSurfaceSummary['approval_queue'];
}

/**
 * The personal view: one summary card per company the viewer may select,
 * plus — for an all-company viewer — one card for company-less items.
 */
export interface PersonalCompanyCard extends PersonalScopeCard {
  tenant_slug: string;
  display_name: string;
}

export interface PersonalAggregate {
  companies: PersonalCompanyCard[];
  system?: PersonalScopeCard;
}

const HEADLINE_MAX_CHARS = 120;

export interface PersonalAggregateDeps {
  /** Reads one company's (or the company-less) home, narrowed to exactly that scope. */
  readCompanyHome(viewer: ConciergeViewerContext): CeoSurfaceSummary;
  displayName(tenantSlug: string): string | null;
}

function scopeCard(home: CeoSurfaceSummary): PersonalScopeCard {
  const title = home.approval_queue[0]?.title?.trim();
  return {
    counts: { ...home.briefing.counts },
    ...(home.approval_queue.length ? { approvals: [...home.approval_queue] } : {}),
    ...(title
      ? {
          headline:
            title.length > HEADLINE_MAX_CHARS ? `${title.slice(0, HEADLINE_MAX_CHARS)}…` : title,
        }
      : {}),
  };
}

/**
 * Builds the cards from the viewer's full scope. Each company is read through a
 * viewer narrowed to that one tenant, so a card can only ever count that
 * company's items; the system card reads only items that carry no tenant.
 */
export function buildPersonalAggregate(
  viewer: ConciergeViewerContext,
  allowedTenants: readonly string[],
  deps: PersonalAggregateDeps
): PersonalAggregate {
  const views = companyFanoutViews(viewer, allowedTenants);
  const companies = views.companies.map(
    ({ tenantSlug, viewer: companyViewer }): PersonalCompanyCard => ({
      tenant_slug: tenantSlug,
      display_name: deps.displayName(tenantSlug) || tenantSlug,
      ...scopeCard(deps.readCompanyHome(companyViewer)),
    })
  );
  if (!views.system) return { companies };
  return { companies, system: scopeCard(deps.readCompanyHome(views.system)) };
}
