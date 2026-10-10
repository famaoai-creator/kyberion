import type { CeoSurfaceSummary } from '@agent/core/ceo-surface-summary';
import type { ConciergeViewerContext } from './viewer-context';

/** Counts and one headline of one scope — never its item lists. */
export interface PersonalScopeCard {
  counts: CeoSurfaceSummary['briefing']['counts'];
  /** Title of the most urgent approval, when one is waiting. */
  headline?: string;
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
  const base: ConciergeViewerContext = { ...viewer };
  delete base.includeUntenanted;
  const companies = allowedTenants
    .filter((slug) => viewer.tenantSlugs === 'all' || viewer.tenantSlugs.includes(slug))
    .map((slug): PersonalCompanyCard => ({
      tenant_slug: slug,
      display_name: deps.displayName(slug) || slug,
      ...scopeCard(deps.readCompanyHome({ ...base, tenantSlugs: [slug] })),
    }));
  if (viewer.tenantSlugs !== 'all') return { companies };
  const system = scopeCard(
    deps.readCompanyHome({ ...base, tenantSlugs: [], includeUntenanted: true })
  );
  return { companies, system };
}
