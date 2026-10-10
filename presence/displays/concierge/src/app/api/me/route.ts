import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import { readFrontDeskMe } from '@agent/core/front-desk-identity';
import { createLogger } from '@agent/core/logger';
import { ensureOwnerMember } from '@agent/core/organization/member-registry';
import { getBrowserOnboardingState } from '@agent/core/browser/browser-onboarding';
import { conciergeAvailableOperations } from '../../../lib/headless-projections';
import { resolveConciergeSelectedViewer } from '../../../lib/selected-tenant';
import { conciergeErrorResponse } from '../../../lib/viewer-context';

const logger = createLogger('concierge-me');

/**
 * FD-01c: `GET /api/me` — the concierge half of the shared front-desk
 * identity contract (plan §2.4). Combines the server-resolved viewer scope
 * with tenant profiles and the onboarding flag into `FrontDeskMe`
 * (`libs/core/front-desk-identity.ts`), which both surfaces render
 * identically. Personal tier stays masked here exactly as it already is for
 * every other Concierge route — `resolveConciergeViewer` never grants it.
 *
 * `selection` is what the server resolved from the URL/cookie hints for this
 * request (a company, 個人, or システム); `viewing` is that company's profile,
 * or null. `switcher` lists every selectable value independently of profiles,
 * so a selected company without a profile can still be switched away from.
 */
export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const { selection, viewer, allowedTenants } = resolved;
    const allCompanies = viewer.tenantSlugs === 'all';
    const onboarding = getBrowserOnboardingState();
    const onboarded =
      (onboarding.onboarding as Record<string, unknown> | null)?.status === 'complete';
    const me = withExecutionContext('sovereign_concierge', () => {
      // FD-07: the local owner is provisioned lazily and idempotently on the
      // first loopback visit (there is no login flow to hook), so
      // member.registered becomes true without a manual ceremony. Never
      // touches token viewers.
      if (viewer.source === 'loopback') {
        try {
          ensureOwnerMember();
        } catch (error) {
          logger.error(
            `could not provision the owner member — first loopback visit | next: run onboarding again | evidence: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
      return readFrontDeskMe(viewer, {
        requestedTenant: selection.mode === 'tenant' ? selection.tenant_slug : null,
        availableOperations: conciergeAvailableOperations(viewer),
        onboarded,
      });
    });
    const viewing =
      selection.mode === 'tenant' && me.viewing?.tenant_slug === selection.tenant_slug
        ? me.viewing
        : null;
    const profileNames = new Map(me.tenants.map((t) => [t.tenant_slug, t.display_name]));
    return NextResponse.json(
      {
        ...me,
        viewing,
        selection:
          selection.mode === 'tenant'
            ? { mode: 'tenant', tenant_slug: selection.tenant_slug }
            : selection.mode === 'system'
              ? { mode: 'system' }
              : { mode: 'personal', aggregate: allCompanies || allowedTenants.length > 0 },
        switcher: {
          personal: allCompanies || allowedTenants.length > 1,
          system: allCompanies,
          companies: allowedTenants.map((slug) => ({
            tenant_slug: slug,
            display_name: profileNames.get(slug) || slug,
          })),
        },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
